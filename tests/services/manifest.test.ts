/**
 * @fileoverview Tests for the manifest fetch and its field parsers. The live bulk
 * manifest emits `FileRows` as a JSON number and `FileSize` as a units string; an
 * earlier `.trim()` on `FileRows` crashed `faostat_list_domains` on every real
 * call (the field was typed `string`). These cover both the real number shape and
 * the legacy quoted-string shape so the boundary parse stays robust.
 *
 * The status suite pins how a non-2xx manifest response is classified (#28): the
 * HTTP status maps to its error code, only transient statuses re-enter the real
 * `withRetry` backoff (only `fetch` is stubbed, timers are faked), and a failure
 * that will not be retried points the operator at `FAOSTAT_BULK_BASE_URL`.
 * @module tests/services/manifest
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAOSTAT_USER_AGENT } from '@/services/faostat-mirror/http.js';
import {
  fetchManifest,
  findDataset,
  parseFileRows,
  parseFileSizeBytes,
} from '@/services/faostat-mirror/manifest.js';
import type { ManifestDataset } from '@/services/faostat-mirror/types.js';
import { fixtureManifestResponse } from '../fixtures/synthetic-domain.js';

const BASE_URL = 'https://bulks-faostat.fao.org/wrong-prefix';

/** A bare non-2xx response the way the bulk host sends one. */
function statusResponse(status: number): Response {
  return new Response(`status ${status}`, { status });
}

/**
 * Run `fetchManifest` against a `fetch` stub that answers each call with the next
 * response from `responses` (the last one repeats), draining `withRetry`'s real
 * backoff under fake timers. Returns the settled outcome plus every request made.
 */
async function fetchWith(responses: (() => Response)[]) {
  const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    const next = responses[Math.min(fetchSpy.mock.calls.length - 1, responses.length - 1)];
    if (!next) throw new Error('no stubbed response');
    return next();
  });
  vi.stubGlobal('fetch', fetchSpy);
  const settled = fetchManifest(BASE_URL, new AbortController().signal).then(
    (datasets) => ({ datasets, error: undefined }),
    (error: unknown) => ({ datasets: undefined, error }),
  );
  await vi.runAllTimersAsync();
  return { ...(await settled), calls: fetchSpy.mock.calls };
}

describe('fetchManifest status classification (#28)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { status: 400, code: JsonRpcErrorCode.InvalidParams },
    { status: 403, code: JsonRpcErrorCode.Forbidden },
    { status: 404, code: JsonRpcErrorCode.NotFound },
    { status: 410, code: JsonRpcErrorCode.InvalidRequest },
    { status: 501, code: JsonRpcErrorCode.ServiceUnavailable },
  ])(
    'fails HTTP $status after exactly one request, naming FAOSTAT_BULK_BASE_URL in the recovery hint',
    async ({ status, code }) => {
      const { error, calls } = await fetchWith([() => statusResponse(status)]);

      expect(calls).toHaveLength(1);
      expect(error).toBeInstanceOf(McpError);
      const failure = error as McpError;
      expect(failure.code).toBe(code);
      expect(failure.message).toContain(`HTTP ${status}`);
      expect(failure.message).not.toMatch(/failed after/);
      const data = failure.data as Record<string, unknown>;
      expect(data.status).toBe(status);
      // The operator's configuration is named in the hint, never in the message.
      expect((data.recovery as { hint: string }).hint).toContain('FAOSTAT_BULK_BASE_URL');
      expect(failure.message).not.toContain('FAOSTAT_BULK_BASE_URL');
      // error.data reaches the client: no hand-built URL.
      expect(data).not.toHaveProperty('url');
    },
  );

  it.each([
    { status: 408, code: JsonRpcErrorCode.Timeout },
    { status: 425, code: JsonRpcErrorCode.Timeout },
    { status: 429, code: JsonRpcErrorCode.RateLimited },
    { status: 500, code: JsonRpcErrorCode.ServiceUnavailable },
    { status: 502, code: JsonRpcErrorCode.ServiceUnavailable },
    { status: 503, code: JsonRpcErrorCode.ServiceUnavailable },
    { status: 504, code: JsonRpcErrorCode.Timeout },
  ])(
    'retries HTTP $status through the full backoff, then fails without a config hint',
    async ({ status, code }) => {
      const { error, calls } = await fetchWith([() => statusResponse(status)]);

      // One attempt plus withRetry's three retries.
      expect(calls).toHaveLength(4);
      const failure = error as McpError;
      expect(failure.code).toBe(code);
      expect(failure.message).toMatch(/failed after 4 attempts/);
      const data = failure.data as Record<string, unknown>;
      expect(data.status).toBe(status);
      expect(data.retryAttempts).toBe(4);
      expect(data).not.toHaveProperty('url');
      // A transient status says nothing about the configuration.
      expect(data).not.toHaveProperty('recovery');
    },
  );

  it('recovers when a transient status clears on a later attempt', async () => {
    const { datasets, error, calls } = await fetchWith([
      () => statusResponse(503),
      () => statusResponse(429),
      () => Response.json(fixtureManifestResponse()),
    ]);

    expect(error).toBeUndefined();
    expect(calls).toHaveLength(3);
    expect(datasets?.map((d) => d.DatasetCode)).toEqual(['QCL']);
  });

  it('stops retrying as soon as a transient failure turns permanent', async () => {
    const { error, calls } = await fetchWith([
      () => statusResponse(503),
      () => statusResponse(404),
    ]);

    expect(calls).toHaveLength(2);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('fails a 200 manifest without Datasets.Dataset as retryable, with no hand-built URL', async () => {
    const { error, calls } = await fetchWith([() => Response.json({ Datasets: {} })]);

    // A format change reads as an outage, so it re-enters the backoff.
    expect(calls).toHaveLength(4);
    const failure = error as McpError;
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.message).toContain('upstream format changed');
    // error.data reaches the client, so the manifest URL stays off it here too.
    expect(failure.data).not.toHaveProperty('url');
  });

  it('sends the manifest URL and the User-Agent on every attempt, failing ones included', async () => {
    const { calls } = await fetchWith([() => statusResponse(502)]);

    expect(calls).toHaveLength(4);
    for (const [url, init] of calls) {
      expect(String(url)).toBe(`${BASE_URL}/datasets_E.json`);
      expect(new Headers(init?.headers).get('user-agent')).toBe(FAOSTAT_USER_AGENT);
    }
  });
});

describe('parseFileRows', () => {
  it('parses a JSON number (the live manifest shape)', () => {
    expect(parseFileRows(413211)).toBe(413211);
  });

  it('parses a quoted-string count (legacy/defensive)', () => {
    expect(parseFileRows('413211')).toBe(413211);
    expect(parseFileRows('  241859  ')).toBe(241859);
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseFileRows(undefined)).toBeNull();
    expect(parseFileRows('not-a-number')).toBeNull();
    expect(parseFileRows(Number.NaN)).toBeNull();
  });
});

describe('parseFileSizeBytes', () => {
  it('parses unit-suffixed size strings (the live manifest shape)', () => {
    expect(parseFileSizeBytes('77KB')).toBe(77_000);
    expect(parseFileSizeBytes('271MB')).toBe(271_000_000);
    expect(parseFileSizeBytes('1.48GB')).toBe(1_480_000_000);
    expect(parseFileSizeBytes('512')).toBe(512); // bare number string → bytes
  });

  it('parses a bare number as bytes (defensive against upstream type drift)', () => {
    expect(parseFileSizeBytes(2_891_000)).toBe(2_891_000);
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseFileSizeBytes(undefined)).toBeNull();
    expect(parseFileSizeBytes('garbage')).toBeNull();
  });
});

describe('findDataset', () => {
  const datasets: ManifestDataset[] = [
    {
      DatasetCode: 'RL',
      DatasetName: 'Land Use',
      DateUpdate: '2025-11-14T00:00:00',
      FileLocation: 'x',
    },
    {
      DatasetCode: 'RFN',
      DatasetName: 'Fertilizers',
      DateUpdate: '2025-07-11T00:00:00',
      FileLocation: 'y',
    },
  ];

  it('matches a domain code case-insensitively', () => {
    expect(findDataset(datasets, 'rl')?.DatasetName).toBe('Land Use');
    expect(findDataset(datasets, 'RFN')?.DatasetName).toBe('Fertilizers');
  });

  it('returns undefined for an unknown code', () => {
    expect(findDataset(datasets, 'QCL')).toBeUndefined();
  });
});
