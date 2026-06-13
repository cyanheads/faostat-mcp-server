/**
 * @fileoverview One-shot bootstrap of the FAOSTAT local mirror. Fetches the bulk
 * manifest, then streams each selected domain's ZIP into its SQLite store and
 * populates the shared dimension tables. Idempotent and resumable per domain —
 * the framework persists state per page, so re-running after an interrupt
 * re-streams only the unfinished domain ZIP.
 *
 * Usage:
 *   bun run mirror:init
 *
 * Env vars (see CLAUDE.md Config table):
 *   FAOSTAT_DOMAINS       domains to index (default QCL,TCL,FBS,FS,RL,GLE,RFN,QV)
 *   FAOSTAT_MIRROR_PATH   mirror directory (default ./.faostat-mirror)
 *   FAOSTAT_BULK_BASE_URL bulk base URL (default the FAO production host)
 *
 * @module scripts/faostat-mirror-init
 */

import { getServerConfig, selectedDomainCodes } from '@/config/server-config.js';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { fetchManifest, findDataset } from '@/services/faostat-mirror/manifest.js';
import { makeScriptContext } from './_mirror-context.js';

async function main(): Promise<void> {
  const cfg = getServerConfig();
  const domains = selectedDomainCodes(cfg);
  const ctx = makeScriptContext('mirror:init');
  const mirror = new FaostatMirror({ dir: cfg.mirrorPath, domains, log: ctx.log });

  ctx.log.notice('Starting FAOSTAT mirror init', { dir: cfg.mirrorPath, domains });
  const start = Date.now();

  try {
    const datasets = await fetchManifest(cfg.bulkBaseUrl, ctx.signal);
    for (const code of domains) {
      const dataset = findDataset(datasets, code);
      if (!dataset) {
        ctx.log.warning(`Domain ${code} not found in manifest — skipping`);
        continue;
      }
      const domainStart = Date.now();
      let lastReport = domainStart;
      const result = await mirror.runDomainSync(code, 'init', {
        signal: ctx.signal,
        dataset,
        onProgress: (info) => {
          const now = Date.now();
          if (now - lastReport < 10_000) return;
          lastReport = now;
          const elapsedMin = ((now - domainStart) / 60_000).toFixed(1);
          console.log(
            `  [${code}] pages=${info.pages} records=${info.records} elapsed=${elapsedMin}m`,
          );
        },
      });
      const elapsedMin = ((Date.now() - domainStart) / 60_000).toFixed(1);
      console.log(`  [${code}] done — ${result.total} rows in ${elapsedMin}m`);
    }
    const totalMin = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(`\nInit complete in ${totalMin}m across ${domains.length} domain(s).`);
    await mirror.close();
  } catch (err) {
    console.error('\nInit failed:', err instanceof Error ? err.message : err);
    await mirror.close().catch(() => {});
    process.exit(1);
  }
}

void main();
