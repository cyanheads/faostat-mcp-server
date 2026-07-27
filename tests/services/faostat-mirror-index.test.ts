/**
 * @fileoverview Index + overflow-probe regression for the event-loop-blocking
 * query path (#3). Syncs a mid-size synthetic domain, then asserts (a) the common
 * filter + `ORDER BY year` shapes are served by a composite index rather than a
 * full materialize-and-sort — confirmed via `EXPLAIN QUERY PLAN` (no "USE TEMP
 * B-TREE FOR ORDER BY"), and (b) a broad query stays bounded and correct through
 * the LIMIT-probe path that replaced the per-call `COUNT(*)`.
 *
 * Declaring those indexes is not enough on its own: without `sqlite_stat1` the
 * cost-based optimizer cannot compare them and picks the less selective one for
 * the item+element filter shape the aggregation paths use — measured on the real
 * mirror as seconds per query instead of milliseconds. The second suite here
 * covers the statistics lifecycle that fixes it: built on first read, refreshed
 * when a sync applies rows, skipped when a refresh applies none.
 * @module tests/services/faostat-mirror-index
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('FaostatMirror query-planner statistics (#3)', () => {
  const TABLE = `obs_${FIXTURE_DOMAIN}`;
  let dir: string;
  let mirror: FaostatMirror;

  /** Open a mirror on `dir` and sync the fixture domain into it. */
  async function syncInto(target: FaostatMirror): Promise<void> {
    await target.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
  }

  /** The `sqlite_stat1` rows SQLite holds for the cube table — empty when never analyzed. */
  async function statRows(target: FaostatMirror): Promise<{ idx: string | null; stat: string }[]> {
    const m = target.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const present = handle
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'`)
      .get();
    if (!present) return [];
    return handle
      .prepare<{ idx: string | null; stat: string }>(
        `SELECT idx, stat FROM sqlite_stat1 WHERE tbl = ?`,
      )
      .all(TABLE);
  }

  /**
   * Drop the statistics table outright — the state of a mirror synced before any
   * ANALYZE existed. (Dropping rather than emptying it: that is what an inherited
   * `.db` actually looks like, and it is the state the guard reads.)
   */
  async function clearStatistics(target: FaostatMirror): Promise<void> {
    const m = target.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const present = handle
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'`)
      .get();
    if (present) handle.exec('DROP TABLE sqlite_stat1');
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-stats-'));
    const { zip } = buildMidSizeDomainZip({ countryCount: 60, aggregateCount: 4, years: 2 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await syncInto(mirror);
  }, 30_000);

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records statistics for the cube table once a sync has applied rows', async () => {
    const rows = await statRows(mirror);
    expect(rows.length).toBeGreaterThan(0);
    // The composite index whose selection the planner gets wrong without stats.
    expect(rows.map((r) => r.idx)).toContain(`${TABLE}_item_code_element_code_year_idx`);
    // Every stat string opens with the table's row count — the cardinality the
    // optimizer lacked (60 countries + 4 aggregates, 2 years each).
    for (const row of rows) expect(row.stat.split(' ')[0]).toBe('128');
  });

  it('builds statistics on first read for a mirror inherited without them (no re-sync)', async () => {
    // An already-synced .db from a deployment that predates this: indexes present,
    // statistics never computed. Reopening must catch it up from the read path —
    // a fix that only ran inside sync would leave every such mirror slow forever.
    await clearStatistics(mirror);
    expect(await statRows(mirror)).toHaveLength(0);
    await mirror.close();

    const reopened = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    try {
      const res = await reopened.queryObservations(FIXTURE_DOMAIN, {
        itemCodes: [15],
        elementCodes: [5510],
        includeAggregates: false,
        limit: 10,
        offset: 0,
      });
      expect(res.rows.length).toBeGreaterThan(0);
      expect((await statRows(reopened)).length).toBeGreaterThan(0);
    } finally {
      await reopened.close();
    }
    // Keep afterEach's close() valid — the outer mirror is already closed.
    mirror = reopened;
  });

  it('re-analyzes when a refresh applies rows and skips the pass when it applies none', async () => {
    await clearStatistics(mirror);
    expect(await statRows(mirror)).toHaveLength(0);

    // Unchanged upstream: the ingester short-circuits on the checkpoint, so there
    // is nothing to re-analyze and the scheduled no-op refresh must not pay for one.
    const unchanged = await mirror.runDomainSync(FIXTURE_DOMAIN, 'refresh', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
    expect(unchanged.recordsApplied).toBe(0);
    expect(await statRows(mirror)).toHaveLength(0);

    // A rebuilt domain replaces the rows the old statistics described, so they are
    // recomputed rather than left describing a vintage that no longer exists.
    const rebuilt = await mirror.runDomainSync(FIXTURE_DOMAIN, 'refresh', {
      signal: new AbortController().signal,
      dataset: { ...fixtureDataset(), DateUpdate: '2026-06-01T00:00:00' },
    });
    expect(rebuilt.recordsApplied).toBeGreaterThan(0);
    expect((await statRows(mirror)).length).toBeGreaterThan(0);
  }, 30_000);
});
