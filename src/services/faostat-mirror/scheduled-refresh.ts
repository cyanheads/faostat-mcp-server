/**
 * @fileoverview `ScheduledRefresh` — the in-process incremental refresh the entry
 * point registers on `FAOSTAT_REFRESH_CRON` (HTTP transport only). A run refreshes
 * every selected domain in turn, each under a signal the server owns combined with
 * a per-domain deadline, so `teardown()` can stop a run in flight and wait for it to
 * settle before the mirror closes its handles.
 * @module services/faostat-mirror/scheduled-refresh
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import type { FaostatMirror } from './faostat-mirror.js';

/** Time budget for one domain's refresh; a refresh cut short resumes from its cursor on the next run. */
const DOMAIN_REFRESH_BUDGET_MS = 3_600_000;

/** The slice of {@link FaostatMirror} a refresh drives. */
type RefreshTarget = Pick<FaostatMirror, 'runDomainSync' | 'selectedDomains'>;

/**
 * The scheduled refresh job: {@link run} is the cron task, {@link stop} the shutdown
 * hook. The scheduler skips a tick while a run is in flight, so at most one exists.
 */
export class ScheduledRefresh {
  private readonly mirror: RefreshTarget;
  private readonly log: MirrorLogger;
  /** Aborted by {@link stop}; every domain sync a run starts takes its signal. */
  private readonly shutdown = new AbortController();
  /** The run in flight, until it settles. */
  private running: Promise<void> | undefined;

  constructor(mirror: RefreshTarget, log: MirrorLogger) {
    this.mirror = mirror;
    this.log = log;
  }

  /**
   * Refresh each selected domain in turn. A domain whose store another process is
   * syncing (`sync_locked`) is skipped and the run moves on; any other failure
   * rejects the run, which the scheduler logs at `error`. A run that {@link stop} ends
   * resolves — the mirror's runner has already logged `Mirror sync stopped` at
   * `info` for a sync it cut short, and one stopped while waiting on its statistics
   * build had completed — and once stopped, a run returns without syncing anything.
   */
  run(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    const run = this.refreshDomains().finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  /**
   * Abort the run in flight and resolve once it has settled. A domain past its sync
   * and into its planner-statistics build stops waiting for it at once, leaving the
   * build to the mirror's `close()`. Safe to call again.
   */
  async stop(): Promise<void> {
    this.shutdown.abort();
    // The scheduler awaiting the run reports how it ended; stopping only waits for it.
    if (this.running) await Promise.allSettled([this.running]);
  }

  private async refreshDomains(): Promise<void> {
    const { signal } = this.shutdown;
    for (const code of this.mirror.selectedDomains()) {
      if (signal.aborted) return;
      try {
        await this.mirror.runDomainSync(code, 'refresh', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(DOMAIN_REFRESH_BUDGET_MS)]),
        });
      } catch (err) {
        if (signal.aborted) return;
        if (!(err instanceof McpError && err.data?.reason === 'sync_locked')) throw err;
        this.log.info?.(
          `Skipped the scheduled refresh of ${code} — another process holds its sync lease`,
        );
      }
    }
  }
}
