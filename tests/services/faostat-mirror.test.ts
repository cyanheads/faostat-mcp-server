/**
 * @fileoverview End-to-end mirror test against a synthetic in-memory ZIP. Runs a
 * real domain sync into a temp SQLite mirror, then exercises the read path:
 * dimension code resolution (FTS + country/aggregate classification) and
 * observation queries (aggregate exclusion default, year range, code filters,
 * streaming). Fully offline — `fetch` is stubbed to return the fixture ZIP. A
 * second suite runs two instances over one store directory: a sync refused by the
 * other's lease must leave that sync's rows, state, and revision as they were.
 * @module tests/services/faostat-mirror
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import {
  buildDomainZip,
  buildExplicitDomainZip,
  buildMidSizeDomainZip,
  chunkedResponse,
  type ExplicitObservation,
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
    expect(matches).toEqual([{ code: 351, code_text: null, name: 'China', kind: 'aggregate' }]);
  });

  it('preserves historical reporting entities as countries', async () => {
    const codes = [15, 51, 62, 151, 164, 186, 206, 228, 248];
    await mirror.dimensions.upsertAreas(
      codes.map((code) => ({
        area_code: code,
        area: `Historical ${code}`,
        area_m49: null,
        kind: 'country' as const,
      })),
    );
    for (const code of codes) {
      const result = await mirror.dimensions.resolve('area', { code, limit: 1 });
      expect(result.matches[0]?.kind).toBe('country');
    }
  });

  it.each([261, 266, 268, 269, 420])(
    'reclassifies legacy roll-up %i across all read paths (#40)',
    async (code) => {
      await mirror.dimensions.upsertAreas([
        {
          area_code: code,
          area: `Roll-up ${code}`,
          area_m49: null,
          kind: 'country',
        },
      ]);
      const handle = await mirror.getMirror(FIXTURE_DOMAIN)!.raw();
      handle
        .prepare(`INSERT INTO obs_QCL (id, area_code, area_m49, area, item_code, item, element_code, element, year, unit, value, flag, note, item_code_text, period, value_qualifier, source_code, source)
      SELECT ? || '|' || id, ?, area_m49, ?, item_code, item, element_code, element,
        year, unit, value, flag, note, item_code_text, period, value_qualifier, source_code, source FROM obs_QCL WHERE area_code = 2`)
        .run(String(code), code, `Roll-up ${code}`);
      const classified = await mirror.resolve(FIXTURE_DOMAIN, 'area', { code, limit: 1 });
      expect(classified.matches[0]?.kind).toBe('aggregate');
      const resolved = await resolveCodesTool.handler(
        resolveCodesTool.input.parse({
          domain: FIXTURE_DOMAIN,
          dimension: 'area',
          code,
        }),
        createMockContext({ errors: resolveCodesTool.errors }),
      );
      expect(resolved.matches[0]).toMatchObject({ code, kind: 'aggregate' });
      expect(resolveCodesTool.format!(resolved)).toEqual([
        {
          type: 'text',
          text: expect.stringContaining(`**${code}** — Roll-up ${code} [aggregate]`),
        },
      ]);
      const output = await queryObservationsTool.handler(
        queryObservationsTool.input.parse({
          domain: FIXTURE_DOMAIN,
        }),
        createMockContext({ errors: queryObservationsTool.errors }),
      );
      expect(output.observations.map((row) => row.area_code)).toEqual([2, 2]);
      expect(JSON.stringify(queryObservationsTool.format!(output))).toContain('Afghanistan');
      expect(JSON.stringify(queryObservationsTool.format!(output))).not.toContain(
        `Roll-up ${code}`,
      );
      expect(
        queryObservationsTool.input.safeParse({ domain: FIXTURE_DOMAIN, offset: -1 }).success,
      ).toBe(false);
      const filters = { includeAggregates: false };
      const page = await mirror.queryObservations(FIXTURE_DOMAIN, {
        ...filters,
        limit: 100,
        offset: 0,
      });
      expect(page.rows.map((row) => row.area_code)).toEqual([2, 2]);
      const stream = [];
      for await (const row of mirror.streamObservations(FIXTURE_DOMAIN, filters, 100))
        stream.push(row);
      expect(stream.map((row) => row.area_code)).toEqual([2, 2]);
      expect(
        (await mirror.rankAreaTotals(FIXTURE_DOMAIN, filters, 100)).map((row) => row.area_code),
      ).toEqual([2]);
      expect((await mirror.sumByYear(FIXTURE_DOMAIN, filters)).map((row) => row.value)).toEqual([
        5000, 5200,
      ]);
      for (const override of [
        { areaCodes: [code], includeAggregates: false },
        { includeAggregates: true },
      ]) {
        const included = await mirror.queryObservations(FIXTURE_DOMAIN, {
          ...override,
          limit: 100,
          offset: 0,
        });
        expect(included.rows.some((row) => row.area_code === code)).toBe(true);
        expect(
          (await mirror.rankAreaTotals(FIXTURE_DOMAIN, override, 100)).some(
            (row) => row.area_code === code,
          ),
        ).toBe(true);
        const streamed = [];
        for await (const row of mirror.streamObservations(FIXTURE_DOMAIN, override, 100))
          streamed.push(row);
        expect(streamed.some((row) => row.area_code === code)).toBe(true);
        const trend = await mirror.sumByYear(FIXTURE_DOMAIN, override);
        expect(trend.map((row) => row.value)).toEqual(
          override.includeAggregates ? [904250, 917350] : [5000, 5200],
        );
      }
      const explicit = await queryObservationsTool.handler(
        queryObservationsTool.input.parse({ domain: FIXTURE_DOMAIN, area_codes: [code] }),
        createMockContext({ errors: queryObservationsTool.errors }),
      );
      expect(explicit.observations).toHaveLength(2);
      expect(explicit.observations.every((row) => row.area_code === code)).toBe(true);
      expect(JSON.stringify(queryObservationsTool.format!(explicit))).toContain(`Roll-up ${code}`);
      const empty = await mirror.queryObservations(FIXTURE_DOMAIN, {
        ...filters,
        limit: 100,
        offset: 2,
      });
      expect(empty.rows).toEqual([]);
      const capped = await mirror.queryObservations(FIXTURE_DOMAIN, {
        ...filters,
        limit: 1,
        offset: 0,
      });
      expect(capped.rows).toHaveLength(1);
      expect(capped.totalIsExact).toBe(false);
    },
  );

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
    expect(resolved.matches).toEqual([
      { code: 351, code_text: null, name: 'China', kind: 'aggregate' },
    ]);

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

/** A promise and its resolve — paces a sync without timers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** `bytes` as a response body that delivers every byte, then stays open until `gate` resolves. */
function heldOpen(bytes: Uint8Array, gate: Promise<void>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    async pull(controller) {
      await gate;
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('FaostatMirror sync while another instance holds the lease', () => {
  let dir: string;
  const opened: FaostatMirror[] = [];
  /** Keeps the holder's ZIP body open after its last byte until resolved. */
  let zipGate: ReturnType<typeof deferred>;

  function openMirror(domain: string): FaostatMirror {
    const mirror = new FaostatMirror({ dir, domains: [domain] });
    opened.push(mirror);
    return mirror;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-lease-'));
    zipGate = deferred();
  });

  afterEach(async () => {
    zipGate.resolve();
    for (const mirror of opened.splice(0)) await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses the second sync without touching the holder's committed rows, sync state, or revision", async () => {
    // A fresh FS store has no ingest revision until its first sync completes, so a
    // sync of it replaces the whole cube — the step a refused sync must never run.
    const DOMAIN = 'FS';
    const TABLE = `obs_${DOMAIN}`;
    // 6,000 rows: one 5,000-row page commits, the rest wait on the held body.
    const { zip, total } = buildMidSizeDomainZip({ domain: DOMAIN, countryCount: 600, years: 10 });
    const fetcher = vi.fn(async () => heldOpen(zip, zipGate.promise));
    vi.stubGlobal('fetch', fetcher);
    const holder = openMirror(DOMAIN);
    const committed = deferred();
    const holding = holder.runDomainSync(DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(DOMAIN),
      onProgress: ({ records }) => {
        if (records > 0) committed.resolve();
      },
    });
    await committed.promise;

    const handle = await holder.getMirror(DOMAIN)!.raw();
    const storeState = () => ({
      rows: handle.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${TABLE}`).get()?.n,
      syncState: handle.prepare('SELECT * FROM mirror_sync_state').all(),
      revision: handle.prepare('SELECT revision FROM ingest_revision').all(),
    });
    const before = storeState();
    expect(before).toMatchObject({ rows: 5000, revision: [] });

    await expect(
      openMirror(DOMAIN).runDomainSync(DOMAIN, 'refresh', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(DOMAIN),
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Conflict, data: { reason: 'sync_locked' } });
    expect(storeState()).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(1);

    zipGate.resolve();
    expect(await holding).toMatchObject({ recordsApplied: total, total });
    expect(storeState()).toMatchObject({ rows: total, revision: [{ revision: 2 }] });
    expect(await holder.ready(DOMAIN)).toBe(true);
  }, 30_000);

  it('refuses a sync of a revision-1 store without indexing it or raising its revision, and prepares it once the lease is free', async () => {
    const TABLE = `obs_${FIXTURE_DOMAIN}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(buildDomainZip(), 64)),
    );
    const mirror = openMirror(FIXTURE_DOMAIN);
    const sync = (mode: 'init' | 'refresh') =>
      mirror.runDomainSync(FIXTURE_DOMAIN, mode, {
        signal: new AbortController().signal,
        dataset: fixtureDataset(),
      });
    await sync('init');
    const handle = await mirror.getMirror(FIXTURE_DOMAIN)!.raw();
    // A compatible numeric cube from before text identities: revision 1, without their indexes.
    const textEraIndexes = [
      'item_code_text_idx',
      'item_code_text_element_code_year_idx',
      'source_code_idx',
      'unit_element_idx',
    ].map((suffix) => `${TABLE}_${suffix}`);
    for (const index of textEraIndexes) handle.exec(`DROP INDEX ${index}`);
    handle.exec('UPDATE ingest_revision SET revision = 1');
    // Another process holds the store's sync lease, with an expiry no clock reaches.
    handle
      .prepare(
        'UPDATE mirror_sync_lease SET owner = ?, generation = generation + 1, expires_at = ? WHERE id = 1',
      )
      .run('another-process', Number.MAX_SAFE_INTEGER);
    const storeState = () => ({
      indexes: handle
        .prepare<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
        )
        .all(TABLE)
        .map((row) => row.name),
      syncState: handle.prepare('SELECT * FROM mirror_sync_state').all(),
      revision: handle.prepare('SELECT revision FROM ingest_revision').all(),
    });
    const before = storeState();

    await expect(sync('refresh')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'sync_locked' },
    });
    expect(storeState()).toEqual(before);

    handle.exec('UPDATE mirror_sync_lease SET owner = NULL, expires_at = NULL WHERE id = 1');
    expect((await sync('refresh')).recordsApplied).toBe(0);
    expect(storeState().revision).toEqual([{ revision: 2 }]);
    expect(storeState().indexes).toEqual(expect.arrayContaining(textEraIndexes));
  }, 30_000);

  it('publishes a first sync’s revision before releasing the lease, so a claim right after replaces nothing', async () => {
    const DOMAIN = 'FS';
    const { zip, total } = buildMidSizeDomainZip({ domain: DOMAIN, countryCount: 60, years: 2 });
    const fetcher = vi.fn(async () => chunkedResponse(zip, 1 << 16));
    vi.stubGlobal('fetch', fetcher);
    const first = openMirror(DOMAIN);
    const next = openMirror(DOMAIN);
    const domain = first.getMirror(DOMAIN)!;
    const handle = await domain.raw();
    const leases = domain.store.syncLease!;
    const release = leases.release.bind(leases);
    let revisionAtRelease: unknown;
    let nextSync: Promise<unknown> | undefined;
    // The runner releases the lease after its completion commit; the other instance claims at once.
    vi.spyOn(leases, 'release').mockImplementation(async (lease) => {
      revisionAtRelease = handle.prepare('SELECT revision FROM ingest_revision').all();
      await release(lease);
      nextSync = next.runDomainSync(DOMAIN, 'refresh', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(DOMAIN),
      });
      await nextSync;
    });

    const synced = await first.runDomainSync(DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(DOMAIN),
    });
    expect(synced).toMatchObject({ recordsApplied: total, total });
    expect(await nextSync).toMatchObject({ recordsApplied: 0, total });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(revisionAtRelease).toEqual([{ revision: 2 }]);
  }, 30_000);

  it('leaves the revision unpublished when a first sync is stopped after its last page, before it completes', async () => {
    const DOMAIN = 'FS';
    const { zip } = buildMidSizeDomainZip({ domain: DOMAIN, countryCount: 60, years: 2 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    const mirror = openMirror(DOMAIN);
    const controller = new AbortController();
    const stopped = new Error('Stopped for shutdown');

    await expect(
      mirror.runDomainSync(DOMAIN, 'init', {
        signal: controller.signal,
        dataset: fixtureDataset(DOMAIN),
        // Only the terminal page carries the checkpoint; it has committed when this runs.
        onProgress: ({ checkpoint }) => {
          if (checkpoint) controller.abort(stopped);
        },
      }),
    ).rejects.toBe(stopped);
    const handle = await mirror.getMirror(DOMAIN)!.raw();
    expect(handle.prepare('SELECT revision FROM ingest_revision').all()).toEqual([]);
    expect(await mirror.status(DOMAIN)).toMatchObject({ status: 'error', ready: false });
  }, 30_000);
});

/**
 * The profile's item-scoped reads (#51, #50): the element codes an item carries
 * (its selection read), the units a ranking's own rows use, and each ranked row's
 * lag behind the ranking's latest year.
 */
describe('FaostatMirror profile reads (#50, #51)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  const STOCKS = { itemCode: 866, item: 'Cattle', elementCode: 5111, element: 'Stocks' } as const;
  const ROWS: ExplicitObservation[] = [
    { areaCode: 10, area: 'Alpha', ...STOCKS, unit: 'An', year: 2021, value: 100 },
    { areaCode: 20, area: 'Bravo', ...STOCKS, unit: '', year: 2022, value: 1 },
    { areaCode: 5000, area: 'World', ...STOCKS, unit: 'No', year: 2024, value: 9 },
    { areaCode: 30, area: 'Charlie', ...STOCKS, unit: 'An', year: 2019, value: 50 },
    {
      areaCode: 10,
      area: 'Alpha',
      itemCode: 15,
      item: 'Wheat',
      elementCode: 5510,
      element: 'Production',
      year: 2022,
      value: 5,
    },
    {
      areaCode: 10,
      area: 'Alpha',
      itemCode: 15,
      item: 'Wheat',
      elementCode: 5312,
      element: 'Area harvested',
      unit: 'ha',
      year: 2022,
      value: 2,
    },
  ];
  const stocks = { itemCodes: [866], elementCodes: [5111], includeAggregates: false };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-mirror-profile-'));
    const zip = buildExplicitDomainZip(ROWS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
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

  it('lists the elements an item carries, labeled from the vocabulary, and none for an absent item', async () => {
    expect(await mirror.itemElements(FIXTURE_DOMAIN, [15])).toEqual([
      { element_code: 5312, element: 'Area harvested' },
      { element_code: 5510, element: 'Production' },
    ]);
    expect(await mirror.itemElements(FIXTURE_DOMAIN, [866])).toEqual([
      { element_code: 5111, element: 'Stocks' },
    ]);
    expect(await mirror.itemElements(FIXTURE_DOMAIN, [999])).toEqual([]);
  });

  it('reads the units of the rows a ranking matches: countries only, within the year bounds', async () => {
    // A blank unit is its own (null) unit; the World aggregate's unit is excluded.
    expect(await mirror.elementUnits(FIXTURE_DOMAIN, stocks)).toEqual([
      { element_code: 5111, unit: null },
      { element_code: 5111, unit: 'An' },
    ]);
    expect(await mirror.elementUnits(FIXTURE_DOMAIN, { ...stocks, yearStart: 2022 })).toEqual([
      { element_code: 5111, unit: null },
    ]);
    expect(
      await mirror.elementUnits(FIXTURE_DOMAIN, { ...stocks, includeAggregates: true }),
    ).toEqual([
      { element_code: 5111, unit: null },
      { element_code: 5111, unit: 'An' },
      { element_code: 5111, unit: 'No' },
    ]);
    expect(await mirror.elementUnits(FIXTURE_DOMAIN, { ...stocks, yearStart: 2030 })).toEqual([]);
  });

  it('measures every ranked row against the ranking’s latest year, beyond the rows the limit returns', async () => {
    // Alpha (An, 2021) outranks Bravo (null unit, 2022); the reference is Bravo's
    // 2022 even though top_n 1 returns Alpha alone, and the two units share it.
    expect(await mirror.rankAreaTotals(FIXTURE_DOMAIN, stocks, 1)).toEqual([
      expect.objectContaining({ area_code: 10, unit: 'An', year: 2021, years_behind: 1 }),
    ]);
    expect(
      (await mirror.rankAreaTotals(FIXTURE_DOMAIN, stocks, 10)).map((r) => [
        r.area_code,
        r.year,
        r.years_behind,
      ]),
    ).toEqual([
      [10, 2021, 1],
      [30, 2019, 3],
      [20, 2022, 0],
    ]);
    // The reference follows the filters: aggregates in, the World's 2024 sets it.
    expect(
      (await mirror.rankAreaTotals(FIXTURE_DOMAIN, { ...stocks, includeAggregates: true }, 10)).map(
        (r) => [r.area_code, r.years_behind],
      ),
    ).toEqual([
      [10, 3],
      [30, 5],
      [5000, 0],
      [20, 2],
    ]);
    // And the year bounds: with year_end 2021, Alpha is current.
    expect(
      (await mirror.rankAreaTotals(FIXTURE_DOMAIN, { ...stocks, yearEnd: 2021 }, 10)).map((r) => [
        r.area_code,
        r.year,
        r.years_behind,
      ]),
    ).toEqual([
      [10, 2021, 0],
      [30, 2019, 2],
    ]);
  });
});
