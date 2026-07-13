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
 * The dead reasons (`unknown_domain`/`empty_result` on query_observations,
 * `no_match` on resolve_codes) were removed from the contracts; the
 * empty-result-with-notice UX is intentional and stays.
 * @module tests/tools/error-contract
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
function declaredReasons(errors: readonly { reason: string }[]): string[] {
  return errors.map((e) => e.reason).sort();
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
        'domain_not_indexed',
        'index_not_ready',
        'invalid_year_range',
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
