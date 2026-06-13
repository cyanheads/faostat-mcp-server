/**
 * @fileoverview Report the local FAOSTAT mirror state — per-domain sync status,
 * row counts, checkpoints, and whether the shared dimension tables are
 * populated. Read-only; an operability check after init/refresh.
 *
 * Usage:
 *   bun run mirror:verify
 *
 * @module scripts/faostat-mirror-verify
 */

import { getServerConfig, selectedDomainCodes } from '@/config/server-config.js';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { makeScriptContext } from './_mirror-context.js';

async function main(): Promise<void> {
  const cfg = getServerConfig();
  const domains = selectedDomainCodes(cfg);
  const ctx = makeScriptContext('mirror:verify');
  const mirror = new FaostatMirror({ dir: cfg.mirrorPath, domains, log: ctx.log });

  try {
    const dimsPopulated = await mirror.dimensions.isPopulated();
    const flags = await mirror.dimensions.listFlags();
    console.log(`Mirror directory: ${cfg.mirrorPath}`);
    console.log(
      `Dimension tables populated: ${dimsPopulated ? 'yes' : 'no'} (${flags.length} flags)`,
    );
    console.log(`\nDomains (${domains.length}):`);
    for (const code of domains) {
      const status = await mirror.status(code);
      if (!status) {
        console.log(`  [${code}] not selected`);
        continue;
      }
      console.log(
        `  [${code}] status=${status.status} ready=${status.ready} rows=${status.total ?? 0} ` +
          `checkpoint=${status.checkpoint ?? '—'} completedAt=${status.completedAt ?? '—'}` +
          (status.error ? ` error=${status.error}` : ''),
      );
    }
    await mirror.close();
  } catch (err) {
    console.error('Verify failed:', err instanceof Error ? err.message : err);
    await mirror.close().catch(() => {});
    process.exit(1);
  }
}

void main();
