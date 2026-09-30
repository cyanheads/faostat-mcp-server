/**
 * @fileoverview `faostat_list_domains` error envelope when the bulk host refuses
 * the manifest (#28). The tool fetches the manifest on every call, so a permanent
 * 4xx — a misconfigured `FAOSTAT_BULK_BASE_URL` on the FAO host answers 403 — must
 * reach the client after one request, status-mapped, with a recovery hint naming
 * the setting on both `structuredContent` and `content[]`, and no URL in
 * `error.data`. A transient status keeps its backoff. Runs through
 * `runToolContract`; only `fetch` is stubbed, so the real `withRetry` runs.
 * @module tests/tools/list-domains-upstream-errors
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDomainsTool } from '@/mcp-server/tools/definitions/list-domains.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';

interface ErrorEnvelope {
  error: { code: number; data: Record<string, unknown>; message: string };
}

describe('faostat_list_domains when the bulk host refuses the manifest (#28)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-list-domains-errors-'));
    mirror = initFaostatMirror({ dir, domains: ['QCL'] });
  });

  afterEach(async () => {
    await mirror.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Call the tool against a host answering `status`; drain any retry backoff. */
  async function listAgainst(status: number) {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => new Response(`status ${status}`, { status }));
    vi.stubGlobal('fetch', fetchSpy);
    const pending = runToolContract(listDomainsTool, {}, { context: { tenantId: 't' } });
    await vi.runAllTimersAsync();
    const wire = await pending;
    expect(wire.isError).toBe(true);
    const text = wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return {
      error: (wire.structuredContent as unknown as ErrorEnvelope).error,
      requests: fetchSpy.mock.calls.length,
      text,
    };
  }

  it('fails a 403 after one request as Forbidden, naming FAOSTAT_BULK_BASE_URL on both surfaces', async () => {
    const { error, requests, text } = await listAgainst(403);

    expect(requests).toBe(1);
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.message).toContain('HTTP 403');
    expect(error.data.status).toBe(403);
    expect(error.data).not.toHaveProperty('url');
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toContain('FAOSTAT_BULK_BASE_URL');
    expect(text).toContain(hint);
  });

  it('fails a 404 after one request as NotFound', async () => {
    const { error, requests } = await listAgainst(404);

    expect(requests).toBe(1);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect((error.data.recovery as { hint: string }).hint).toContain('FAOSTAT_BULK_BASE_URL');
  });

  it('retries a 503 through the backoff and reports the outage without a config hint', async () => {
    const { error, requests, text } = await listAgainst(503);

    expect(requests).toBe(4);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/failed after 4 attempts/);
    expect(error.data).not.toHaveProperty('url');
    expect(error.data).not.toHaveProperty('recovery');
    expect(text).not.toContain('FAOSTAT_BULK_BASE_URL');
  });
});
