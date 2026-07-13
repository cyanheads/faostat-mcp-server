/**
 * @fileoverview Index + overflow-probe regression for the event-loop-blocking
 * query path (#3). Syncs a mid-size synthetic domain, then asserts (a) the common
 * filter + `ORDER BY year` shapes are served by a composite index rather than a
 * full materialize-and-sort — confirmed via `EXPLAIN QUERY PLAN` (no "USE TEMP
 * B-TREE FOR ORDER BY"), and (b) a broad query stays bounded and correct through
 * the LIMIT-probe path that replaced the per-call `COUNT(*)`.
 * @module tests/services/faostat-mirror-index
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import {
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** Run EXPLAIN QUERY PLAN and flatten the plan into one detail string. */
function queryPlan(
  handle: { prepare: <T>(sql: string) => { all: (...p: unknown[]) => T[] } },
  sql: string,
  params: unknown[],
): string {
  const rows = handle.prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return rows.map((r) => r.detail).join(' | ');
}

describe('FaostatMirror index + overflow probe (#3)', () => {
  let dir: string;
  let mirror: FaostatMirror;
  const COUNTRIES = 400;
  const YEARS = 12;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-index-'));
    // ~5k country rows (400 × 12) + a few aggregates — enough that the planner
    // prefers an index over a full scan + sort for the ORDER BY year + LIMIT shape.
    const { zip } = buildMidSizeDomainZip({
      countryCount: COUNTRIES,
      aggregateCount: 20,
      years: YEARS,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
  }, 30_000);

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the composite indexes on the domain table', async () => {
    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const names = handle
      .prepare<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? ORDER BY name`,
      )
      .all(`obs_${FIXTURE_DOMAIN}`)
      .map((r) => r.name);
    expect(names).toContain(`obs_${FIXTURE_DOMAIN}_element_code_year_idx`);
    expect(names).toContain(`obs_${FIXTURE_DOMAIN}_item_code_element_code_year_idx`);
  });

  it('serves the element-filter + ORDER BY year shape from an index, no temp-b-tree sort', async () => {
    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const table = `obs_${FIXTURE_DOMAIN}`;
    // The issue's repro shape: element-only filter, aggregate-excluded, sorted by
    // year with a LIMIT (the overflow probe). The (element_code, year) index must
    // satisfy both the seek and the sort so the LIMIT bounds the scan.
    const detail = queryPlan(
      handle,
      `SELECT * FROM ${table} WHERE area_code < 5000 AND element_code IN (?) ORDER BY year ASC LIMIT ? OFFSET ?`,
      [5510, 51, 0],
    );
    expect(detail).toMatch(/USING INDEX obs_QCL_element_code_year_idx/);
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('serves the streamObservations spill shape from an index, no temp-b-tree sort', async () => {
    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const table = `obs_${FIXTURE_DOMAIN}`;
    const detail = queryPlan(
      handle,
      `SELECT area_code, area, item_code, item, element_code, element, year, unit, value, flag FROM ${table} WHERE area_code < 5000 AND element_code IN (?) ORDER BY year ASC LIMIT ?`,
      [5510, 50_001],
    );
    expect(detail).toMatch(/USING INDEX obs_QCL_element_code_year_idx/);
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('serves the commodity item+element shape from a composite index', async () => {
    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const table = `obs_${FIXTURE_DOMAIN}`;
    const detail = queryPlan(
      handle,
      `SELECT * FROM ${table} WHERE area_code < 5000 AND item_code IN (?) AND element_code IN (?) ORDER BY year ASC LIMIT ? OFFSET ?`,
      [15, 5510, 51, 0],
    );
    expect(detail).toMatch(/USING INDEX obs_QCL_item_code_element_code_year_idx/);
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('bounds a broad query via the LIMIT probe and reports an inexact floor', async () => {
    // A broad element-only match spans all COUNTRIES × YEARS country rows. The probe
    // fetches limit+1, caps rows at limit, and marks the total a floor (not exact).
    const res = await mirror.queryObservations(FIXTURE_DOMAIN, {
      elementCodes: [5510],
      includeAggregates: false,
      limit: 50,
      offset: 0,
    });
    expect(res.totalIsExact).toBe(false);
    expect(res.total).toBe(50);
    expect(res.rows).toHaveLength(50);
    expect(res.rows.every((r) => r.area_code < 5000)).toBe(true);
  });

  it('reports an exact total when the match drains under the limit', async () => {
    // One country's rows across YEARS years — well under the limit → exact count.
    const res = await mirror.queryObservations(FIXTURE_DOMAIN, {
      areaCodes: [1],
      includeAggregates: false,
      limit: 1000,
      offset: 0,
    });
    expect(res.totalIsExact).toBe(true);
    expect(res.total).toBe(YEARS);
    expect(res.rows).toHaveLength(YEARS);
  });
});
