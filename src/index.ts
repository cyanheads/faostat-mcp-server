#!/usr/bin/env node
/**
 * @fileoverview faostat-mcp-server entry point. Wires the FAOSTAT bulk-download
 * mirror service + the DataCanvas accessor in `setup()`, registers the six tools,
 * and (on HTTP transport) schedules the incremental mirror refresh.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import {
  logger,
  requestContextService,
  runtimeCaps,
  schedulerService,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, selectedDomainCodes } from '@/config/server-config.js';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { listDomainsTool } from '@/mcp-server/tools/definitions/list-domains.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';

// DuckDB is the only canvas engine and ships as a direct dependency, so enable
// the canvas by default. Set CANVAS_PROVIDER_TYPE=none to turn it off (e.g. on a
// memory-constrained deployment); the analytical tools then degrade to inline-
// only and refuse to stage large result sets with a clear canvas_disabled error.
process.env.CANVAS_PROVIDER_TYPE ??= 'duckdb';

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

await createApp({
  name: 'faostat-mcp-server',
  title: 'faostat-mcp-server',
  // Every tool is read-only and non-interactive — no handler calls ctx.requestInput,
  // so the per-session state a stateful server keeps buys nothing. Declared here
  // rather than left to a deployment's MCP_SESSION_MODE, which still wins when it
  // carries a meaningful value. No `require: 'stateful'`: nothing here needs it.
  sessionMode: 'stateless',
  tools: [
    listDomainsTool,
    resolveCodesTool,
    queryObservationsTool,
    commodityProfileTool,
    dataframeQueryTool,
    dataframeDescribeTool,
  ],
  instructions:
    'Global food & agriculture statistics from the UN FAOSTAT bulk-download corpus, served from a local SQLite mirror (the public REST API is auth-gated). Workflow: faostat_list_domains to find a domain code → faostat_resolve_codes to turn commodity/country/metric names into the integer codes the cube needs → faostat_query_observations for the data. Aggregate regions (World, continents) are excluded by default so sums are not double-counted — set include_aggregates=true for roll-ups. Large results spill to a DataCanvas table; query it with faostat_dataframe_query (discover table/column names via faostat_dataframe_describe). faostat_commodity_profile bundles producers + trend + trade for one commodity in a single call. Every observation carries a data-quality flag — commonly A=Official, B=time-series break, E=Estimated, I=Imputed, M=Missing (value cannot exist), T=Unofficial, X=from an international organization, plus others FAOSTAT defines per domain — honor it, and treat any unrecognized flag as informational (never assume official).',
  setup(core) {
    const cfg = getServerConfig();
    const domains = selectedDomainCodes(cfg);

    // Mirror + canvas are Node/Bun-only (SQLite + DuckDB). On a Worker-like
    // runtime neither is constructed; the read tools surface index_not_ready /
    // canvas_disabled rather than crashing.
    setCanvas(core.canvas);
    mirror = initFaostatMirror({ dir: cfg.mirrorPath, domains, log: mirrorLogger });

    // Incremental refresh runs in-process on HTTP transport only; stdio
    // operators run `bun run mirror:refresh` out-of-band. Initial sync is never
    // started here — a full init can take a long time and must not block startup.
    if (cfg.refreshCron && runtimeCaps.isNode && core.config.mcpTransportType === 'http') {
      void schedulerService
        .schedule(
          'faostat-mirror-refresh',
          cfg.refreshCron,
          async () => {
            const { getFaostatMirror } = await import('@/services/faostat-mirror/index.js');
            const service = getFaostatMirror();
            for (const code of service.selectedDomains()) {
              await service.runDomainSync(code, 'refresh', {
                signal: AbortSignal.timeout(3_600_000),
              });
            }
          },
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
   * Counterpart to `setup()`. `mirror.close()` first shuts down the read-worker
   * pool — rejecting queued and running reads, and closing idle workers and their
   * handles — then closes the SQLite handle per selected domain plus the shared
   * dimension database, opened lazily on the read path and held until closed.
   * Nothing else calls `close()`, so without this the files stay open until the
   * process dies. The framework already stops the refresh cron via
   * `schedulerService.destroyAll()`.
   */
  async teardown() {
    await mirror?.close();
    mirror = undefined;
  },
});
