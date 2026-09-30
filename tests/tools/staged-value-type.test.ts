/**
 * @fileoverview Staged `value` column type (#30). The staging layer used to let the
 * framework infer each column's type from the rows it had already buffered — the
 * inline preview window. Only `value` depends on that window: whole numbers typed
 * it BIGINT, an all-null window typed it VARCHAR, and the DuckDB appender then
 * coerced every later row to that type without an error. Rows stream
 * `ORDER BY year`, so a series whose early years hold whole numbers had every later
 * fractional value truncated on the staged table.
 *
 * The contract these lock: `value` is staged DOUBLE whatever the preview window
 * holds, on the char-budget spill path and the buffered `limit` path alike, for
 * both `faostat_query_observations` tables and `faostat_commodity_profile` tables
 * (production and trade rows), and every other column keeps its name, position,
 * and type. Each case runs a real domain sync into a temp SQLite mirror and reads
 * the staged table back through `faostat_dataframe_describe` and
 * `faostat_dataframe_query`.
 * @module tests/tools/staged-value-type
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildExplicitDomainZip,
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** The ten observation columns, in staged order, with the types every table carries. */
const OBSERVATION_COLUMNS = [
  ['area_code', 'BIGINT'],
  ['area', 'VARCHAR'],
  ['item_code', 'BIGINT'],
  ['item', 'VARCHAR'],
  ['element_code', 'BIGINT'],
  ['element', 'VARCHAR'],
  ['year', 'BIGINT'],
  ['unit', 'VARCHAR'],
  ['value', 'DOUBLE'],
  ['flag', 'VARCHAR'],
];

/**
 * 600 countries × 4 years (2020–2023). The first 1,200 rows in stream order — every
 * 2020 and 2021 row — serialize past the 100k-char preview budget on their own, so
 * the preview window and the overflow row both come from those two years.
 */
const COUNTRIES = 600;
const YEARS = 4;
const FIRST_LATE_YEAR = 2022;

/** Whole numbers through 2021, a quarter added from 2022 (exact in binary, so sums are exact). */
const wholeThenFractional = (areaCode: number, year: number) =>
  year < FIRST_LATE_YEAR ? 1000 + areaCode : 1000 + areaCode + 0.25;

/** Empty values through 2021, fractional from 2022. */
const nullThenFractional = (areaCode: number, year: number) =>
  year < FIRST_LATE_YEAR ? null : 1000 + areaCode + 0.25;

let canvas: DataCanvas;

/** One context carrying all four tools' contracts — staging, describe, and SQL share it. */
const makeCtx = (tenantId: string) =>
  createMockContext({
    tenantId,
    errors: [
      ...(queryObservationsTool.errors ?? []),
      ...(commodityProfileTool.errors ?? []),
      ...(dataframeDescribeTool.errors ?? []),
      ...(dataframeQueryTool.errors ?? []),
    ],
  });

type Ctx = ReturnType<typeof makeCtx>;

/** The staged table's `column_schema` as `[name, type]` pairs, in registered order. */
async function stagedColumns(ctx: Ctx, tableName: string | undefined) {
  const described = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse({ name: tableName }),
    ctx,
  );
  return (described.tables[0]?.column_schema ?? []).map((c) => [c.name, c.type]);
}

/** Run SQL through `faostat_dataframe_query` and return its structuredContent rows. */
async function sql(ctx: Ctx, statement: string) {
  const result = await dataframeQueryTool.handler(
    dataframeQueryTool.input.parse({ sql: statement }),
    ctx,
  );
  return result.rows;
}

beforeAll(() => {
  const cfg = parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' });
  const built = createCanvasService(cfg);
  if (!built) throw new Error('expected a DuckDB canvas to be constructed for the test');
  canvas = built;
  setCanvas(canvas);
});

afterAll(async () => {
  setCanvas(undefined);
  await canvas.shutdown(createMockContext({ tenantId: 'teardown' }));
});

describe('faostat_query_observations stages value as DOUBLE (#30)', () => {
  let dir: string;
  let mirror: FaostatMirror | undefined;

  async function syncDomain(opts: Parameters<typeof buildMidSizeDomainZip>[0]): Promise<void> {
    const { zip } = buildMidSizeDomainZip(opts);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
  }

  /** Every row of the synthetic domain, unfiltered (the codes include real roll-ups). */
  const everyRow = (extra: Record<string, unknown> = {}) =>
    queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      include_aggregates: true,
      ...extra,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-value-type-'));
  });

  afterEach(async () => {
    await mirror?.close();
    mirror = undefined;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps fractional values past a whole-number preview window (spill path)', async () => {
    await syncDomain({ countryCount: COUNTRIES, years: YEARS, value: wholeThenFractional });
    const ctx = makeCtx('value-spill');

    const staged = await queryObservationsTool.handler(everyRow(), ctx);
    expect(staged.spilled).toBe(true);
    expect(staged.truncated).toBe(false);
    expect(staged.staged_row_count).toBe(COUNTRIES * YEARS);
    // The inline preview really is whole-number only — the window the old
    // inference typed the column from.
    expect(staged.observations.every((o) => Number.isInteger(o.value))).toBe(true);

    expect(await stagedColumns(ctx, staged.table_name)).toEqual(OBSERVATION_COLUMNS);

    // A fractional value from a year past the window reads back unchanged.
    const [late] = await sql(
      ctx,
      `SELECT value FROM ${staged.table_name} WHERE area_code = 7 AND year = 2023`,
    );
    expect(late?.value).toBe(1007.25);

    // Every fractional row survived, and the column total matches the source.
    let expectedSum = 0;
    for (let i = 1; i <= COUNTRIES; i++) {
      for (let y = 0; y < YEARS; y++) expectedSum += wholeThenFractional(i, 2020 + y);
    }
    const [totals] = await sql(
      ctx,
      `SELECT SUM(value) AS total, COUNT(*) FILTER (WHERE value <> FLOOR(value)) AS fractional FROM ${staged.table_name}`,
    );
    expect(totals?.total).toBe(expectedSum);
    expect(Number(totals?.fractional)).toBe(COUNTRIES * (2020 + YEARS - FIRST_LATE_YEAR));
  }, 30_000);

  it('stages DOUBLE, not VARCHAR, when the preview window holds only null values', async () => {
    await syncDomain({ countryCount: COUNTRIES, years: YEARS, value: nullThenFractional });
    const ctx = makeCtx('value-null-window');

    const staged = await queryObservationsTool.handler(everyRow(), ctx);
    expect(staged.spilled).toBe(true);
    expect(staged.observations.every((o) => o.value === null)).toBe(true);

    expect(await stagedColumns(ctx, staged.table_name)).toEqual(OBSERVATION_COLUMNS);

    // Later values come back as numbers, not their string form.
    const [late] = await sql(
      ctx,
      `SELECT value FROM ${staged.table_name} WHERE area_code = 7 AND year = 2023`,
    );
    expect(late?.value).toBe(1007.25);
    const [counts] = await sql(
      ctx,
      `SELECT COUNT(*) AS n, COUNT(value) AS valued FROM ${staged.table_name}`,
    );
    expect(Number(counts?.n)).toBe(COUNTRIES * YEARS);
    expect(Number(counts?.valued)).toBe(COUNTRIES * (2020 + YEARS - FIRST_LATE_YEAR));
  }, 30_000);

  it('stages DOUBLE on the buffered path when every row is a whole number', async () => {
    // 300 whole-number rows fit the char budget but exceed the default limit (200),
    // so the buffered set is registered rather than spilled.
    await syncDomain({ countryCount: 300 });
    const ctx = makeCtx('value-buffered');

    const staged = await queryObservationsTool.handler(everyRow(), ctx);
    expect(staged.spilled).toBe(true);
    expect(staged.observations).toHaveLength(200);
    expect(staged.staged_row_count).toBe(300);

    expect(await stagedColumns(ctx, staged.table_name)).toEqual(OBSERVATION_COLUMNS);
    const [row] = await sql(
      ctx,
      `SELECT value, typeof(value) AS t FROM ${staged.table_name} WHERE area_code = 250`,
    );
    expect(row).toEqual({ value: 1250, t: 'DOUBLE' });
  });
});

describe('faostat_commodity_profile stages value as DOUBLE under both domains (#30)', () => {
  let dir: string;
  let mirror: FaostatMirror | undefined;

  const TCL = 'TCL';
  const WHEAT = { itemCode: 15, item: 'Wheat' } as const;
  /** Trade rows for two countries QCL also carries, every value fractional. */
  const TRADE = [
    {
      areaCode: 7,
      area: 'Country 7',
      elementCode: 5910,
      element: 'Export quantity',
      year: 2022,
      value: 12.5,
    },
    {
      areaCode: 7,
      area: 'Country 7',
      elementCode: 5610,
      element: 'Import quantity',
      year: 2023,
      value: 7.75,
    },
    {
      areaCode: 8,
      area: 'Country 8',
      elementCode: 5910,
      element: 'Export quantity',
      year: 2023,
      value: 3.25,
    },
  ];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-value-type-profile-'));
    const qcl = buildMidSizeDomainZip({
      countryCount: COUNTRIES,
      years: YEARS,
      value: wholeThenFractional,
    }).zip;
    const tcl = buildExplicitDomainZip(
      TRADE.map((t) => ({ ...t, ...WHEAT })),
      TCL,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        chunkedResponse(String(url).includes(`_${TCL}_`) ? tcl : qcl, 1 << 16),
      ),
    );
    mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN, TCL] });
    for (const domain of [FIXTURE_DOMAIN, TCL]) {
      await mirror.runDomainSync(domain, 'init', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(domain),
      });
    }
  });

  afterEach(async () => {
    await mirror?.close();
    mirror = undefined;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads fractional production and trade rows back unchanged', async () => {
    const ctx = makeCtx('value-profile');
    const result = await commodityProfileTool.handler(
      commodityProfileTool.input.parse({ item_query: 'wheat' }),
      ctx,
    );
    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(false);
    // Trade contributed, so the table holds both domains.
    expect(result.top_exporters.length).toBeGreaterThan(0);

    // Same ten columns, same order, plus `domain` last.
    expect(await stagedColumns(ctx, result.table_name)).toEqual([
      ...OBSERVATION_COLUMNS,
      ['domain', 'VARCHAR'],
    ]);

    const trade = await sql(
      ctx,
      `SELECT area_code, element_code, year, value FROM ${result.table_name} WHERE domain = 'TCL' ORDER BY area_code, year`,
    );
    // BIGINT columns come back as strings (precision-safe); value is DOUBLE, a number.
    expect(
      trade.map((r) => ({
        area_code: Number(r.area_code),
        element_code: Number(r.element_code),
        year: Number(r.year),
        value: r.value,
      })),
    ).toEqual(
      TRADE.map((t) => ({
        area_code: t.areaCode,
        element_code: t.elementCode,
        year: t.year,
        value: t.value,
      })),
    );
    const [production] = await sql(
      ctx,
      `SELECT value FROM ${result.table_name} WHERE domain = 'QCL' AND area_code = 7 AND year = 2023`,
    );
    expect(production?.value).toBe(1007.25);

    // Every fractional row under each domain survived. The profile is country-only,
    // so QCL's two sub-threshold roll-up codes (265, 351) are not on the table.
    const fractional = await sql(
      ctx,
      `SELECT domain, COUNT(*) AS n FROM ${result.table_name} WHERE value <> FLOOR(value) GROUP BY domain ORDER BY domain`,
    );
    expect(fractional.map((r) => [r.domain, Number(r.n)])).toEqual([
      ['QCL', (COUNTRIES - 2) * (2020 + YEARS - FIRST_LATE_YEAR)],
      ['TCL', TRADE.length],
    ]);
  }, 30_000);
});
