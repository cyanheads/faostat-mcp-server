/**
 * @fileoverview Isolated upgrade and round-trip coverage for FS/GLE bulk shapes, and
 * the upgrade that gives a cube its file stamp and reconciles its rows once (#63).
 * @module tests/services/observation-migration
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { openSqliteHandle, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { buildDomainZip, chunkedResponse, fixtureDataset } from '../fixtures/synthetic-domain.js';

const header =
  'Area Code,Area,Item Code,Item,Element Code,Element,Year Code,Year,Unit,Value,Flag,Source Code,Source';
function zip(domain: string, count = 1) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push(
      `${i},Country ${i},210401F,Food,6121,Prevalence,20002002,2000-2002,%,<2.5,E,3050,FAO TIER 1`,
    );
    rows.push(
      `${i},Country ${i},210401F,Food,6121,Prevalence,20002002,2000-2002,%,3.75,X,3051,UNFCCC`,
    );
  }
  return zipSync({
    [`${domain}_All_Data_(Normalized).csv`]: strToU8([header, ...rows].join('\r\n')),
    [`${domain}_ItemCodes.csv`]: strToU8('Item Code,Item\n210401F,Food'),
    [`${domain}_AreaCodes.csv`]: strToU8('Area Code,Area\n1,Country 1'),
    [`${domain}_Elements.csv`]: strToU8('Element Code,Element\n6121,Prevalence'),
  });
}
const signal = () => new AbortController().signal;
const text = (wire: Awaited<ReturnType<typeof runToolContract>>) =>
  wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('bulk identity upgrade', () => {
  let dir: string;
  let mirror: FaostatMirror | undefined;
  let canvas: ReturnType<typeof createCanvasService>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-identity-'));
  });
  afterEach(async () => {
    await mirror?.close();
    await canvas?.shutdown(createMockContext());
    setCanvas(undefined);
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  async function legacy(domain: string) {
    const store = sqliteMirrorStore({
      path: join(dir, `domain-${domain}.db`),
      table: `obs_${domain}`,
      primaryKey: 'id',
      columns: {
        id: 'TEXT',
        area_code: 'INTEGER',
        area_m49: 'TEXT',
        area: 'TEXT',
        item_code: 'INTEGER',
        item: 'TEXT',
        element_code: 'INTEGER',
        element: 'TEXT',
        year: 'INTEGER',
        unit: 'TEXT',
        value: 'REAL',
        flag: 'TEXT',
        note: 'TEXT',
      },
    });
    await store.applyBatch(
      [
        {
          id: '1|15|5510|2020',
          area_code: 1,
          item_code: 15,
          item: 'Wheat',
          element_code: 5510,
          year: 2020,
          value: 999,
          unit: 't',
        },
      ],
      [],
    );
    await store.writeState({
      status: 'complete',
      completedAt: '2020-01-01T00:00:00Z',
      checkpoint: fixtureDataset(domain).DateUpdate,
      total: 1,
    });
    await store.close();
  }

  it.each(['FS', 'GLE'])(
    'invalidates old %s readiness, retries replacement despite unchanged checkpoint, and removes legacy keys',
    async (domain) => {
      await legacy(domain);
      mirror = initFaostatMirror({ dir, domains: [domain] });
      expect(await mirror.ready(domain)).toBe(false);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503 })),
      );
      await expect(
        mirror.runDomainSync(domain, 'refresh', {
          signal: signal(),
          dataset: fixtureDataset(domain),
        }),
      ).rejects.toThrow();
      expect(await mirror.ready(domain)).toBe(false);
      expect((await mirror.status(domain))?.completedAt).toBeUndefined();
      // A prior interrupted attempt may have applied pages. The retry replaces those too.
      const handle = await mirror.getMirror(domain)!.raw();
      // Simulate a crash after framework completion but before revision publication.
      handle.exec(
        "UPDATE mirror_sync_state SET completed_at = '2020-01-01T00:00:00Z', status = 'complete'",
      );
      expect(await mirror.ready(domain)).toBe(false);
      expect((await mirror.status(domain))?.ready).toBe(false);
      handle.prepare(`INSERT INTO obs_${domain}(id, year) VALUES (?, ?)`).run('partial', 1900);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => chunkedResponse(zip(domain), 37)),
      );
      await mirror.runDomainSync(domain, 'refresh', {
        signal: signal(),
        dataset: fixtureDataset(domain),
      });
      expect(await mirror.ready(domain)).toBe(true);
      expect(
        handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM obs_${domain}`).get()?.n,
      ).toBe(2);
      expect(
        handle
          .prepare(`SELECT id FROM obs_${domain} WHERE id IN ('partial', '1|15|5510|2020')`)
          .all(),
      ).toEqual([]);
      await mirror.close();
      mirror = new FaostatMirror({ dir, domains: [domain] });
      expect(await mirror.ready(domain)).toBe(true);
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      await mirror.runDomainSync(domain, 'refresh', {
        signal: signal(),
        dataset: fixtureDataset(domain),
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('keeps compatible numeric domains readable without downloading and migrates legacy item FTS', async () => {
    await legacy('QCL');
    const dimensions = await openSqliteHandle(join(dir, 'dimensions.db'));
    dimensions.exec(
      "CREATE TABLE items(item_code INTEGER PRIMARY KEY NOT NULL, cpc_code TEXT, item TEXT NOT NULL); INSERT INTO items VALUES(15, '0111', 'Wheat')",
    );
    dimensions.close();
    mirror = initFaostatMirror({ dir, domains: ['QCL'] });
    vi.stubGlobal('fetch', vi.fn());
    expect(await mirror.ready('QCL')).toBe(true);
    const handle = await mirror.getMirror('QCL')!.raw();
    // The upgrade cleared the checkpoint for the one re-stream that stamps the rows
    // (#63); restored, the refresh below is a refresh of the unchanged upstream.
    handle
      .prepare('UPDATE mirror_sync_state SET checkpoint = ?')
      .run(fixtureDataset('QCL').DateUpdate);
    expect(
      handle
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE '%item_code_text%' OR name LIKE '%source_code%' OR name LIKE '%unit_element%')",
        )
        .all(),
    ).toEqual([]);
    const reads = vi.spyOn(mirror.reads, 'all');
    expect((await mirror.resolve('QCL', 'item', { query: 'wheat', limit: 1 })).matches).toEqual([
      { code: 15, code_text: null, name: 'Wheat', cpc_code: '0111', kind: null },
    ]);
    expect(reads.mock.calls[0]?.[0].sql).not.toContain('item_code_text');
    const rows = await mirror.queryObservations('QCL', {
      includeAggregates: true,
      limit: 10,
      offset: 0,
    });
    expect(rows.rows[0]).toMatchObject({
      item_code: 15,
      item_code_text: null,
      period: null,
      value_qualifier: null,
      source_code: null,
      source: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    await mirror.dimensions.upsertElements([{ element_code: 5510, element: 'Production' }]);
    expect((await mirror.resolve('QCL', 'element', { limit: 10 })).matches).toEqual([
      { code: 5510, code_text: null, name: 'Production', kind: null, units: ['t'] },
    ]);
    await mirror.runDomainSync('QCL', 'refresh', {
      signal: signal(),
      dataset: fixtureDataset('QCL'),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await mirror.ready('QCL')).toBe(true);
    // The plan of the distinct-code read the mirror itself sends once the refresh has
    // added the text index.
    reads.mockClear();
    await mirror.resolve('QCL', 'item', { limit: 1 });
    const itemCodesSql = reads.mock.calls[0]?.[0].sql;
    expect(itemCodesSql).toContain('item_code_text');
    const plan = handle.prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${itemCodesSql}`).all();
    expect(plan.some((r) => r.detail.includes('COVERING INDEX obs_QCL_item_code_idx'))).toBe(true);
    expect(plan.some((r) => r.detail.includes('COVERING INDEX obs_QCL_item_code_text_idx'))).toBe(
      true,
    );
    const unitPlan = handle
      .prepare<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT DISTINCT element_code, unit FROM obs_QCL INDEXED BY obs_QCL_unit_element_idx ORDER BY element_code, unit',
      )
      .all();
    expect(unitPlan.some((r) => r.detail.includes('COVERING INDEX obs_QCL_unit_element_idx'))).toBe(
      true,
    );
    reads.mockClear();
    expect((await mirror.resolve('QCL', 'element', { limit: 10 })).matches[0]?.units).toEqual([
      't',
    ]);
    expect(reads.mock.calls[0]?.[0].sql).not.toContain('NOT INDEXED');
    expect(reads.mock.calls[0]?.[0].sql).toContain('INDEXED BY obs_QCL_unit_element_idx');
  });

  it('repairs a compatible store’s item vocabulary on a refresh of its unchanged upstream, with no download (#64)', async () => {
    await legacy('QCL');
    mirror = initFaostatMirror({ dir, domains: ['QCL'] });
    const handle = await mirror.getMirror('QCL')!.raw();
    // The upgrade cleared the checkpoint for the one re-stream that stamps the rows
    // (#63); restored, the refresh below fetches no ZIP.
    handle
      .prepare('UPDATE mirror_sync_state SET checkpoint = ?')
      .run(fixtureDataset('QCL').DateUpdate);
    // A second identity whose only row carries no label.
    handle
      .prepare(
        'INSERT INTO obs_QCL(id, area_code, item_code, element_code, year) VALUES (?, ?, ?, ?, ?)',
      )
      .run('1|16|5510|2020', 1, 16, 5510, 2020);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await mirror.resolve('QCL', 'item', { limit: 10 })).toEqual({ matches: [], total: 0 });

    await mirror.runDomainSync('QCL', 'refresh', {
      signal: signal(),
      dataset: fixtureDataset('QCL'),
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(handle.prepare('SELECT revision FROM ingest_revision').all()).toEqual([{ revision: 2 }]);
    expect((await mirror.resolve('QCL', 'item', { limit: 10 })).matches).toEqual([
      { code: 15, code_text: null, name: 'Wheat', kind: null },
      { code: 16, code_text: null, name: '', kind: null },
    ]);
  });

  it('enables text membership before a compatible refresh can publish partial rows', async () => {
    await legacy('QCL');
    mirror = initFaostatMirror({ dir, domains: ['QCL'] });
    expect(await mirror.ready('QCL')).toBe(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    await expect(
      mirror.runDomainSync('QCL', 'refresh', {
        signal: signal(),
        dataset: { ...fixtureDataset('QCL'), DateUpdate: '2099-01-01' },
      }),
    ).rejects.toThrow();
    const handle = await mirror.getMirror('QCL')!.raw();
    handle
      .prepare('INSERT INTO obs_QCL(id, item_code_text, element_code, year) VALUES (?, ?, ?, ?)')
      .run('partial-alpha', '210401F', 6121, 2001);
    await mirror.dimensions.upsertItems([
      { item_code: null, item_code_text: '210401F', item: 'Food', cpc_code: null },
    ]);
    expect(await mirror.ready('QCL')).toBe(true);
    expect(
      (await mirror.resolve('QCL', 'item', { codeText: '210401F', limit: 1 })).matches,
    ).toEqual([{ code: null, code_text: '210401F', name: 'Food', kind: null }]);
  });

  async function sync(count = 1) {
    mirror = initFaostatMirror({ dir, domains: ['FS', 'QCL'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip('FS', count), 43)),
    );
    await mirror.runDomainSync('FS', 'init', { signal: signal(), dataset: fixtureDataset('FS') });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(buildDomainZip(), 43)),
    );
    await mirror.runDomainSync('QCL', 'init', { signal: signal(), dataset: fixtureDataset() });
  }

  it('round-trips exact identities, source filters, midpoint bounds and resolver paging through both surfaces', async () => {
    await sync();
    for (const selector of [
      { code_text: '210401F' },
      { query: 'food' },
      { name_contains: 'ood' },
      {},
    ]) {
      const wire = await runToolContract(resolveCodesTool, {
        domain: 'FS',
        dimension: 'item',
        ...selector,
      });
      expect(wire.isError).toBeFalsy();
      expect(wire.structuredContent).toMatchObject({
        matches: [{ code: null, code_text: '210401F', name: 'Food' }],
      });
      expect(text(wire)).toContain('210401F');
    }
    const other = await mirror!.resolve('QCL', 'item', { codeText: '210401F', limit: 1 });
    expect(other).toEqual({ matches: [], total: 0 });
    const past = await runToolContract(resolveCodesTool, {
      domain: 'FS',
      dimension: 'item',
      offset: 1,
      limit: 1,
    });
    expect(past.structuredContent).toMatchObject({
      matches: [],
      totalMatches: 1,
      truncated: false,
    });
    expect(text(past)).toContain('past');
    const wire = await runToolContract(queryObservationsTool, {
      domain: 'FS',
      item_codes_text: ['210401F'],
      source_codes: [3050],
      year_start: 2001,
      year_end: 2001,
    });
    expect(wire.isError).toBeFalsy();
    expect(wire.structuredContent).toMatchObject({
      observations: [
        {
          item_code: null,
          item_code_text: '210401F',
          year: 2001,
          period: '2000-2002',
          value: 2.5,
          value_qualifier: '<',
          source_code: 3050,
          source: 'FAO TIER 1',
          flag: 'E',
        },
      ],
    });
    for (const token of ['210401F', '2000-2002', '<2.5', 'FAO TIER 1', '3050', 'E'])
      expect(text(wire)).toContain(token);
    for (const filter of [
      { source_codes: [999] },
      { source_codes: [] },
      { item_codes_text: [] },
      { item_codes: [210401] },
      { year_end: 2000 },
    ]) {
      const empty = await runToolContract(queryObservationsTool, { domain: 'FS', ...filter });
      expect(empty.structuredContent).toMatchObject({ observations: [], totalCount: 0 });
      expect(text(empty)).toContain('No observations');
    }
    const page = await mirror!.queryObservations('FS', {
      includeAggregates: true,
      limit: 1,
      offset: 0,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.totalIsExact).toBe(false);
    expect(
      (await mirror!.queryObservations('FS', { includeAggregates: true, limit: 1, offset: 2 }))
        .rows,
    ).toEqual([]);
    for (const [definition, input, reason] of [
      [
        queryObservationsTool,
        { domain: 'FS', item_codes: [15], item_codes_text: ['210401F'] },
        'conflicting_item_selectors',
      ],
      [
        resolveCodesTool,
        { domain: 'FS', dimension: 'item', code: 15, code_text: '210401F' },
        'invalid_text_selector',
      ],
      [
        resolveCodesTool,
        { domain: 'FS', dimension: 'area', code_text: '210401F' },
        'invalid_text_selector',
      ],
    ] as const) {
      const failure =
        'item_codes' in input
          ? await runToolContract(queryObservationsTool, {
              domain: 'FS',
              item_codes: [...input.item_codes],
              item_codes_text: [...input.item_codes_text],
            })
          : await runToolContract(definition, input);
      expect(failure.isError).toBe(true);
      expect(failure.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: expect.any(String) } } },
      });
      expect(text(failure)).toContain(reason);
    }
    expect(
      queryObservationsTool.input.safeParse({ domain: 'FS', item_codes_text: ['15'] }).success,
    ).toBe(false);
  });

  it('declares and preserves new fields in staged SQL and source-selection provenance', async () => {
    await sync(60);
    canvas = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
    if (!canvas) throw new Error('DuckDB canvas required');
    setCanvas(canvas);
    const ctx = createMockContext({
      tenantId: 'source-stage',
      errors: [
        ...queryObservationsTool.errors!,
        ...dataframeDescribeTool.errors!,
        ...dataframeQueryTool.errors!,
      ],
    });
    const result = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({
        domain: 'FS',
        item_codes_text: ['210401F'],
        source_codes: [3050],
        limit: 1,
      }),
      ctx,
    );
    expect(result.spilled).toBe(true);
    expect(result.staged_row_count).toBe(60);
    expect(JSON.stringify(queryObservationsTool.format!(result))).toContain('<2.5');
    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ canvas_id: result.canvas_id, name: result.table_name }),
      ctx,
    );
    expect(described.tables[0]?.query_params).toMatchObject({
      item_codes_text: ['210401F'],
      source_codes: [3050],
    });
    const sql = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({
        canvas_id: result.canvas_id,
        sql: `SELECT item_code, item_code_text, period, year, value, value_qualifier, source_code, source, flag FROM ${result.table_name} LIMIT 1`,
      }),
      ctx,
    );
    expect(sql.rows[0]).toEqual({
      item_code: null,
      item_code_text: '210401F',
      period: '2000-2002',
      year: '2001',
      value: 2.5,
      value_qualifier: '<',
      source_code: '3050',
      source: 'FAO TIER 1',
      flag: 'E',
    });
  });
});

describe('file stamp upgrade (#63)', () => {
  const DOMAIN = 'QCL';
  const TABLE = `obs_${DOMAIN}`;
  /** A row an earlier file carried that the fixture file does not. */
  const DRIFTED_ID = '2|15|5510|2019';
  let dir: string;
  let mirror: FaostatMirror | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-file-stamp-'));
  });
  afterEach(async () => {
    await mirror?.close();
    mirror = undefined;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Sync the fixture file into a QCL store and close it; returns its file path. */
  async function syncedStore(): Promise<string> {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(buildDomainZip(), 43)),
    );
    const synced = new FaostatMirror({ dir, domains: [DOMAIN] });
    await synced.runDomainSync(DOMAIN, 'init', { signal: signal(), dataset: fixtureDataset() });
    await synced.close();
    return join(dir, `domain-${DOMAIN}.db`);
  }

  /**
   * The store as the release before the stamp left it — schema version 2, no stamp
   * column, no statistics flag — holding a drifted row that release's refreshes kept.
   * Returns its sync state.
   */
  async function releasedStore(): Promise<unknown> {
    const handle = await openSqliteHandle(await syncedStore());
    try {
      const columns = handle
        .prepare<{ name: string }>(`SELECT name FROM pragma_table_info('${TABLE}')`)
        .all()
        .map((c) => c.name);
      if (columns.includes('file_date_update'))
        handle.exec(`ALTER TABLE ${TABLE} DROP COLUMN file_date_update`);
      handle.exec('DROP TABLE IF EXISTS planner_statistics');
      handle.exec('UPDATE schema_version SET version = 2');
      handle
        .prepare(
          `INSERT INTO ${TABLE}(id, area_code, area, item_code, item, element_code, element, year, unit, value, flag) VALUES (?, 2, 'Afghanistan', 15, 'Wheat', 5510, 'Production', 2019, 't', 4800, 'A')`,
        )
        .run(DRIFTED_ID);
      return handle
        .prepare('SELECT status, checkpoint, completed_at, total FROM mirror_sync_state')
        .get();
    } finally {
      handle.close();
    }
  }

  const state = (handle: Awaited<ReturnType<typeof openSqliteHandle>>) =>
    handle.prepare('SELECT status, checkpoint, completed_at, total FROM mirror_sync_state').get();
  const cubeIds = (handle: Awaited<ReturnType<typeof openSqliteHandle>>) =>
    handle
      .prepare<{ id: string }>(`SELECT id FROM ${TABLE} ORDER BY id`)
      .all()
      .map((row) => row.id);
  const FILE_IDS = [
    '2|15|5510|2020',
    '2|15|5510|2021',
    '351|15|5510|2020',
    '351|15|5510|2021',
    '5000|15|5510|2020',
    '5000|15|5510|2021',
  ];

  it('adds the stamp to a store from before it and clears only its checkpoint, so the domain stays ready', async () => {
    const before = await releasedStore();
    expect(before).toMatchObject({
      status: 'complete',
      checkpoint: fixtureDataset().DateUpdate,
      total: 6,
    });
    mirror = new FaostatMirror({ dir, domains: [DOMAIN] });
    expect(await mirror.ready(DOMAIN)).toBe(true);
    const handle = await mirror.getMirror(DOMAIN)!.raw();
    expect(state(handle)).toEqual({ ...(before as object), checkpoint: null });
    expect(
      handle
        .prepare(`SELECT name, type FROM pragma_table_info('${TABLE}') WHERE name = ?`)
        .all('file_date_update'),
    ).toEqual([{ name: 'file_date_update', type: 'INTEGER' }]);
    // None of its rows carries a stamp, so its next refresh streams the file again.
    expect(
      handle.prepare(`SELECT count(*) AS n FROM ${TABLE} WHERE file_date_update IS NULL`).get(),
    ).toEqual({ n: 7 });
  });

  it('keeps the checkpoint of a store whose rows already carry the stamp', async () => {
    const handle = await openSqliteHandle(await syncedStore());
    const before = state(handle);
    handle.exec('UPDATE schema_version SET version = 3');
    handle.close();
    mirror = new FaostatMirror({ dir, domains: [DOMAIN] });
    expect(state(await mirror.getMirror(DOMAIN)!.raw())).toEqual(before);
    expect(before).toMatchObject({ checkpoint: fixtureDataset().DateUpdate });
  });

  it('removes a drifted store’s stale rows on its first refresh after upgrade, ready throughout, then fetches nothing', async () => {
    await releasedStore();
    mirror = new FaostatMirror({ dir, domains: [DOMAIN] });
    const fetcher = vi.fn(async () => chunkedResponse(buildDomainZip(), 43));
    vi.stubGlobal('fetch', fetcher);
    const readiness: Promise<boolean>[] = [];
    const upgraded = mirror;
    // The upstream file is unchanged: its DateUpdate is the checkpoint the store had.
    const refresh = () =>
      upgraded.runDomainSync(DOMAIN, 'refresh', {
        signal: signal(),
        dataset: fixtureDataset(),
        onProgress: () => readiness.push(upgraded.ready(DOMAIN)),
      });

    expect(await refresh()).toEqual({
      pagesFetched: 2,
      recordsApplied: 6,
      tombstonesApplied: 1,
      total: 6,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await Promise.all(readiness)).toEqual([true, true]);
    const handle = await upgraded.getMirror(DOMAIN)!.raw();
    expect(cubeIds(handle)).toEqual(FILE_IDS);
    expect(await upgraded.status(DOMAIN)).toMatchObject({
      status: 'complete',
      ready: true,
      total: 6,
      checkpoint: fixtureDataset().DateUpdate,
    });

    fetcher.mockClear();
    expect(await refresh()).toEqual({
      pagesFetched: 0,
      recordsApplied: 0,
      tombstonesApplied: 0,
      total: 6,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(cubeIds(handle)).toEqual(FILE_IDS);
  });
});
