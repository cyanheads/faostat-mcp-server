/**
 * @fileoverview Status classification for the per-domain ZIP download (#28). The
 * ingester is never retried, but a refused download used to read as an outage
 * (`ServiceUnavailable`) whatever the host answered. The sync now fails with the
 * status-mapped code, names the domain in the message, and keeps the ZIP URL on
 * `error.data` (the error reaches only the sync logs). Only `fetch` is stubbed —
 * the sync runs through the real `FaostatMirror` and framework mirror runner.
 * @module tests/services/ingester-status
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { FIXTURE_DOMAIN, fixtureDataset } from '../fixtures/synthetic-domain.js';

/** The ZIP URL the fixture manifest entry lists. */
const ZIP_URL = fixtureDataset().FileLocation;

describe('domain ZIP download status classification (#28)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-zip-status-'));
    mirror = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
  });

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Sync the fixture domain against a host answering `status`; returns the failure. */
  async function syncAgainst(status: number) {
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      const response = new Response(`status ${status}`, { status });
      // A fetched Response carries the URL it came from; a constructed one does not.
      Object.defineProperty(response, 'url', { value: ZIP_URL });
      return response;
    });
    vi.stubGlobal('fetch', fetchSpy);
    const error = await mirror
      .runDomainSync(FIXTURE_DOMAIN, 'init', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(),
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    return { error, calls: fetchSpy.mock.calls.length };
  }

  it.each([
    { status: 403, code: JsonRpcErrorCode.Forbidden },
    { status: 404, code: JsonRpcErrorCode.NotFound },
    { status: 429, code: JsonRpcErrorCode.RateLimited },
    { status: 503, code: JsonRpcErrorCode.ServiceUnavailable },
    { status: 504, code: JsonRpcErrorCode.Timeout },
  ])(
    'fails the sync on HTTP $status with the status-mapped code after one request',
    async ({ status, code }) => {
      const { error, calls } = await syncAgainst(status);

      expect(calls).toBe(1);
      expect(error).toBeInstanceOf(McpError);
      const failure = error as McpError;
      expect(failure.code).toBe(code);
      expect(failure.message).toContain(`${FIXTURE_DOMAIN} ZIP`);
      expect(failure.message).toContain(`HTTP ${status}`);
      expect(failure.data).toMatchObject({ status, url: ZIP_URL });
    },
  );

  it('leaves the domain unsynced when its ZIP is refused', async () => {
    await syncAgainst(403);

    expect(await mirror.ready(FIXTURE_DOMAIN)).toBe(false);
  });

  it('fetches the manifest from the configured FAOSTAT_BULK_BASE_URL when no dataset is passed', async () => {
    // The in-process refresh passes no dataset, so the sync resolves it from the
    // manifest — at the base the parsed server config holds, which is the setting
    // a refused manifest's recovery hint names.
    vi.stubEnv('FAOSTAT_BULK_BASE_URL', 'https://bulk.example.test/faostat');
    const fetchSpy = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response('denied', { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const error = await mirror
        .runDomainSync(FIXTURE_DOMAIN, 'refresh', { signal: new AbortController().signal })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        'https://bulk.example.test/faostat/datasets_E.json',
      );
      expect((error as McpError).code).toBe(JsonRpcErrorCode.Forbidden);
      expect(
        ((error as McpError).data as { recovery?: { hint?: string } }).recovery?.hint,
      ).toContain('FAOSTAT_BULK_BASE_URL');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
