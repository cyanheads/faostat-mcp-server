/**
 * @fileoverview One-shot refresh behavior under sync contention and permanent failures.
 * @module tests/scripts/mirror-refresh.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conflict, databaseError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { runRefresh } from '../../scripts/faostat-mirror-refresh.js';
import { fixtureDataset } from '../fixtures/synthetic-domain.js';

let mirrorPath: string;

beforeEach(() => {
  mirrorPath = mkdtempSync(join(tmpdir(), 'faostat-refresh-'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        Datasets: { Dataset: ['QCL', 'TCL', 'FS'].map((code) => fixtureDataset(code)) },
      }),
    ),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(mirrorPath, { recursive: true, force: true });
});

function run(signal: AbortSignal = new AbortController().signal) {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
  const status = runRefresh(
    {
      bulkBaseUrl: 'https://example.test',
      domains: 'QCL,TCL,FS',
      mirrorPath,
      dataframeDropEnabled: false,
      clampLimits: true,
    },
    { signal, log },
  );
  return { status, log };
}

it.each([
  new Error('disk full'),
  conflict('the sync lost its lease', { reason: 'sync_lease_lost' }),
])('fails immediately on an unrelated domain failure and reports its message', async (error) => {
  const sync = vi.spyOn(FaostatMirror.prototype, 'runDomainSync').mockRejectedValue(error);

  expect(await run().status).toBe(1);
  expect(sync.mock.calls.map(([code]) => code)).toEqual(['QCL']);
  expect(console.error).toHaveBeenCalledWith('\nRefresh failed:', error.message);
});

const locked = () => conflict('The lease is held', { reason: 'sync_locked' });
const emptySync = {
  mode: 'refresh' as const,
  pagesFetched: 0,
  recordsApplied: 0,
  tombstonesApplied: 0,
  total: 0,
};

it('retries a refused claim repeatedly before refreshing later domains', async () => {
  vi.useFakeTimers();
  const sync = vi
    .spyOn(FaostatMirror.prototype, 'runDomainSync')
    .mockRejectedValueOnce(locked())
    .mockRejectedValueOnce(conflict('The store is busy', { reason: 'sync_store_busy' }))
    .mockResolvedValue(emptySync);
  const { status, log } = run();

  await vi.runAllTimersAsync();
  expect(await status).toBe(0);
  expect(sync.mock.calls.map(([code]) => code)).toEqual(['QCL', 'QCL', 'QCL', 'TCL', 'FS']);
  expect(log.warning).toHaveBeenCalledTimes(2);
  expect(log.warning.mock.calls.every(([message]) => message.includes('QCL'))).toBe(true);
});

it('continues after exhausting the contention budget and names every skipped domain', async () => {
  vi.useFakeTimers();
  const sync = vi
    .spyOn(FaostatMirror.prototype, 'runDomainSync')
    .mockImplementation(async (code) => {
      if (code !== 'FS') throw locked();
      return emptySync;
    });
  const { status } = run();

  await vi.runAllTimersAsync();
  expect(await status).toBe(1);
  expect(sync.mock.calls.filter(([code]) => code === 'QCL').length).toBeGreaterThan(2);
  expect(sync.mock.calls.filter(([code]) => code === 'TCL').length).toBeGreaterThan(2);
  expect(sync.mock.calls.at(-1)?.[0]).toBe('FS');
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/skipped.*QCL, TCL/i));
});

it('cancels during backoff without retrying or skipping the contended domain', async () => {
  vi.useFakeTimers();
  const sync = vi.spyOn(FaostatMirror.prototype, 'runDomainSync').mockRejectedValue(locked());
  const shutdown = new AbortController();
  const { status, log } = run(shutdown.signal);

  await vi.advanceTimersByTimeAsync(1);
  expect(log.warning).toHaveBeenCalledOnce();
  shutdown.abort(new Error('operator interrupted refresh'));
  await vi.runAllTimersAsync();
  expect(await status).toBe(1);
  expect(sync.mock.calls.map(([code]) => code)).toEqual(['QCL']);
  expect(console.error).toHaveBeenCalledWith('\nRefresh failed:', 'operator interrupted refresh');
});

it.each(['SQLITE_BUSY', 'SQLITE_BUSY_RECOVERY', 'SQLITE_READONLY'])(
  'only classifies a retryable pre-claim SQLite open error (%s)',
  async (code) => {
    const mirror = new FaostatMirror({ dir: mirrorPath, domains: ['QCL'] });
    const nativeFailure = Object.assign(new Error('database error'), { code });
    const failure = databaseError('Store initialization failed', undefined, {
      cause: nativeFailure,
    });

    try {
      vi.spyOn(mirror.getMirror('QCL')!, 'raw').mockRejectedValue(failure);
      const sync = mirror.runDomainSync('QCL', 'refresh', {
        signal: new AbortController().signal,
        dataset: fixtureDataset('QCL'),
      });
      if (code === 'SQLITE_READONLY') {
        await expect(sync).rejects.toBe(failure);
      } else {
        await expect(sync).rejects.toMatchObject({
          data: { reason: 'sync_store_busy' },
          cause: failure,
        });
      }
    } finally {
      await mirror.close();
    }
  },
);
