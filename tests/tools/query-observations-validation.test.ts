/**
 * @fileoverview `faostat_query_observations` input-validation regression (#12). An
 * explicitly-empty code array must mean "match nothing", never silently broaden to
 * the whole dimension — the mirror's own `.length` guard (in both queryObservations
 * and streamObservations) would drop an empty array and query everything, so the
 * handler short-circuits to a zero-match success before any mirror call. A reversed
 * year range must fail with the declared `invalid_year_range` error rather than the
 * generic empty-result notice; equal bounds stay a valid single-year query. Runs a
 * real domain sync into a temp SQLite mirror (no canvas — these paths return before
 * any spill decision).
 * @module tests/tools/query-observations-validation
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

describe('faostat_query_observations input validation (#12)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-validation-'));
    const zip = buildDomainZip(); // QCL: Afghanistan(2, country), China(351, aggregate roll-up), World(5000, aggregate); Wheat(15)/Production(5510); 2020, 2021
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

  // Each defined-but-empty code array must resolve to zero rows, never broaden to
  // "query the whole dimension". The fixture has data for every dimension, so a
  // broadened query would return rows — a zero result proves the short-circuit held.
  for (const dimension of ['area_codes', 'item_codes', 'element_codes'] as const) {
    it(`treats an empty ${dimension} as an explicit zero-match, not "query all"`, async () => {
      const ctx = createMockContext({ tenantId: 't', errors: queryObservationsTool.errors });
      const input = queryObservationsTool.input.parse({
        domain: FIXTURE_DOMAIN,
        [dimension]: [],
      });
      const result = await queryObservationsTool.handler(input, ctx);

      // Zero rows — the empty selection matched nothing; the query was NOT broadened.
      expect(result.observations).toEqual([]);
      expect(result.spilled).toBe(false);
      expect(result.truncated).toBe(false);
      expect(getEnrichment(ctx).totalCount).toBe(0);

      // A notice that names the explicit-empty-selection case — distinct from the
      // generic no-match ("widen the year range…") guidance.
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain(dimension);
      expect(notice).toMatch(/empty (array|selection)|matches nothing/i);

      // content[] twin agrees: no observations, no false completeness claim.
      const text = queryObservationsTool
        .format(result)
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('\n');
      expect(text).toMatch(/No observations/i);
    });
  }

  it('rejects year_start > year_end with the declared invalid_year_range error', async () => {
    const ctx = createMockContext({ tenantId: 't', errors: queryObservationsTool.errors });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      year_start: 2023,
      year_end: 2020,
    });
    await expect(queryObservationsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_year_range' },
    });
  });

  it('accepts equal year bounds as a valid single-year query', async () => {
    const ctx = createMockContext({ tenantId: 't', errors: queryObservationsTool.errors });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
    });
    const result = await queryObservationsTool.handler(input, ctx);

    // Not rejected: returns the 2020 country row(s) — World and the China (351)
    // roll-up are both aggregate-excluded by default (#4), leaving Afghanistan.
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.every((o) => o.year === 2020)).toBe(true);
    expect(result.spilled).toBe(false);
    expect(result.truncated).toBe(false);
  });
});
