/**
 * @fileoverview `ScheduledRefresh` — the job the HTTP transport runs on
 * `FAOSTAT_REFRESH_CRON`. Drives the real job against a fake mirror whose sync is
 * paced by deferred promises, never by timers: each domain refreshes in turn on a
 * live signal with its own deadline, a domain another process is syncing is skipped
 * while any other failure rejects the run, and `stop()` aborts a run in flight and
 * resolves only once it has settled. Two cases then run the job on a real mirror
 * store, where the mirror's own runner raises the lease conflict and the stop. The
 * entry point's wiring of the job through `setup()` and `teardown()` is covered in
 * `tests/config/startup-lifecycle.test.ts`.
 * @module tests/services/scheduled-refresh
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conflict } from '@cyanheads/mcp-ts-core/errors';
import type { SyncMode, SyncResult } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { ScheduledRefresh } from '@/services/faostat-mirror/scheduled-refresh.js';
import {
  buildDomainZip,
  FIXTURE_DOMAIN,
  fixtureDataset,
  fixtureManifestResponse,
} from '../fixtures/synthetic-domain.js';

type SyncArgs = Parameters<FaostatMirror['runDomainSync']>[2];

const RESULT: SyncResult = { pagesFetched: 1, recordsApplied: 0, tombstonesApplied: 0, total: 0 };

/** A job over `domains` whose per-domain sync is `sync`, with a log that records each level. */
function refreshOver(
  sync: (code: string, args: SyncArgs) => Promise<SyncResult>,
  domains = ['QCL', 'TCL'],
) {
  const runDomainSync = vi.fn((code: string, _mode: SyncMode, args: SyncArgs) => sync(code, args));
  const log = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
  const refresh = new ScheduledRefresh({ selectedDomains: () => domains, runDomainSync }, log);
  return { refresh, runDomainSync, log };
}

/** A promise and its resolve — paces a sync without timers. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** As the mirror's runner does: run until the signal aborts, then reject with its reason. */
function untilAborted(signal: AbortSignal): Promise<SyncResult> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Let every queued promise callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const syncLocked = () =>
  conflict('Mirror sync is already in progress in another process or instance.', {
    reason: 'sync_locked',
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ScheduledRefresh', () => {
  it('refreshes every selected domain in turn, each on a live signal', async () => {
    const seen: [string, boolean][] = [];
    const { refresh, runDomainSync } = refreshOver(
      async (code, { signal }) => {
        seen.push([code, signal.aborted]);
        return RESULT;
      },
      ['QCL', 'TCL', 'FBS'],
    );
    await expect(refresh.run()).resolves.toBeUndefined();
    expect(seen).toEqual([
      ['QCL', false],
      ['TCL', false],
      ['FBS', false],
    ]);
    expect(runDomainSync.mock.calls.map(([, mode]) => mode)).toEqual([
      'refresh',
      'refresh',
      'refresh',
    ]);
  });

  it('gives each domain its own one-hour deadline, and a run the deadline ends rejects', async () => {
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
    const started = deferred();
    const { refresh, runDomainSync, log } = refreshOver(async (code, { signal }) => {
      if (code === 'QCL') return RESULT;
      started.resolve();
      return untilAborted(signal);
    });

    const run = refresh.run();
    await started.promise;
    const expired = new DOMException('The operation timed out.', 'TimeoutError');
    deadlines[1]?.abort(expired);

    // Unlike a stop at shutdown, the scheduler reports this one as a failed run.
    await expect(run).rejects.toBe(expired);
    expect(timeout.mock.calls).toEqual([[3_600_000], [3_600_000]]);
    expect(runDomainSync.mock.calls.map(([code]) => code)).toEqual(['QCL', 'TCL']);
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each([[['QCL']], [['TCL']], [['QCL', 'TCL']]])(
    'skips each domain whose store another process is syncing and refreshes the rest: %j',
    async (locked) => {
      const refreshed: string[] = [];
      const { refresh, runDomainSync, log } = refreshOver(async (code) => {
        if (locked.includes(code)) throw syncLocked();
        refreshed.push(code);
        return RESULT;
      });
      await expect(refresh.run()).resolves.toBeUndefined();
      expect(runDomainSync.mock.calls.map(([code]) => code)).toEqual(['QCL', 'TCL']);
      expect(refreshed).toEqual(['QCL', 'TCL'].filter((code) => !locked.includes(code)));
      expect(log.info.mock.calls).toEqual(
        locked.map((code) => [
          `Skipped the scheduled refresh of ${code} — another process holds its sync lease`,
        ]),
      );
      expect(log.error).not.toHaveBeenCalled();
      expect(log.warning).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'a lease lost mid-run',
      conflict(
        'Mirror sync lost its lease to another process or instance and wrote nothing after the takeover.',
        { reason: 'sync_lease_lost' },
      ),
    ],
    [
      'an in-process sync of the domain already running',
      conflict('Domain QCL sync is already in progress.', { domain: 'QCL' }),
    ],
    ['an upstream failure', new Error('Domain QCL not found in the FAOSTAT manifest.')],
  ])('rejects the run on %s and refreshes no further domain', async (_name, error) => {
    const { refresh, runDomainSync, log } = refreshOver(() => Promise.reject(error));
    await expect(refresh.run()).rejects.toBe(error);
    expect(runDomainSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('stops a run in flight: its sync aborts, the run resolves, and stop() waits for it', async () => {
    const events: string[] = [];
    const started = deferred();
    const { refresh, runDomainSync, log } = refreshOver(async (code, { signal }) => {
      events.push(`sync ${code}`);
      started.resolve();
      try {
        return await untilAborted(signal);
      } finally {
        events.push(`sync ${code} stopped`);
      }
    });

    const run = refresh.run().then(() => events.push('run resolved'));
    await started.promise;
    await refresh.stop();
    events.push('stop resolved');
    await run;

    expect(events).toEqual(['sync QCL', 'sync QCL stopped', 'run resolved', 'stop resolved']);
    expect(runDomainSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('waits out a domain sync that is slow to settle after the abort, then starts no other', async () => {
    const started = deferred();
    const slow = deferred();
    const { refresh, runDomainSync } = refreshOver(async () => {
      started.resolve();
      await slow.promise; // settles on its own schedule, not the signal's
      return RESULT;
    });

    const run = refresh.run();
    await started.promise;
    let stopped = false;
    const stopping = refresh.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    slow.resolve();
    await stopping;
    await expect(run).resolves.toBeUndefined();
    expect(runDomainSync.mock.calls.map(([code]) => code)).toEqual(['QCL']);
  });

  it('stops with no run in flight, stops again, and syncs nothing afterwards', async () => {
    const { refresh, runDomainSync } = refreshOver(async () => RESULT);
    await refresh.run();
    expect(runDomainSync).toHaveBeenCalledTimes(2);

    await expect(refresh.stop()).resolves.toBeUndefined();
    await expect(refresh.stop()).resolves.toBeUndefined();
    await expect(refresh.run()).resolves.toBeUndefined();
    expect(runDomainSync).toHaveBeenCalledTimes(2);
  });
});

describe('ScheduledRefresh on a real mirror store', () => {
  let dir: string;
  const opened: FaostatMirror[] = [];
  /** Resolves when the domain ZIP is first requested — the sync holds its lease by then. */
  let zipRequested: ReturnType<typeof deferred<void>>;
  /** Holds the ZIP body after its first chunk until resolved, or until the request aborts. */
  let zipGate: ReturnType<typeof deferred<void>>;

  /** A mirror on `dir` whose log records every level, closed after the test. */
  function openMirror() {
    const log = { info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const mirror = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN], log });
    opened.push(mirror);
    return { mirror, log };
  }

  /** The fixture ZIP as a body that stalls after its first chunk and errors when `signal` aborts. */
  function heldZip(signal: AbortSignal | undefined): Response {
    const bytes = buildDomainZip();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes.slice(0, 64));
          return;
        }
        await zipGate.promise;
        controller.enqueue(bytes.slice(64));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'last-modified': 'Wed, 31 Dec 2025 00:00:00 GMT' },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-scheduled-refresh-'));
    zipRequested = deferred();
    zipGate = deferred();
    // Every request is answered here; anything but the two fixture routes fails the test.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('datasets_E.json')) return Response.json(fixtureManifestResponse());
        if (url === fixtureDataset().FileLocation) {
          zipRequested.resolve();
          return heldZip(init?.signal ?? undefined);
        }
        throw new Error(`Unexpected request in test: ${url}`);
      }),
    );
  });

  afterEach(async () => {
    zipGate.resolve();
    for (const mirror of opened.splice(0)) await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a domain whose store another instance is syncing, with nothing logged at error', async () => {
    const holder = openMirror();
    const holding = holder.mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
    await zipRequested.promise;

    const { mirror, log } = openMirror();
    await expect(new ScheduledRefresh(mirror, log).run()).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      `Skipped the scheduled refresh of ${FIXTURE_DOMAIN} — another process holds its sync lease`,
    );
    expect(log.error).not.toHaveBeenCalled();

    zipGate.resolve();
    expect((await holding).recordsApplied).toBeGreaterThan(0);
  }, 30_000);

  it('stops a refresh mid-download: the run resolves and the runner logs the stop at info, not error', async () => {
    const { mirror, log } = openMirror();
    const refresh = new ScheduledRefresh(mirror, log);
    const run = refresh.run();
    await zipRequested.promise;

    await refresh.stop();
    await expect(run).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith('Mirror sync stopped', expect.anything());
    expect(log.error).not.toHaveBeenCalled();
    // Recorded resumable, as a stopped run is: the next refresh continues it.
    expect(await mirror.status(FIXTURE_DOMAIN)).toMatchObject({ status: 'error', ready: false });
  }, 30_000);

  it('stops a refresh waiting on its statistics build: stop() resolves while the build runs on', async () => {
    zipGate.resolve(); // the ZIP arrives whole, so the sync commits and its build starts
    const { mirror, log } = openMirror();
    const buildStarted = deferred();
    const build = deferred<number>();
    vi.spyOn(mirror.reads, 'analyze').mockImplementation(() => {
      buildStarted.resolve();
      return build.promise;
    });
    const refresh = new ScheduledRefresh(mirror, log);
    const run = refresh.run();
    await buildStarted.promise;

    let stopped = false;
    const stopping = refresh.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(true);
    await stopping;
    await expect(run).resolves.toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
    expect(await mirror.status(FIXTURE_DOMAIN)).toMatchObject({ status: 'complete', ready: true });
    build.resolve(1);
  }, 30_000);
});
