/**
 * @fileoverview Server-specific configuration: the FAOSTAT bulk-download mirror and
 * the switches that decide how tools register. Parsed lazily via `parseEnvConfig` so
 * env-var names surface in errors; never merged with the framework's core config
 * schema. Also the never-throwing reads `src/index.ts` makes before `createApp()`.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { ConfigSchema, normalizeEnv, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Default domain selection — the high-value standard-cube analytical domains. */
const DEFAULT_DOMAINS = 'QCL,TCL,FBS,FS,RL,GLE,RFN,QV';

const ServerConfigSchema = z.object({
  bulkBaseUrl: z
    .string()
    .url()
    .default('https://bulks-faostat.fao.org/production')
    .describe('FAOSTAT bulk-download service base URL (manifest + per-domain ZIPs).'),
  domains: z
    .string()
    .default(DEFAULT_DOMAINS)
    .describe(
      'Comma-separated FAOSTAT domain codes to index into the local mirror (e.g. "QCL,TCL,FBS"). Domains outside this set appear in faostat_list_domains but are not queryable until added and re-synced.',
    ),
  mirrorPath: z
    .string()
    .default('./.faostat-mirror')
    .describe(
      'Directory holding the per-domain SQLite mirror databases plus the shared dimension database. Created if absent.',
    ),
  refreshCron: z
    .string()
    .optional()
    .describe(
      'Cron expression for the in-process incremental refresh (HTTP transport only). Omit to disable scheduled refresh and run `bun run mirror:refresh` out-of-band instead. Recommended "0 6 * * *" (daily off-peak).',
    ),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Set to "true" to register faostat_dataframe_drop live; otherwise it is registered disabled, with the enable hint, and is absent from tools/list.',
    ),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Serve a count input (limit, top_n, row_limit) above its cap at the cap, with a notice. Set to "false" to advertise each cap as a schema maximum and reject a larger value instead.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** The environment variable each config field reads. */
const ENV_VARS = {
  bulkBaseUrl: 'FAOSTAT_BULK_BASE_URL',
  domains: 'FAOSTAT_DOMAINS',
  mirrorPath: 'FAOSTAT_MIRROR_PATH',
  refreshCron: 'FAOSTAT_REFRESH_CRON',
  dataframeDropEnabled: 'FAOSTAT_DATAFRAME_DROP_ENABLED',
  clampLimits: 'FAOSTAT_CLAMP_LIMITS',
} as const satisfies Record<keyof ServerConfig, string>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config. Reads env vars on first access. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, ENV_VARS);
  return _config;
}

/**
 * One boolean field read before `createApp()`, where it decides how tools register.
 * Never throws: a blank value or an unsubstituted `${…}` placeholder reads as unset,
 * as `getServerConfig()` reads it, and a value that does not parse reads as the
 * field's default here. `getServerConfig()` in `setup()` then rejects that value
 * behind the framework's startup banner — the full config is validated only there.
 */
function earlyFlag(key: 'dataframeDropEnabled' | 'clampLimits'): boolean {
  const field = ServerConfigSchema.shape[key];
  const parsed = field.safeParse(normalizeEnv(process.env)[ENV_VARS[key]]);
  return parsed.success ? parsed.data : field.parse(undefined);
}

/** Whether `faostat_dataframe_drop` registers live (`FAOSTAT_DATAFRAME_DROP_ENABLED`). */
export function dataframeDropRequested(): boolean {
  return earlyFlag('dataframeDropEnabled');
}

/**
 * Whether count inputs serve an over-cap value at the cap (`FAOSTAT_CLAMP_LIMITS`,
 * default on). Off, `src/index.ts` registers them with the cap as a schema maximum.
 */
export function clampLimitsRequested(): boolean {
  return earlyFlag('clampLimits');
}

/**
 * The DataCanvas row limit (`CANVAS_DEFAULT_ROW_LIMIT`), the most rows one
 * `faostat_dataframe_query` call can return. A core variable, read before
 * `createApp()` because the tool's `row_limit` cap and description state it. Parsed
 * by the framework's own field schema after the same normalization, so it is the
 * value the canvas enforces. Never throws: a value that does not parse reads as the
 * default here, and the framework's config parse in `createApp()` rejects it.
 */
export function canvasRowLimit(): number {
  const field = ConfigSchema.shape.canvas.shape.defaultRowLimit;
  const parsed = field.safeParse(normalizeEnv(process.env).CANVAS_DEFAULT_ROW_LIMIT);
  return parsed.success ? parsed.data : field.parse(undefined);
}

/** Parse `FAOSTAT_DOMAINS` into a normalized, de-duplicated, upper-cased code list. */
export function selectedDomainCodes(cfg: ServerConfig = getServerConfig()): string[] {
  const seen = new Set<string>();
  for (const raw of cfg.domains.split(',')) {
    const code = raw.trim().toUpperCase();
    if (code) seen.add(code);
  }
  return [...seen];
}
