/**
 * @fileoverview Incremental refresh of the FAOSTAT local mirror. For each
 * selected domain, HEAD/manifest-checks the domain's `DateUpdate` against the
 * stored checkpoint and re-streams only the domains FAO has rebuilt since the
 * last sync. Safe to run on a schedule; a no-op when nothing changed.
 *
 * Usage:
 *   bun run mirror:refresh
 *
 * @module scripts/faostat-mirror-refresh
 */

import { getServerConfig, selectedDomainCodes } from '@/config/server-config.js';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { fetchManifest, findDataset } from '@/services/faostat-mirror/manifest.js';
import { makeScriptContext } from './_mirror-context.js';

async function main(): Promise<void> {
  const cfg = getServerConfig();
  const domains = selectedDomainCodes(cfg);
  const ctx = makeScriptContext('mirror:refresh');
  const mirror = new FaostatMirror({ dir: cfg.mirrorPath, domains, log: ctx.log });

  ctx.log.notice('Starting FAOSTAT mirror refresh', { domains });
  const start = Date.now();

  try {
    const datasets = await fetchManifest(cfg.bulkBaseUrl, ctx.signal);
    for (const code of domains) {
      const dataset = findDataset(datasets, code);
      if (!dataset) {
        ctx.log.warning(`Domain ${code} not found in manifest — skipping`);
        continue;
      }
      const result = await mirror.runDomainSync(code, 'refresh', { signal: ctx.signal, dataset });
      console.log(`  [${code}] refreshed — ${result.recordsApplied} records applied`);
    }
    const totalMin = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(`\nRefresh complete in ${totalMin}m across ${domains.length} domain(s).`);
    await mirror.close();
  } catch (err) {
    console.error('\nRefresh failed:', err instanceof Error ? err.message : err);
    await mirror.close().catch(() => {});
    process.exit(1);
  }
}

void main();
