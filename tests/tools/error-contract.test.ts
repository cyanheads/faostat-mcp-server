/**
 * @fileoverview Error-contract conformance (#2). The `errors[]` block is part of
 * each tool's public surface, so every declared reason must be reachable and
 * match what the handler actually throws. These lock the corrected contract:
 *
 *  - `faostat_query_observations` throws `domain_not_indexed` (NOT `unknown_domain`)
 *    for a non-selected domain, and returns an empty result with a notice — never
 *    an `empty_result` throw — when filters match nothing.
 *  - `faostat_resolve_codes` throws `unknown_domain` for a non-selected domain,
 *    and returns empty matches with a notice — never a `no_match` throw — on a
 *    miss.
 *
 *  - `faostat_commodity_profile` throws the non-retryable `domain_not_indexed`
 *    when the production domain (QCL) is not selected — a config gap no wait
 *    fixes — and keeps the retryable `index_not_ready` for a selected QCL whose
 *    initial sync has not completed (#37).
 *
 * The dead reasons (`unknown_domain`/`empty_result` on query_observations,
 * `no_match` on resolve_codes) were removed from the contracts; the
 * empty-result-with-notice UX is intentional and stays. All three declare the read
 * pool's `query_timeout` (#3), exercised in `faostat-mirror-off-thread.test.ts`.
 * @module tests/tools/error-contract
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** Reasons declared in each tool's contract — guards against dead-reason regressions. */
function declaredReasons(errors: readonly { reason: string }[] | undefined): string[] {
  return (errors ?? []).map((e) => e.reason).sort();
}

describe('error-contract conformance', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-contract-'));
    const zip = buildDomainZip();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 64)),
    );
    mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
  });

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('faostat_query_observations', () => {
    it('declares only reachable reasons (no dead unknown_domain / empty_result)', () => {
      expect(declaredReasons(queryObservationsTool.errors)).toEqual([
        'canvas_disabled',
        'canvas_not_found',
        'domain_not_indexed',
        'index_not_ready',
        'invalid_year_range',
        'query_timeout',
      ]);
    });

    it('throws domain_not_indexed (not unknown_domain) for a non-selected domain', async () => {
      const ctx = createMockContext({ tenantId: 't', errors: queryObservationsTool.errors });
      const input = queryObservationsTool.input.parse({ domain: 'NOPE' });
      await expect(queryObservationsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'domain_not_indexed' },
      });
    });

    it('returns an empty result with a notice (does NOT throw empty_result) on no match', async () => {
      const ctx = createMockContext({ tenantId: 't', errors: queryObservationsTool.errors });
      // Valid, indexed domain; a year range with no data → zero matches.
      const input = queryObservationsTool.input.parse({
        domain: FIXTURE_DOMAIN,
        item_codes: [15],
        element_codes: [5510],
        year_start: 1700,
        year_end: 1701,
      });
      const result = await queryObservationsTool.handler(input, ctx);
      expect(result.observations).toEqual([]);
      expect(result.spilled).toBe(false);
      expect(getEnrichment(ctx).notice).toMatch(/No observations matched/i);
      expect(getEnrichment(ctx).totalCount).toBe(0);
    });
  });

  describe('faostat_resolve_codes', () => {
    it('declares only reachable reasons (no dead no_match)', () => {
      expect(declaredReasons(resolveCodesTool.errors)).toEqual([
        'index_not_ready',
        'query_timeout',
        'unknown_domain',
      ]);
    });

    it('throws unknown_domain for a non-selected domain', async () => {
      const ctx = createMockContext({ tenantId: 't', errors: resolveCodesTool.errors });
      const input = resolveCodesTool.input.parse({ domain: 'NOPE', dimension: 'item' });
      await expect(resolveCodesTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'unknown_domain' },
      });
    });

    it('returns empty matches with a notice (does NOT throw no_match) on a miss', async () => {
      const ctx = createMockContext({ tenantId: 't', errors: resolveCodesTool.errors });
      const input = resolveCodesTool.input.parse({
        domain: FIXTURE_DOMAIN,
        dimension: 'item',
        query: 'zxqwvyplugh',
      });
      const result = await resolveCodesTool.handler(input, ctx);
      expect(result.matches).toEqual([]);
      expect(getEnrichment(ctx).notice).toMatch(/No item matched/i);
    });
  });
});

describe('faostat_commodity_profile production-domain availability (#37)', () => {
  let dir: string;
  // Unset for the declaration pin, which reads no mirror.
  let mirror: FaostatMirror | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-contract-profile-'));
  });

  afterEach(async () => {
    await mirror?.close();
    mirror = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  /** The profile's declared contract entry for `reason`. */
  function declared(reason: string) {
    const entry = commodityProfileTool.errors?.find((e) => e.reason === reason);
    if (!entry) throw new Error(`faostat_commodity_profile declares no ${reason}`);
    return entry;
  }

  /** Run the profile through its public contract and split the failure's two surfaces. */
  async function profileFailure() {
    const wire = await runToolContract(
      commodityProfileTool,
      { item_query: 'wheat' },
      { context: { tenantId: 'profile-contract' } },
    );
    expect(wire.isError).toBe(true);
    const { error } = wire.structuredContent as {
      error: { code: number; data: Record<string, unknown> };
    };
    return { error, text: wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') };
  }

  it('declares only reachable reasons', () => {
    expect(declaredReasons(commodityProfileTool.errors)).toEqual([
      'canvas_not_found',
      'domain_not_indexed',
      'index_not_ready',
      'invalid_year_range',
      'no_match',
      'query_timeout',
    ]);
  });

  it('fails an unselected QCL with the non-retryable domain_not_indexed and its declared recovery', async () => {
    mirror = initFaostatMirror({ dir, domains: ['TCL'] });
    const { error, text } = await profileFailure();

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('domain_not_indexed');
    expect(error.data.retryable).toBeUndefined();
    expect(text).toContain('domain_not_indexed');
    // Nothing on content[] tells the caller a wait or a retry will help.
    expect(text).not.toMatch(/retry|initial sync/i);

    const entry = declared('domain_not_indexed');
    expect(entry.code).toBe(JsonRpcErrorCode.NotFound);
    expect(entry).not.toHaveProperty('retryable');
    expect(entry.recovery).toMatch(/add QCL to FAOSTAT_DOMAINS and re-sync/);
    expect(entry.recovery).toContain('faostat_query_observations');
    expect(error.data.recovery).toEqual({ hint: entry.recovery });
    expect(text).toContain(entry.recovery);
  });

  it('keeps the retryable index_not_ready for a selected QCL whose initial sync has not completed', async () => {
    mirror = initFaostatMirror({ dir, domains: ['QCL'] });
    const { error, text } = await profileFailure();

    const entry = declared('index_not_ready');
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable, retryable: true });

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'index_not_ready',
      retryable: true,
      recovery: { hint: entry.recovery },
    });
    expect(text).toContain(entry.recovery);
    expect(text).toContain('index_not_ready');
  });
});
