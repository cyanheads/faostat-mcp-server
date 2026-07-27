/**
 * @fileoverview `faostat_commodity_profile` year-range validation regression
 * (#17). A reversed range used to be forwarded into every mirror query, so a
 * self-contradictory request came back as a legitimate-looking empty profile.
 * It must now fail with the same `invalid_year_range` contract
 * `faostat_query_observations` declares — and equal bounds, a valid single-year
 * range, must still succeed.
 * @module tests/tools/commodity-profile-year-range
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

describe('faostat_commodity_profile year-range validation (#17)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-years-'));
    const zip = buildDomainZip(); // QCL with Wheat (15) / Production (5510), 2020–2021
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

  it('rejects year_start > year_end instead of returning an empty profile', async () => {
    const ctx = createMockContext({ tenantId: 'years', errors: commodityProfileTool.errors });
    const input = commodityProfileTool.input.parse({
      item_query: 'wheat',
      year_start: 2022,
      year_end: 2020,
    });
    await expect(commodityProfileTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_year_range' },
    });
  });

  it('throws before commodity resolution', async () => {
    // A commodity that resolves to nothing would otherwise raise no_match first.
    const ctx = createMockContext({ tenantId: 'years', errors: commodityProfileTool.errors });
    const input = commodityProfileTool.input.parse({
      item_query: 'notacommodityanywhere',
      year_start: 2022,
      year_end: 2020,
    });
    await expect(commodityProfileTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_year_range' },
    });
  });

  it('accepts equal bounds as a valid single-year range', async () => {
    const ctx = createMockContext({ tenantId: 'years', errors: commodityProfileTool.errors });
    const input = commodityProfileTool.input.parse({
      item_query: 'wheat',
      year_start: 2021,
      year_end: 2021,
    });
    const result = await commodityProfileTool.handler(input, ctx);
    expect(result.top_producers.length).toBeGreaterThan(0);
    expect(result.production_trend).toEqual([expect.objectContaining({ year: 2021 })]);
  });

  it('declares the same contract entry as faostat_query_observations', () => {
    const profileEntry = commodityProfileTool.errors?.find(
      (e) => e.reason === 'invalid_year_range',
    );
    const siblingEntry = queryObservationsTool.errors?.find(
      (e) => e.reason === 'invalid_year_range',
    );
    expect(profileEntry).toBeDefined();
    expect(profileEntry?.code).toBe(siblingEntry?.code);
    expect(profileEntry?.recovery).toBe(siblingEntry?.recovery);
  });
});
