#!/usr/bin/env node
/**
 * @fileoverview faostat-mcp-server entry point. Wires the FAOSTAT bulk-download
 * mirror service + the DataCanvas accessor in `setup()`, registers the seven
 * tools (`faostat_dataframe_drop` disabled unless FAOSTAT_DATAFRAME_DROP_ENABLED
 * is on; count inputs strict when FAOSTAT_CLAMP_LIMITS is off;
 * `faostat_dataframe_query` capped at CANVAS_DEFAULT_ROW_LIMIT), and (on HTTP
 * transport) schedules the incremental mirror refresh.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import {
  logger,
  requestContextService,
  runtimeCaps,
  schedulerService,
} from '@cyanheads/mcp-ts-core/utils';
import {
  canvasRowLimit,
  clampLimitsRequested,
  dataframeDropRequested,
  getServerConfig,
  selectedDomainCodes,
} from '@/config/server-config.js';
import { withStrictCountInputs } from '@/mcp-server/tools/count-input.js';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropRegistration } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryRegistration } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { listDomainsTool } from '@/mcp-server/tools/definitions/list-domains.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import { ScheduledRefresh } from '@/services/faostat-mirror/scheduled-refresh.js';

/**
 * The canvas default, the drop and clamp switches, and the canvas row limit below
 * read the environment before createApp(), so load ./.env here rather than depend on
 * when the framework's own load runs. Variables already set keep their values, as in
 * the framework's load.
 */
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

// DataCanvas runs on DuckDB unless CANVAS_PROVIDER_TYPE=none disables it.
process.env.CANVAS_PROVIDER_TYPE = normalizeEnv(process.env).CANVAS_PROVIDER_TYPE ?? 'duckdb';

// Read before createApp(): it decides how the drop tool registers and whether the
// instructions name it. The full config is validated in setup(), where a bad value
// fails behind the framework's startup banner.
const dataframeDropEnabled = dataframeDropRequested();
// Off (FAOSTAT_CLAMP_LIMITS=false), every count input registers with its cap as a
// schema maximum and rejects a larger value; on, the handler serves it at the cap.
const clampLimits = clampLimitsRequested();
// The canvas refuses a row limit above CANVAS_DEFAULT_ROW_LIMIT, so that is the cap
// faostat_dataframe_query serves row_limit at and states in tools/list.
const rowLimitCap = canvasRowLimit();

/**
 * Adapts the framework logger to the mirror's duck-typed `MirrorLogger`. Sync
 * runs outside any request and `RequestContext` is closed, so the per-line
 * metadata the mirror emits rides in `extra` on a synthetic operation context
 * rather than as loose top-level keys.
 */
const mirrorContext = (meta?: Readonly<Record<string, unknown>>) =>
  requestContextService.createRequestContext({
    operation: 'faostatMirrorSync',
    ...(meta ? { additionalContext: meta } : {}),
  });

const mirrorLogger: MirrorLogger = {
  debug: (message, meta) => logger.debug(message, mirrorContext(meta)),
  info: (message, meta) => logger.info(message, mirrorContext(meta)),
  notice: (message, meta) => logger.notice(message, mirrorContext(meta)),
  warning: (message, meta) => logger.warning(message, mirrorContext(meta)),
  error: (message, meta) => logger.error(message, mirrorContext(meta)),
};

/** The mirror constructed in `setup()`, held so `teardown()` can close its SQLite handles. */
let mirror: FaostatMirror | undefined;
/** The refresh `setup()` schedules on HTTP, held so `teardown()` can stop a run in flight. */
let refresh: ScheduledRefresh | undefined;

await createApp({
  name: 'faostat-mcp-server',
  title: 'faostat-mcp-server',
  // Every tool is read-only and non-interactive — no handler calls ctx.requestInput,
  // so the per-session state a stateful server keeps buys nothing. Declared here
  // rather than left to a deployment's MCP_SESSION_MODE, which still wins when it
  // carries a meaningful value. No `require: 'stateful'`: nothing here needs it.
  sessionMode: 'stateless',
  skills: 'skills',
  tools: [
    listDomainsTool,
    resolveCodesTool,
    queryObservationsTool,
    commodityProfileTool,
    dataframeQueryRegistration(rowLimitCap),
    dataframeDescribeTool,
    dataframeDropRegistration(dataframeDropEnabled),
  ].map((definition) => (clampLimits ? definition : withStrictCountInputs(definition))),
  // A disabled tool is absent from tools/list, so the drop sentence rides only
  // when the tool is callable.
  instructions: `Global food & agriculture statistics from the UN FAOSTAT bulk-download corpus, served from a local SQLite mirror. Workflow: faostat_list_domains to find a domain code → faostat_resolve_codes to resolve commodity/country/metric identities → faostat_query_observations for the data. Numeric items use item_codes; alphanumeric items use exact code_text values in item_codes_text. Aggregate areas are excluded by default unless area_codes are explicit or include_aggregates=true. Item groups can still overlap their members; a null item kind does not establish that items are safe to sum. Keep elements, units, reporting periods, and source estimates separate. Period rows use their midpoint as year for filtering; value_qualifier marks a bound rather than an exact value. faostat_query_observations returns up to limit rows from offset; pass nextOffset back as offset for the next page. With DataCanvas on, a first page whose match exceeds limit also stages the whole match to a canvas table, as faostat_commodity_profile does with an observation set too large to inline; discover a staged table's columns with faostat_dataframe_describe, then query it with faostat_dataframe_query.${dataframeDropEnabled ? ' faostat_dataframe_drop removes a staged table before its 2-hour TTL once an analysis with it is finished.' : ''} faostat_commodity_profile bundles producers + trend + trade for one QCL commodity. Honor every observation's data-quality flag: commonly A=Official, B=time-series break, E=Estimated, I=Imputed, M=Missing, T=Unofficial, X=from an international organization, with others defined per domain. Never assume an unrecognized flag means official.`,
  setup(core) {
    const cfg = getServerConfig();
    const domains = selectedDomainCodes(cfg);

    // Mirror + canvas are Node/Bun-only (SQLite + DuckDB). On a Worker-like
    // runtime neither is constructed; the read tools surface index_not_ready and
    // the dataframe tools canvas_disabled rather than crashing.
    setCanvas(core.canvas);
    mirror = initFaostatMirror({ dir: cfg.mirrorPath, domains, log: mirrorLogger });

    // Incremental refresh runs in-process on HTTP transport only; stdio
    // operators run `bun run mirror:refresh` out-of-band. Initial sync is never
    // started here — a full init can take a long time and must not block startup.
    if (cfg.refreshCron && runtimeCaps.isNode && core.config.mcpTransportType === 'http') {
      const job = new ScheduledRefresh(mirror, mirrorLogger);
      refresh = job;
      void schedulerService
        .schedule(
          'faostat-mirror-refresh',
          cfg.refreshCron,
          () => job.run(),
          'Incremental refresh of the FAOSTAT domain mirrors',
        )
        .then(() => schedulerService.start('faostat-mirror-refresh'))
        .catch((err: unknown) =>
          logger.error(
            'Failed to schedule FAOSTAT mirror refresh',
            err instanceof Error ? err : new Error(String(err)),
          ),
        );
    }
  },

  /**
   * Counterpart to `setup()`. First stops a scheduled refresh in flight and waits
   * for it to settle, so no sync is writing when the handles close: the framework's
   * `schedulerService.destroyAll()` runs only after this hook and stops future ticks,
   * not a running one, and a tick that fires meanwhile syncs nothing. Then
   * `mirror.close()` shuts down the read-worker pool — rejecting queued and running
   * jobs, and closing idle workers and their handles — and closes the SQLite handle
   * per selected domain plus the shared dimension database, opened lazily on the
   * read path and held until closed. Nothing else calls `close()`, so without this
   * the files stay open until the process dies. A second call does nothing.
   */
  async teardown() {
    await refresh?.stop();
    refresh = undefined;
    await mirror?.close();
    mirror = undefined;
  },
});
