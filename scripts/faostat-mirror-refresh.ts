/**
 * @fileoverview Incremental refresh of the FAOSTAT local mirror. For each
 * selected domain, HEAD/manifest-checks the domain's `DateUpdate` against the
 * stored checkpoint and re-streams only the domains FAO has rebuilt since the
 * last sync, or that hold no checkpoint, removing the rows a rebuilt file no
 * longer carries, then builds query-planner statistics for any domain that lacks
 * current ones. Safe to run on a schedule: an unchanged domain with current
 * statistics is left alone.
 *
 * Usage:
 *   bun run mirror:refresh
 *
 * @module scripts/faostat-mirror-refresh
 */

import { addAbortListener } from 'node:events';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { SyncResult } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig, type ServerConfig, selectedDomainCodes } from '@/config/server-config.js';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { fetchManifest, findDataset } from '@/services/faostat-mirror/manifest.js';
import type { ManifestDataset } from '@/services/faostat-mirror/types.js';
import { makeScriptContext, printFailure } from './_mirror-context.js';

const CLAIM_BUDGET_MS = 120_000;
const MAX_BACKOFF_MS = 5_000;

async function waitForRetry(waitMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortListener[Symbol.dispose]();
      resolve();
    }, waitMs);
    const abortListener = addAbortListener(signal, () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** Retry contention before a sync writes anything. A sync that acquires its lease keeps the caller's signal. */
async function refreshDomain(
  mirror: FaostatMirror,
  code: string,
  dataset: ManifestDataset,
  { signal, log }: ReturnType<typeof makeScriptContext>,
): Promise<SyncResult | undefined> {
  const deadline = performance.now() + CLAIM_BUDGET_MS;
  let backoffMs = 500;
  do {
    signal.throwIfAborted();
    try {
      return await mirror.runDomainSync(code, 'refresh', { signal, dataset });
    } catch (error) {
      signal.throwIfAborted();
      const reason = error instanceof McpError ? error.data?.reason : undefined;
      if (reason !== 'sync_locked' && reason !== 'sync_store_busy') throw error;
    }

    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    const waitMs = Math.min(backoffMs, Math.ceil(remainingMs));
    log.warning(`Domain ${code} sync is contended — waiting ${waitMs} ms to retry`);
    await waitForRetry(waitMs, signal);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  } while (performance.now() < deadline);
  return;
}

/** Runs the one-shot refresh and returns its shell exit status. */
export async function runRefresh(
  cfg: ServerConfig,
  ctx: ReturnType<typeof makeScriptContext>,
): Promise<number> {
  const domains = selectedDomainCodes(cfg);
  const mirror = new FaostatMirror({ dir: cfg.mirrorPath, domains, log: ctx.log });

  ctx.log.notice('Starting FAOSTAT mirror refresh', { domains });
  const start = Date.now();
  const skipped: string[] = [];
  let refreshed = 0;

  try {
    const datasets = await fetchManifest(cfg.bulkBaseUrl, ctx.signal);
    for (const code of domains) {
      const dataset = findDataset(datasets, code);
      if (!dataset) {
        ctx.log.warning(`Domain ${code} not found in manifest — skipping`);
        continue;
      }
      const result = await refreshDomain(mirror, code, dataset, ctx);
      if (!result) {
        skipped.push(code);
        ctx.log.warning(`Domain ${code} sync contention deadline expired — skipping`);
        continue;
      }
      refreshed++;
      console.log(
        `  [${code}] refreshed — ${result.recordsApplied} records applied, ${result.tombstonesApplied} removed`,
      );
    }
    const totalMin = ((Date.now() - start) / 60_000).toFixed(1);
    await mirror.close();
    if (skipped.length) {
      console.error(
        `\nRefreshed ${refreshed} domain(s) in ${totalMin}m. Skipped due to sync contention: ${skipped.join(', ')}.`,
      );
      return 1;
    }
    console.log(`\nRefresh complete in ${totalMin}m across ${refreshed} domain(s).`);
    return 0;
  } catch (err) {
    printFailure('Refresh', ctx.signal.aborted ? ctx.signal.reason : err);
    await mirror.close().catch(() => {});
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runRefresh(getServerConfig(), makeScriptContext('mirror:refresh'));
}
