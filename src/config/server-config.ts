/**
 * @fileoverview Server-specific configuration for the FAOSTAT bulk-download
 * mirror. Parsed lazily via `parseEnvConfig` so env-var names surface in errors;
 * never merged with the framework's core config schema.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

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
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config. Reads env vars on first access. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    bulkBaseUrl: 'FAOSTAT_BULK_BASE_URL',
    domains: 'FAOSTAT_DOMAINS',
    mirrorPath: 'FAOSTAT_MIRROR_PATH',
    refreshCron: 'FAOSTAT_REFRESH_CRON',
  });
  return _config;
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
