/**
 * @fileoverview End-to-end mirror test against a synthetic in-memory ZIP. Runs a
 * real domain sync into a temp SQLite mirror, then exercises the read path:
 * dimension code resolution (FTS + country/aggregate classification) and
 * observation queries (aggregate exclusion default, year range, code filters,
 * streaming). Fully offline — `fetch` is stubbed to return the fixture ZIP.
 * @module tests/services/faostat-mirror
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import {
  buildDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

describe('FaostatMirror end-to-end', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-mirror-'));
    // Stub fetch to serve the synthetic ZIP for any URL (the ingester is handed
    // the dataset directly, so no manifest fetch occurs in this path).
    const zip = buildDomainZip();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 64)),
    );
    mirror = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
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

  it('reports the domain ready with the expected row count after init', async () => {
    expect(await mirror.ready(FIXTURE_DOMAIN)).toBe(true);
    const status = await mirror.status(FIXTURE_DOMAIN);
    // 6 data rows (1 country + 2 aggregates: China 351 is a sub-5000 roll-up) × 1
    // item × 1 element × 2 years. All rows are ingested regardless of classification.
    expect(status?.total).toBe(6);
    expect(status?.checkpoint).toBe('2025-12-31T00:00:00');
  });

  it('populates the shared dimension tables from the bundled code lists', async () => {
    expect(await mirror.dimensions.isPopulated()).toBe(true);
    const flags = await mirror.dimensions.listFlags();
    expect(flags.map((f) => f.flag).sort()).toEqual(['A', 'E', 'I']);
    expect(await mirror.dimensions.getFlagDescription('E')).toBe('Estimated value');
  });

  it('resolves an item by full-text query and exposes its CPC code', async () => {
    const { matches } = await mirror.resolve(FIXTURE_DOMAIN, 'item', { query: 'wheat', limit: 10 });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ code: 15, name: 'Wheat', kind: null, cpc_code: '0111' });
  });

  it('classifies areas as country vs aggregate', async () => {
    const { matches } = await mirror.resolve(FIXTURE_DOMAIN, 'area', { limit: 100 });
    const byCode = new Map(matches.map((m) => [m.code, m.kind]));
    expect(byCode.get(2)).toBe('country');
    // 351 "China" is a sub-5000 roll-up (mainland + Taiwan + HK + Macao) — the
    // deny-set flags it aggregate even though its code is below the threshold (#4).
    expect(byCode.get(351)).toBe('aggregate');
    expect(byCode.get(5000)).toBe('aggregate');
  });

  it('resolves an area by exact code', async () => {
    const { matches } = await mirror.resolve(FIXTURE_DOMAIN, 'area', { code: 351, limit: 10 });
    expect(matches).toEqual([{ code: 351, name: 'China', kind: 'aggregate' }]);
  });

  it('excludes aggregate regions by default in observation queries', async () => {
    const { rows, total } = await mirror.queryObservations(FIXTURE_DOMAIN, {
      includeAggregates: false,
      limit: 100,
      offset: 0,
    });
    // 2 country rows (Afghanistan × 2 years); World (5000) AND the China (351)
    // sub-5000 roll-up are both excluded by default (#4), so a naive sum is safe.
    expect(total).toBe(2);
    expect(rows.every((r) => r.area_code < 5000)).toBe(true);
    expect(rows.some((r) => r.area === 'World')).toBe(false);
    expect(rows.some((r) => r.area === 'China')).toBe(false);
  });

  it('includes aggregates when explicitly requested', async () => {
    const { total } = await mirror.queryObservations(FIXTURE_DOMAIN, {
      includeAggregates: true,
      limit: 100,
      offset: 0,
    });
    expect(total).toBe(6);
  });

  it('excludes a denied sub-5000 roll-up (China 351) from both the resolve and query surfaces (#4)', async () => {
    // resolve surface: 351 resolves as aggregate — computed at read time from the
    // code, so the fix reaches already-ingested mirrors with no re-sync.
    const resolved = await mirror.resolve(FIXTURE_DOMAIN, 'area', { code: 351, limit: 10 });
    expect(resolved.matches).toEqual([{ code: 351, name: 'China', kind: 'aggregate' }]);

    // query surface: the SAME code is dropped from the default (aggregate-excluded)
    // set, yet reachable via include_aggregates — proving it's the exclusion
    // predicate removing it, not absence from the data. Both surfaces derive the
    // boundary from isAggregateAreaCode, so they can't silently decouple again.
    const excluded = await mirror.queryObservations(FIXTURE_DOMAIN, {
      includeAggregates: false,
      limit: 100,
      offset: 0,
    });
    expect(excluded.rows.some((r) => r.area_code === 351)).toBe(false);

    const included = await mirror.queryObservations(FIXTURE_DOMAIN, {
      includeAggregates: true,
      limit: 100,
      offset: 0,
    });
    expect(included.rows.some((r) => r.area_code === 351)).toBe(true);

    // stream surface (canvas-spill path) applies the same default exclusion.
    const streamed: Record<string, unknown>[] = [];
    for await (const row of mirror.streamObservations(
      FIXTURE_DOMAIN,
      { includeAggregates: false },
      1000,
    )) {
      streamed.push(row);
    }
    expect(streamed.some((r) => Number(r.area_code) === 351)).toBe(false);
  });

  it('reports an exact total via the overflow probe when the match fits the limit', async () => {
    // Guards the COUNT(*) → LIMIT-probe swap: for a result under the limit the
    // probe-derived total equals what the old count returned, and is flagged exact.
    const { total, totalIsExact } = await mirror.queryObservations(FIXTURE_DOMAIN, {
      includeAggregates: false,
      limit: 100,
      offset: 0,
    });
    // 2 country rows (Afghanistan × 2 years) — China 351 and World 5000 are aggregates.
    expect(total).toBe(2);
    expect(totalIsExact).toBe(true);
  });

  it('marks the total a floor (not exact) when the match overflows the limit', async () => {
    // 2 country rows, probe limit 1 → overflow: rows capped at the limit and the
    // total is a floor, so callers spill / disclose rather than trust a fabricated count.
    const { rows, total, totalIsExact } = await mirror.queryObservations(FIXTURE_DOMAIN, {
      includeAggregates: false,
      limit: 1,
      offset: 0,
    });
    expect(rows).toHaveLength(1);
    expect(total).toBe(1);
    expect(totalIsExact).toBe(false);
  });

  it('honors explicit area_codes verbatim (including an aggregate)', async () => {
    const { rows } = await mirror.queryObservations(FIXTURE_DOMAIN, {
      areaCodes: [5000],
      includeAggregates: false,
      limit: 100,
      offset: 0,
    });
    expect(rows.every((r) => r.area === 'World')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('filters by year range', async () => {
    const { rows } = await mirror.queryObservations(FIXTURE_DOMAIN, {
      yearStart: 2021,
      yearEnd: 2021,
      includeAggregates: true,
      limit: 100,
      offset: 0,
    });
    expect(rows.every((r) => r.year === 2021)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it('carries the data-quality flag and stripped M49 on every row', async () => {
    const { rows } = await mirror.queryObservations(FIXTURE_DOMAIN, {
      areaCodes: [2],
      includeAggregates: false,
      limit: 100,
      offset: 0,
    });
    const estimated = rows.find((r) => r.year === 2021);
    expect(estimated?.flag).toBe('E');
    expect(estimated?.area_m49).toBe('004');
  });

  it('streams all matching country rows for canvas spillover', async () => {
    const collected: Record<string, unknown>[] = [];
    for await (const row of mirror.streamObservations(
      FIXTURE_DOMAIN,
      { includeAggregates: false },
      1000,
    )) {
      collected.push(row);
    }
    // 2 country rows (Afghanistan × 2 years) — the China (351) roll-up is excluded
    // by default on the stream path too, matching queryObservations (#4).
    expect(collected).toHaveLength(2);
    expect(collected.every((r) => Number(r.area_code) < 5000)).toBe(true);
    expect(collected.some((r) => Number(r.area_code) === 351)).toBe(false);
    // Streamed rows carry the agent-facing column set incl. the flag.
    expect(collected[0]).toHaveProperty('flag');
  });

  it('bounds the spillover stream by the row limit', async () => {
    const collected: Record<string, unknown>[] = [];
    for await (const row of mirror.streamObservations(
      FIXTURE_DOMAIN,
      { includeAggregates: false },
      1,
    )) {
      collected.push(row);
    }
    // LIMIT caps the materialized set so a broad query can't exhaust the heap.
    expect(collected).toHaveLength(1);
  });

  it('skips an unchanged domain on refresh (checkpoint short-circuit)', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();
    const result = await mirror.runDomainSync(FIXTURE_DOMAIN, 'refresh', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
    // DateUpdate equals the stored checkpoint → no re-stream, no fetch.
    expect(result.recordsApplied).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
