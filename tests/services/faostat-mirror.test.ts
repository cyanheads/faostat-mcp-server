/**
 * @fileoverview End-to-end mirror test against a synthetic in-memory ZIP. Runs a
 * real domain sync into a temp SQLite mirror, then exercises the read path:
 * dimension code resolution (FTS + country/aggregate classification, each area's
 * M49 code and the exact M49 lookup) and
 * observation queries (aggregate exclusion default, year range, code filters,
 * streaming). Fully offline — `fetch` is stubbed to return the fixture ZIP. A
 * second suite runs two instances over one store directory: a sync refused by the
 * other's lease must leave that sync's rows, state, and revision as they were. A
 * third covers the item vocabulary a domain's data rows supply when its ZIP's item
 * list is short or header-only, and the repair of a mirror synced without them (#64).
 * A fourth covers a refresh removing the rows its file no longer carries, run
 * through, stopped and rerun at each stage (#63).
 * @module tests/services/faostat-mirror
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDomainsTool } from '@/mcp-server/tools/definitions/list-domains.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import type { ManifestDataset } from '@/services/faostat-mirror/types.js';
import {
  buildDomainZip,
  buildExplicitDomainZip,
  buildMidSizeDomainZip,
  chunkedResponse,
  type DomainVocab,
  type ExplicitObservation,
  FIXTURE_DOMAIN,
  fixtureDataset,
  fixtureManifestResponse,
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
    expect(matches).toEqual([
      { code: 351, code_text: null, name: 'China', kind: 'aggregate', m49_code: '156' },
    ]);
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
      { code: 351, code_text: null, name: 'China', kind: 'aggregate', m49_code: '156' },
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

  it('returns only declared fields on every faostat_query_observations row, never the internal id or note', async () => {
    const output = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({ domain: FIXTURE_DOMAIN, include_aggregates: true }),
      createMockContext({ errors: queryObservationsTool.errors }),
    );
    const declared = Object.keys(
      queryObservationsTool.output.shape.observations.element.shape,
    ).sort();
    expect(output.observations).toHaveLength(6);
    for (const row of output.observations) {
      expect(Object.keys(row).sort()).toEqual(declared);
      expect(row).not.toHaveProperty('id');
      expect(row).not.toHaveProperty('note');
    }
  });

  it('looks up areas by their exact stored M49 code, every match in area-code order (#65)', async () => {
    await mirror.dimensions.upsertAreas([
      {
        area_code: 51000,
        area_m49: '002.03',
        area: 'Africa (excluding intra-trade)',
        kind: 'aggregate',
      },
      { area_code: 5100, area_m49: '002', area: 'Africa', kind: 'aggregate' },
      { area_code: 9002, area_m49: '950', area: 'Shared B', kind: 'aggregate' },
      { area_code: 9001, area_m49: '950', area: 'Shared A', kind: 'aggregate' },
    ]);
    const codes = async (m49: string) =>
      (await mirror.dimensions.areasByM49(m49)).map((match) => [match.code, match.m49_code]);
    expect(await codes('002')).toEqual([[5100, '002']]);
    expect(await codes('002.03')).toEqual([[51000, '002.03']]);
    expect(await codes('950')).toEqual([
      [9001, '950'],
      [9002, '950'],
    ]);
    // Exact, never a prefix or a padded reading: the store matches the string it is given.
    expect(await codes('02')).toEqual([]);
    expect(await codes('00')).toEqual([]);
    expect(await codes('999')).toEqual([]);

    // The mirror's resolve routes an area m49Code to the same lookup and counts it.
    expect(await mirror.resolve(FIXTURE_DOMAIN, 'area', { m49Code: '950', limit: 1 })).toEqual({
      matches: [
        { code: 9001, code_text: null, name: 'Shared A', kind: 'aggregate', m49_code: '950' },
        { code: 9002, code_text: null, name: 'Shared B', kind: 'aggregate', m49_code: '950' },
      ],
      total: 2,
    });
  });

  it("returns each area's M49 on resolver matches and on every observation row (#65)", async () => {
    const resolved = await resolveCodesTool.handler(
      resolveCodesTool.input.parse({ domain: FIXTURE_DOMAIN, dimension: 'area' }),
      createMockContext({ errors: resolveCodesTool.errors }),
    );
    const m49 = new Map(resolved.matches.map((match) => [match.code, match.m49_code]));
    expect(Object.fromEntries(m49)).toEqual({ 2: '004', 351: '156', 5000: '001' });
    const listing = JSON.stringify(resolveCodesTool.format!(resolved));
    expect(listing).toContain('**2** — Afghanistan [country] (M49 004)');
    expect(listing).toContain('**351** — China [aggregate] (M49 156)');
    expect(listing).toContain('**5000** — World [aggregate] (M49 001)');

    const output = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({ domain: FIXTURE_DOMAIN, include_aggregates: true }),
      createMockContext({ errors: queryObservationsTool.errors }),
    );
    expect(output.observations).toHaveLength(6);
    for (const row of output.observations) expect(row.area_m49).toBe(m49.get(row.area_code));
    const [text] = queryObservationsTool.format!(output);
    const lines = text?.type === 'text' ? text.text.split('\n') : [];
    expect(lines).toContain(
      '| Area | M49 | Item | Element | Year | Value | Unit | Flag | Period | Source |',
    );
    for (const row of output.observations) {
      expect(lines).toContain(
        `| ${row.area} (${row.area_code}) | ${m49.get(row.area_code)} | Wheat (15) | Production (5510) | ${row.year} | ${row.value} | t | ${row.flag} |  |  |`,
      );
    }
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
    // …and the area's M49 code, which the staged tables carry as area_m49 (#65).
    expect(collected.map((r) => r.area_m49)).toEqual(['004', '004']);
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

/** A tool call's `content[]` text, joined. */
const text = (wire: Awaited<ReturnType<typeof runToolContract>>) =>
  wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

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

/** `bytes` as a response body that delivers every byte, then fails with `error` instead of ending. */
function brokenAfter(bytes: Uint8Array, error: Error): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    pull(controller) {
      controller.error(error);
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

/**
 * The item vocabulary a domain's data rows supply (#64). FAO ships some item lists
 * short or header-only (FBS's `_ItemCodes.csv` is its header alone), so the sync
 * also adds each item identity its rows name that the vocabulary lacks, labeled
 * from its first row, and a sync of an already-synced store first adds every cube
 * identity the vocabulary lacks, none from rows the sync replaces. A list entry keeps
 * precedence: its label and CPC code are never replaced by a data-derived one.
 */
describe('item vocabulary from the data rows (#64)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  const CASSAVA = { code: 125, name: 'Cassava; fresh', cpc: '01520.01', rowName: 'Cassava, fresh' };
  const WHEAT = { code: 15, name: 'Wheat', cpc: '0111' };
  const PRODUCTION = [{ code: 5510, name: 'Production' }];
  /** FBS as FAO ships it: a header-only item list. */
  const FBS_HEADER_ONLY: DomainVocab = {
    elements: [{ code: 664, name: 'Food supply (kcal/capita/day)' }],
    items: [
      { code: 2511, name: 'Wheat and products', listed: false },
      { code: 2901, name: 'Grand Total', listed: false },
    ],
  };
  const QCL_FULL: DomainVocab = { elements: PRODUCTION, items: [WHEAT, CASSAVA] };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-item-vocab-'));
  });

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Init each domain from its vocab, in order, into one mirror registered as the singleton. */
  async function syncDomains(vocabs: [string, DomainVocab][]): Promise<void> {
    mirror = initFaostatMirror({ dir, domains: vocabs.map(([domain]) => domain) });
    for (const [domain, vocab] of vocabs) {
      const zip = buildDomainZip(domain, vocab);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => chunkedResponse(zip, 64)),
      );
      await mirror.runDomainSync(domain, 'init', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(domain),
      });
    }
  }

  /** Refresh `domain` against its unchanged upstream, with a `fetch` that fails the test if called. */
  async function refreshUnchanged(domain: string, signal = new AbortController().signal) {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await mirror.runDomainSync(domain, 'refresh', {
      signal,
      dataset: fixtureDataset(domain),
    });
    expect(fetcher).not.toHaveBeenCalled();
    return result;
  }

  /** Run `fn` on a separate connection to the shared dimension database. */
  async function withDimensions<T>(
    fn: (h: Awaited<ReturnType<typeof openSqliteHandle>>) => T,
  ): Promise<T> {
    const handle = await openSqliteHandle(join(dir, 'dimensions.db'));
    try {
      return fn(handle);
    } finally {
      handle.close();
    }
  }

  /** The vocabulary as a mirror synced before #64 left it: without these identities' rows. */
  function dropItems(codes: (number | string)[]): Promise<void> {
    return withDimensions((h) => {
      for (const code of codes)
        h.prepare('DELETE FROM items WHERE item_code = ? OR item_code_text = ?').run(code, code);
      h.exec("INSERT INTO items_fts(items_fts) VALUES ('rebuild')");
    });
  }

  /** Every vocabulary row, in insertion order. */
  function itemRows(): Promise<unknown[]> {
    return withDimensions((h) => h.prepare('SELECT * FROM items ORDER BY id').all());
  }

  /** Throws when the item FTS index disagrees with the `items` rows it indexes. */
  function checkItemFts(): Promise<void> {
    return withDimensions((h) => {
      h.exec("INSERT INTO items_fts(items_fts, rank) VALUES ('integrity-check', 1)");
    });
  }

  const listing = (domain: string) => mirror.resolve(domain, 'item', { limit: 50 });

  it('keeps a full list’s labels and CPC codes, never its rows’ labels', async () => {
    await syncDomains([['QCL', QCL_FULL]]);
    expect(await listing('QCL')).toEqual({
      matches: [
        { code: 15, code_text: null, name: 'Wheat', kind: null, cpc_code: '0111' },
        { code: 125, code_text: null, name: 'Cassava; fresh', kind: null, cpc_code: '01520.01' },
      ],
      total: 2,
    });
    expect(
      (await mirror.resolve('QCL', 'item', { query: 'cassava', limit: 5 })).matches,
    ).toMatchObject([{ code: 125, name: 'Cassava; fresh' }]);
    expect(
      await mirror.resolve('QCL', 'item', { nameContains: 'Cassava, fresh', limit: 5 }),
    ).toEqual({ matches: [], total: 0 });
    await checkItemFts();
  });

  it('resolves every item of a header-only list by listing, code, and query, unclassified', async () => {
    await syncDomains([['FBS', FBS_HEADER_ONLY]]);
    const grandTotal = { code: 2901, code_text: null, name: 'Grand Total', kind: null };
    expect(await listing('FBS')).toEqual({
      matches: [
        { code: 2511, code_text: null, name: 'Wheat and products', kind: null },
        grandTotal,
      ],
      total: 2,
    });
    expect((await mirror.resolve('FBS', 'item', { code: 2511, limit: 1 })).matches).toEqual([
      { code: 2511, code_text: null, name: 'Wheat and products', kind: null },
    ]);
    const queried = await runToolContract(resolveCodesTool, {
      domain: 'FBS',
      dimension: 'item',
      query: 'grand total',
    });
    expect(queried.isError).toBeFalsy();
    expect(queried.structuredContent).toMatchObject({ matches: [grandTotal] });
    expect(text(queried)).toContain('**2901** — Grand Total');
    const listed = await runToolContract(resolveCodesTool, { domain: 'FBS', dimension: 'item' });
    expect(listed.structuredContent).toMatchObject({ matches: [{ code: 2511 }, grandTotal] });
    expect(text(listed)).toContain('**2511** — Wheat and products');
    await checkItemFts();
  });

  it('adds what a short list lacks, keeping listed labels and CPC codes and verified aggregates', async () => {
    await syncDomains([
      [
        'QCL',
        {
          elements: PRODUCTION,
          items: [WHEAT, CASSAVA, { code: 1717, name: 'Cereals, primary', listed: false }],
        },
      ],
    ]);
    expect((await listing('QCL')).matches).toEqual([
      { code: 15, code_text: null, name: 'Wheat', kind: null, cpc_code: '0111' },
      { code: 125, code_text: null, name: 'Cassava; fresh', kind: null, cpc_code: '01520.01' },
      { code: 1717, code_text: null, name: 'Cereals, primary', kind: 'aggregate' },
    ]);
    await checkItemFts();
  });

  it('resolves an alphanumeric item the list lacks through code_text, with code null', async () => {
    await syncDomains([
      [
        'FS',
        {
          elements: [{ code: 6121, name: 'Prevalence' }],
          items: [
            { code: 21010, name: 'Energy', cpc: '0001' },
            { code: '210401F', name: 'Food', listed: false },
          ],
        },
      ],
    ]);
    const food = { code: null, code_text: '210401F', name: 'Food', kind: null };
    expect((await mirror.resolve('FS', 'item', { codeText: '210401F', limit: 1 })).matches).toEqual(
      [food],
    );
    const wire = await runToolContract(resolveCodesTool, {
      domain: 'FS',
      dimension: 'item',
      code_text: '210401F',
    });
    expect(wire.structuredContent).toMatchObject({ matches: [food] });
    expect(text(wire)).toContain('**210401F** — Food');
    expect((await listing('FS')).matches.map((m) => m.code ?? m.code_text)).toEqual([
      21010,
      '210401F',
    ]);
  });

  it.each([
    ['QCL', 'FBS'],
    ['FBS', 'QCL'],
  ])('keeps the list entry whichever domain syncs first (%s, then %s)', async (...order) => {
    const fbs: DomainVocab = {
      ...FBS_HEADER_ONLY,
      items: [...FBS_HEADER_ONLY.items, { code: 125, name: 'Cassava, fresh', listed: false }],
    };
    await syncDomains(order.map((domain) => [domain, domain === 'QCL' ? QCL_FULL : fbs]));
    const cassava = {
      code: 125,
      code_text: null,
      name: 'Cassava; fresh',
      kind: null,
      cpc_code: '01520.01',
    };
    expect((await mirror.resolve('QCL', 'item', { code: 125, limit: 1 })).matches).toEqual([
      cassava,
    ]);
    expect((await listing('FBS')).matches).toEqual([
      cassava,
      { code: 2511, code_text: null, name: 'Wheat and products', kind: null },
      { code: 2901, code_text: null, name: 'Grand Total', kind: null },
    ]);
    expect((await mirror.resolve('FBS', 'item', { query: 'fresh', limit: 5 })).matches).toEqual([
      cassava,
    ]);
    await checkItemFts();
  });

  it('repairs a store synced without its rows’ items on a refresh of an unchanged upstream', async () => {
    await syncDomains([['FBS', FBS_HEADER_ONLY]]);
    await dropItems([2511, 2901]);
    expect(await listing('FBS')).toEqual({ matches: [], total: 0 });

    expect((await refreshUnchanged('FBS')).recordsApplied).toBe(0);
    expect((await listing('FBS')).matches.map((m) => [m.code, m.name])).toEqual([
      [2511, 'Wheat and products'],
      [2901, 'Grand Total'],
    ]);
    expect(
      (await mirror.resolve('FBS', 'item', { query: 'grand total', limit: 5 })).matches,
    ).toEqual([{ code: 2901, code_text: null, name: 'Grand Total', kind: null }]);
    await checkItemFts();
  });

  it('repairs only the identities a vocabulary lacks, leaving its listed rows as they were', async () => {
    // RFN as a 2025 list left it: 3102 listed, 3103 and 3104 in the rows only.
    await syncDomains([
      [
        'RFN',
        {
          elements: [{ code: 5157, name: 'Agricultural Use' }],
          items: [
            { code: 3102, name: 'Nutrient nitrogen N (total)', cpc: 'F3102', rowName: 'Nitrogen' },
            { code: 3103, name: 'Nutrient phosphate P2O5 (total)' },
            { code: 3104, name: 'Nutrient potash K2O (total)' },
          ],
        },
      ],
    ]);
    await dropItems([3103, 3104]);
    const [listed] = await itemRows();

    await refreshUnchanged('RFN');
    expect((await itemRows())[0]).toEqual(listed);
    expect((await listing('RFN')).matches).toEqual([
      {
        code: 3102,
        code_text: null,
        name: 'Nutrient nitrogen N (total)',
        kind: null,
        cpc_code: 'F3102',
      },
      { code: 3103, code_text: null, name: 'Nutrient phosphate P2O5 (total)', kind: null },
      { code: 3104, code_text: null, name: 'Nutrient potash K2O (total)', kind: null },
    ]);
    await checkItemFts();
  });

  it('repairs an alphanumeric identity, resolving it through code_text with code null', async () => {
    await syncDomains([
      [
        'FS',
        {
          elements: [{ code: 6121, name: 'Prevalence' }],
          items: [{ code: '210401F', name: 'Food' }],
        },
      ],
    ]);
    await dropItems(['210401F']);
    expect((await mirror.resolve('FS', 'item', { codeText: '210401F', limit: 1 })).total).toBe(0);

    await refreshUnchanged('FS');
    expect((await mirror.resolve('FS', 'item', { codeText: '210401F', limit: 1 })).matches).toEqual(
      [{ code: null, code_text: '210401F', name: 'Food', kind: null }],
    );
    await checkItemFts();
  });

  it('changes nothing and reads no label once the vocabulary covers the cube', async () => {
    await syncDomains([['QCL', QCL_FULL]]);
    const before = await itemRows();
    const reads = vi.spyOn(mirror.reads, 'all');

    await refreshUnchanged('QCL');
    expect(await itemRows()).toEqual(before);
    // The distinct-identity read alone: no label read for an identity the vocabulary holds.
    expect(reads).toHaveBeenCalledTimes(1);
    const identities = (await reads.mock.results[0]?.value) as { code: number | string }[];
    expect(identities).toHaveLength(2);
    expect(new Set(identities.map((row) => row.code))).toEqual(new Set([15, 125]));
  });

  it('labels an item the list lacks from its first row when its rows carry two labels, at sync and at repair', async () => {
    // FBS rows as a relabel leaves them: 2020 under the old label, 2021 under the new.
    const relabeled = (_areaCode: number, year: number) =>
      year === 2020 ? 'Cereals - Excluding Beer' : 'Cereals, excluding beer';
    await syncDomains([
      [
        'FBS',
        {
          ...FBS_HEADER_ONLY,
          items: [{ code: 2905, name: 'Cereals', listed: false, rowName: relabeled }],
        },
      ],
    ]);
    const cereals = { code: 2905, code_text: null, name: 'Cereals - Excluding Beer', kind: null };
    expect(await listing('FBS')).toEqual({ matches: [cereals], total: 1 });

    await dropItems([2905]);
    await refreshUnchanged('FBS');
    expect(await listing('FBS')).toEqual({ matches: [cereals], total: 1 });
    await checkItemFts();
  });

  it('adds no item from the rows a sync replaces: a store whose first sync broke off before its item list applied', async () => {
    // A fresh FS store carries no ingest revision until a sync of it completes.
    const DOMAIN = 'FS';
    mirror = initFaostatMirror({ dir, domains: [DOMAIN] });
    const sync = () =>
      mirror.runDomainSync(DOMAIN, 'refresh', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(DOMAIN),
      });
    // 6,000 rows of item 15: one 5,000-row page commits, then the download breaks.
    const { zip } = buildMidSizeDomainZip({ domain: DOMAIN, countryCount: 600, years: 10 });
    const broken = new Error('Connection reset mid-download');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => brokenAfter(zip, broken)),
    );
    await expect(sync()).rejects.toBe(broken);
    const handle = await mirror.getMirror(DOMAIN)!.raw();
    expect(handle.prepare(`SELECT count(*) AS n FROM obs_${DOMAIN}`).get()).toEqual({ n: 5000 });
    expect(handle.prepare('SELECT revision FROM ingest_revision').all()).toEqual([]);
    expect(await mirror.dimensions.missingItemIdentities([15])).toEqual([15]);

    // The next file no longer carries item 15.
    const next = buildDomainZip(DOMAIN, {
      elements: [{ code: 6121, name: 'Prevalence' }],
      items: [{ code: 21010, name: 'Energy', cpc: '0001' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(next, 64)),
    );
    await sync();
    const energy = { code: 21010, code_text: null, name: 'Energy', kind: null, cpc_code: '0001' };
    expect(await mirror.dimensions.resolve('item', { limit: 50 })).toEqual({
      matches: [energy],
      total: 1,
    });
    expect(await listing(DOMAIN)).toEqual({ matches: [energy], total: 1 });
    await checkItemFts();
  });

  it('rejects a refresh stopped during the repair with the stop’s reason, adding nothing', async () => {
    await syncDomains([['FBS', FBS_HEADER_ONLY]]);
    await dropItems([2511, 2901]);
    const controller = new AbortController();
    const stopped = new Error('Stopped for shutdown');
    const all = mirror.reads.all.bind(mirror.reads);
    vi.spyOn(mirror.reads, 'all').mockImplementation((job, signal) => {
      controller.abort(stopped);
      return all(job, signal);
    });

    await expect(refreshUnchanged('FBS', controller.signal)).rejects.toBe(stopped);
    expect(await listing('FBS')).toEqual({ matches: [], total: 0 });
    expect(await mirror.ready('FBS')).toBe(true);
  });

  it('adds an item only where no row holds its identity, indexing what it adds', async () => {
    await syncDomains([['QCL', QCL_FULL]]);
    const before = await itemRows();
    const added = await mirror.dimensions.addMissingItems([
      { item_code: 125, item_code_text: null, cpc_code: null, item: 'Cassava, fresh' },
      { item_code: 2901, item_code_text: null, cpc_code: null, item: 'Grand Total' },
      { item_code: null, item_code_text: '210401F', cpc_code: null, item: 'Food' },
    ]);
    expect(added).toBe(2);
    expect((await itemRows()).slice(0, before.length)).toEqual(before);
    expect(
      await mirror.dimensions.addMissingItems([
        { item_code: 2901, item_code_text: null, cpc_code: null, item: 'Other label' },
      ]),
    ).toBe(0);
    expect((await mirror.dimensions.resolve('item', { query: 'grand', limit: 5 })).matches).toEqual(
      [{ code: 2901, code_text: null, name: 'Grand Total', kind: null }],
    );
    expect(
      await mirror.dimensions.missingItemIdentities([15, 2901, 3103, '210401F', '210402F']),
    ).toEqual([3103, '210402F']);
    expect(await mirror.dimensions.addMissingItems([])).toBe(0);
    expect(await mirror.dimensions.missingItemIdentities([])).toEqual([]);
    await checkItemFts();
  });
});

/**
 * A refresh removes the rows its file no longer carries (#63). Each row records the
 * `DateUpdate` of the file it was written from; once every row of the file is in, the
 * sync deletes the rows not stamped with it, on pages up to the one that carries the
 * checkpoint. File A holds 11,000 rows. File B, its next revision, withdraws 5,500 of
 * them (each row whose area code plus year is even, before 2025) and adds a year: 7,700
 * rows on two data pages. The cube also holds a drifted row no file carries, at a far
 * rowid, so the read of the rows B does not carry spans six rowid slices. A file whose
 * data CSV holds only its header removes nothing: FAO has shipped a header-only CSV,
 * a publishing fault rather than the withdrawal of a whole domain.
 */
describe('a refresh removes the rows its file no longer carries (#63)', () => {
  const DOMAIN = 'RL';
  const TABLE = `obs_${DOMAIN}`;
  const A = buildMidSizeDomainZip({ domain: DOMAIN, countryCount: 2200, years: 5 });
  const B = buildMidSizeDomainZip({
    domain: DOMAIN,
    countryCount: 2200,
    years: 6,
    omit: (area, year) => year < 2025 && (area + year) % 2 === 0,
  });
  const A_FILE = fixtureDataset(DOMAIN);
  const B_FILE: ManifestDataset = { ...A_FILE, DateUpdate: '2026-10-02T00:00:00', FileRows: 7700 };
  const B_IDS = [...B.ids].sort();
  const DRIFTED_ID = '9999|15|5510|1990';
  let dir: string;
  let mirror: FaostatMirror;
  let warnings: string[];
  /** The ZIP the stubbed bulk host serves. */
  let served: Uint8Array;
  const fetcher = vi.fn(async () => chunkedResponse(served, 1 << 16));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-refresh-removes-'));
    warnings = [];
    served = A.zip;
    vi.stubGlobal('fetch', fetcher);
    mirror = initFaostatMirror({
      dir,
      domains: [DOMAIN],
      log: { warning: (message) => warnings.push(message) },
    });
    await mirror.runDomainSync(DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: A_FILE,
    });
    // Past the 11,000 rowids A's rows take, so B's new rows land beyond it.
    (await mirror.getMirror(DOMAIN)!.raw())
      .prepare(
        `INSERT INTO ${TABLE}(rowid, id, area_code, item_code, element_code, year, value) VALUES (250000, ?, 9999, 15, 5510, 1990, 1)`,
      )
      .run(DRIFTED_ID);
    served = B.zip;
    fetcher.mockClear();
  }, 30_000);

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  function refresh(
    args: {
      dataset?: ManifestDataset;
      onProgress?: Parameters<FaostatMirror['runDomainSync']>[2]['onProgress'];
      signal?: AbortSignal;
    } = {},
  ) {
    return mirror.runDomainSync(DOMAIN, 'refresh', {
      signal: args.signal ?? new AbortController().signal,
      dataset: args.dataset ?? B_FILE,
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    });
  }

  /** Refresh against B and stop it once `at` holds after a page commits. */
  async function stoppedRefresh(
    at: (progress: {
      pages: number;
      tombstones: number;
      checkpoint?: string | undefined;
    }) => boolean,
  ): Promise<void> {
    const controller = new AbortController();
    const stopped = new Error('Stopped for shutdown');
    await expect(
      refresh({
        signal: controller.signal,
        onProgress: (progress) => {
          if (at(progress)) controller.abort(stopped);
        },
      }),
    ).rejects.toBe(stopped);
  }

  /** Every id the cube holds, sorted. */
  async function cubeIds(target = mirror): Promise<string[]> {
    return (await target.getMirror(DOMAIN)!.raw())
      .prepare<{ id: string }>(`SELECT id FROM ${TABLE} ORDER BY id`)
      .all()
      .map((row) => row.id);
  }

  /** The ids of `expected` the cube lacks. */
  async function missing(expected: string[]): Promise<string[]> {
    const present = new Set(await cubeIds());
    return expected.filter((id) => !present.has(id));
  }

  it('ends a refresh with exactly its file’s rows, the rows a fresh init of that file holds', async () => {
    expect(await refresh()).toMatchObject({
      recordsApplied: 7700,
      tombstonesApplied: 5501,
      total: 7700,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await cubeIds()).toEqual(B_IDS);
    expect(await mirror.status(DOMAIN)).toMatchObject({
      status: 'complete',
      ready: true,
      total: 7700,
      checkpoint: B_FILE.DateUpdate,
    });

    const freshDir = mkdtempSync(join(tmpdir(), 'faostat-refresh-fresh-'));
    const fresh = new FaostatMirror({ dir: freshDir, domains: [DOMAIN] });
    try {
      expect(
        await fresh.runDomainSync(DOMAIN, 'init', {
          signal: new AbortController().signal,
          dataset: B_FILE,
        }),
      ).toMatchObject({ tombstonesApplied: 0, total: 7700 });
      expect(await cubeIds(fresh)).toEqual(await cubeIds());
    } finally {
      await fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(fixtureManifestResponse([B_FILE]))),
    );
    const wire = await runToolContract(listDomainsTool, { code: DOMAIN });
    expect(wire.structuredContent).toMatchObject({
      domains: [
        { code: DOMAIN, index_ready: true, indexed_row_count: 7700, upstream_row_count: 7700 },
      ],
    });
    expect(text(wire)).toContain(`Local rows: ${(7700).toLocaleString()} (synced `);

    // Its unchanged upstream, refreshed again: nothing fetched, nothing removed.
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockClear();
    expect(await refresh()).toEqual({
      pagesFetched: 0,
      recordsApplied: 0,
      tombstonesApplied: 0,
      total: 7700,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await cubeIds()).toEqual(B_IDS);
  }, 30_000);

  it('removes rows only once every row of the file is in, on pages up to the one carrying the checkpoint', async () => {
    const handle = await mirror.getMirror(DOMAIN)!.raw();
    const held = handle.prepare<{ n: number }>(
      `SELECT count(*) AS n FROM ${TABLE} WHERE id IN (SELECT value FROM json_each(?))`,
    );
    const fileIds = JSON.stringify(B.ids);
    const pages: unknown[] = [];
    let seen = { records: 0, tombstones: 0 };
    await refresh({
      onProgress: ({ records, tombstones, checkpoint }) => {
        pages.push({
          records: records - seen.records,
          tombstones: tombstones - seen.tombstones,
          checkpoint: checkpoint === B_FILE.DateUpdate,
          holdsEveryFileRow: held.get(fileIds)?.n === B.total,
        });
        seen = { records, tombstones };
      },
    });
    expect(pages).toEqual([
      { records: 5000, tombstones: 0, checkpoint: false, holdsEveryFileRow: false },
      { records: 2700, tombstones: 0, checkpoint: false, holdsEveryFileRow: true },
      { records: 0, tombstones: 5000, checkpoint: false, holdsEveryFileRow: true },
      { records: 0, tombstones: 501, checkpoint: true, holdsEveryFileRow: true },
    ]);
  }, 30_000);

  it('ends with the file’s rows when a refresh stopped mid-stream is rerun', async () => {
    await stoppedRefresh(({ pages }) => pages === 1);
    // Nothing is removed before every row of the file is in.
    expect(await missing([...A.ids, DRIFTED_ID])).toEqual([]);
    expect(await mirror.status(DOMAIN)).toMatchObject({
      status: 'error',
      ready: true,
      checkpoint: A_FILE.DateUpdate,
    });

    expect(await refresh()).toMatchObject({ tombstonesApplied: 5501, total: 7700 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await cubeIds()).toEqual(B_IDS);
  }, 30_000);

  it('ends with the file’s rows when a refresh stopped during its removals is rerun', async () => {
    await stoppedRefresh(({ tombstones }) => tombstones > 0);
    // The first removal page committed: every row of the file stays, 501 stale rows remain.
    expect(await missing(B.ids)).toEqual([]);
    expect(await cubeIds()).toHaveLength(7700 + 501);

    expect(await refresh()).toMatchObject({ tombstonesApplied: 501, total: 7700 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await cubeIds()).toEqual(B_IDS);
  }, 30_000);

  it('ends with the file’s rows, fetching nothing, when a refresh stopped right after its checkpoint page is rerun', async () => {
    await stoppedRefresh(({ checkpoint }) => checkpoint === B_FILE.DateUpdate);
    expect(await cubeIds()).toEqual(B_IDS);
    // No completion committed, so the last completed total stands until a run completes.
    expect(await mirror.status(DOMAIN)).toMatchObject({
      status: 'error',
      ready: true,
      checkpoint: B_FILE.DateUpdate,
      total: 11000,
    });

    expect(await refresh()).toEqual({
      pagesFetched: 0,
      recordsApplied: 0,
      tombstonesApplied: 0,
      total: 7700,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await cubeIds()).toEqual(B_IDS);
  }, 30_000);

  it('reads the rows its file does not carry on the read pool, in rowid slices that cover the cube once', async () => {
    const all = vi.spyOn(mirror.reads, 'all');
    await refresh();
    const jobs = all.mock.calls.map(([job]) => job);
    const slices = jobs.filter((job) => job.sql.includes('file_date_update'));
    // Rowids 1–252,200: A's rows, the drifted row at 250,000, and B's new year past it.
    expect(slices.map((job) => job.params.slice(0, 2))).toEqual(
      [1, 50_001, 100_001, 150_001, 200_001, 250_001].map((from) => [from, from + 50_000]),
    );
    const handle = await mirror.getMirror(DOMAIN)!.raw();
    const plan = (job: (typeof jobs)[number]) =>
      handle
        .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${job.sql}`)
        .all(...job.params)
        .map((row) => row.detail)
        .join('\n');
    for (const job of slices) {
      expect(plan(job)).toContain('USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)');
    }
    const bounds = jobs.filter((job) => job.sql.includes('max(rowid)'));
    expect(bounds).toHaveLength(1);
    expect(plan(bounds[0]!)).not.toMatch(new RegExp(`SCAN ${TABLE}\\b`));
  }, 30_000);

  it('applies a file whose DateUpdate it cannot stamp, keeping the rows it cannot tell withdrawn and saying so', async () => {
    const UNSTAMPABLE: ManifestDataset = { ...B_FILE, DateUpdate: '2026-10-02' };
    expect(await refresh({ dataset: UNSTAMPABLE })).toMatchObject({
      recordsApplied: 7700,
      tombstonesApplied: 0,
      total: 7700 + 5500 + 1,
    });
    expect(warnings.filter((message) => message.includes('"2026-10-02"'))).toHaveLength(1);
    expect(await mirror.status(DOMAIN)).toMatchObject({
      status: 'complete',
      checkpoint: '2026-10-02',
    });

    // The next file it can stamp removes them.
    expect(await refresh()).toMatchObject({ tombstonesApplied: 5501, total: 7700 });
    expect(await cubeIds()).toEqual(B_IDS);
  }, 30_000);

  it.each([
    ['without', false],
    ['with', true],
  ])(
    'keeps every stored row when a refresh’s data file holds only its header, %s a final line break, until a file that carries rows removes what it does not carry',
    async (_, finalLineBreak) => {
      const HEADER_ONLY_FILE: ManifestDataset = {
        ...A_FILE,
        DateUpdate: '2026-07-01T00:00:00',
        FileRows: 0,
      };
      served = buildMidSizeDomainZip({
        domain: DOMAIN,
        countryCount: 2200,
        years: 5,
        omit: () => true,
        finalLineBreak,
      }).zip;
      const stored = await cubeIds();
      expect(stored).toHaveLength(11_001);
      warnings.length = 0;

      expect(await refresh({ dataset: HEADER_ONLY_FILE })).toMatchObject({
        recordsApplied: 0,
        tombstonesApplied: 0,
        total: 11_001,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await cubeIds()).toEqual(stored);
      expect(warnings).toEqual([
        `${DOMAIN} data file for DateUpdate "${HEADER_ONLY_FILE.DateUpdate}" carries no data rows, so this sync removes none of the rows the cube holds; the next file that carries rows removes those it does not carry`,
      ]);
      expect(await mirror.status(DOMAIN)).toMatchObject({
        status: 'complete',
        ready: true,
        total: 11_001,
        checkpoint: HEADER_ONLY_FILE.DateUpdate,
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(fixtureManifestResponse([HEADER_ONLY_FILE]))),
      );
      const wire = await runToolContract(listDomainsTool, { code: DOMAIN });
      expect(wire.structuredContent).toMatchObject({
        domains: [{ code: DOMAIN, index_ready: true, indexed_row_count: 11_001 }],
      });
      expect(text(wire)).toContain('Index ready: yes');
      expect(text(wire)).toContain(`Local rows: ${(11_001).toLocaleString()} (synced `);

      // The next file that carries rows removes every row it does not carry, and warns of nothing.
      vi.stubGlobal('fetch', fetcher);
      served = B.zip;
      expect(await refresh()).toMatchObject({
        recordsApplied: 7700,
        tombstonesApplied: 5501,
        total: 7700,
      });
      expect(await cubeIds()).toEqual(B_IDS);
      expect(warnings).toHaveLength(1);
    },
    30_000,
  );
});
