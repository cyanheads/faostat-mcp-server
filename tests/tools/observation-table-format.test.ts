/**
 * @fileoverview Markdown table escaping in the observation tables (#27).
 * `faostat_query_observations` and the production-trend table of
 * `faostat_commodity_profile` interpolated mirror labels straight into table rows:
 * a `|` split the row and shifted every later column, a raw CR/LF ended it, and a
 * `\` before a `|` was consumed as an escape. Both now pass every interpolated
 * text cell through the same `markdownCell()` `faostat_dataframe_query` uses.
 *
 * The contract these lock: one result row renders as one table row with exactly as
 * many cells as the header, each cell displays the value as written (CR/LF as
 * their escape sequences), rows with ordinary labels render byte-identical to the
 * unescaped rendering, and `structuredContent` keeps the raw values.
 * @module tests/tools/observation-table-format
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildExplicitDomainZip,
  chunkedResponse,
  type ExplicitObservation,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';
import { renderCell, splitRow, tableLines } from '../helpers/markdown-table.js';

type QueryResult = Parameters<NonNullable<typeof queryObservationsTool.format>>[0];
type Observation = QueryResult['observations'][number];
type ProfileResult = Parameters<NonNullable<typeof commodityProfileTool.format>>[0];
type TrendPoint = ProfileResult['production_trend'][number];

const OBSERVATION_HEADER = '| Area | Item | Element | Year | Value | Unit | Flag |';
const TREND_HEADER = '| Year | Value | Unit | Observations | Flags |';

/** What a cell displays for `value`: the text itself, with CR/LF as their escape sequences. */
const displayed = (value: string) => value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');

const text = (content: { type: string; text?: string }[] | undefined) =>
  (content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');

function observation(overrides: Partial<Observation>): Observation {
  return {
    area_code: 2,
    area: 'Afghanistan',
    item_code: 15,
    item: 'Wheat',
    element_code: 5510,
    element: 'Production',
    year: 2020,
    value: 5000,
    unit: 't',
    flag: 'A',
    ...overrides,
  };
}

const renderObservations = (observations: Observation[]) =>
  text(
    queryObservationsTool.format?.({
      domain: 'QCL',
      observations,
      spilled: false,
      truncated: false,
    }),
  );

function point(overrides: Partial<TrendPoint>): TrendPoint {
  return { year: 2020, value: 1234567.5, observations: 3, unit: 't', flags: 'A, E', ...overrides };
}

const renderTrend = (production_trend: TrendPoint[]) =>
  text(
    commodityProfileTool.format?.({
      item_query: 'wheat',
      resolved_items: [{ code: 15, name: 'Wheat' }],
      top_producers: [],
      top_exporters: [],
      top_importers: [],
      production_trend,
      trend_points: production_trend.reduce((sum, p) => sum + p.observations, 0),
      spilled: false,
      truncated: false,
    }),
  );

describe('faostat_query_observations table rows (#27)', () => {
  it('renders ordinary labels exactly as before', () => {
    const rendered = renderObservations([
      observation({}),
      observation({
        area_code: 107,
        area: "Côte d'Ivoire",
        year: 2021,
        value: 1.5,
        flag: 'E',
      }),
      observation({ area_code: 3, area: 'Albania', value: null, unit: null, flag: null }),
    ]);
    expect(tableLines(rendered, OBSERVATION_HEADER)).toEqual([
      OBSERVATION_HEADER,
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| Afghanistan (2) | Wheat (15) | Production (5510) | 2020 | 5000 | t | A |',
      "| Côte d'Ivoire (107) | Wheat (15) | Production (5510) | 2021 | 1.5 | t | E |",
      '| Albania (3) | Wheat (15) | Production (5510) | 2020 |  |  |  |',
    ]);
  });

  it('keeps every row at seven cells and displays each label as written', () => {
    const observations = [
      observation({ area_code: 1, area: 'Pipe | Land' }),
      observation({ area_code: 2, item: 'x\\|y' }),
      observation({ area_code: 3, element: 'Line1\nLine2' }),
      observation({ area_code: 4, area: 'Carriage\rReturn', unit: 'kg\\ha' }),
      observation({ area_code: 5, unit: 't|ha', flag: 'A|E' }),
    ];
    const lines = tableLines(renderObservations(observations), OBSERVATION_HEADER);

    // Header + delimiter + one line per observation — no row ended early.
    expect(lines).toHaveLength(2 + observations.length);
    observations.forEach((o, i) => {
      const cells = splitRow(lines[2 + i] ?? '').map(renderCell);
      expect(cells).toEqual([
        `${displayed(o.area)} (${o.area_code})`,
        `${displayed(o.item)} (${o.item_code})`,
        `${displayed(o.element)} (${o.element_code})`,
        String(o.year),
        String(o.value),
        displayed(o.unit ?? ''),
        displayed(o.flag ?? ''),
      ]);
    });
  });
});

describe('faostat_commodity_profile production-trend rows (#27)', () => {
  it('renders ordinary rows exactly as before, toLocaleString values included', () => {
    const rendered = renderTrend([
      point({}),
      point({ year: 2021, value: 42, observations: 1, unit: null, flags: null }),
    ]);
    expect(tableLines(rendered, TREND_HEADER)).toEqual([
      TREND_HEADER,
      '| --- | --- | --- | --- | --- |',
      `| 2020 | ${(1234567.5).toLocaleString()} | t | 3 | A, E |`,
      `| 2021 | ${(42).toLocaleString()} |  | 1 |  |`,
    ]);
  });

  it('keeps every row at five cells and displays unit and flags as written', () => {
    const points = [
      point({ year: 2020, unit: 'kg|ha' }),
      point({ year: 2021, unit: 'x\\|y', flags: 'A|E' }),
      point({ year: 2022, unit: 'Line1\nLine2', flags: 'B\r' }),
      point({ year: 2023, unit: 'C:\\t' }),
    ];
    const lines = tableLines(renderTrend(points), TREND_HEADER);

    expect(lines).toHaveLength(2 + points.length);
    points.forEach((p, i) => {
      const cells = splitRow(lines[2 + i] ?? '').map(renderCell);
      expect(cells).toEqual([
        String(p.year),
        renderCell(p.value.toLocaleString()),
        displayed(p.unit ?? ''),
        String(p.observations),
        displayed(p.flags ?? ''),
      ]);
    });
  });
});

describe('faostat_dataframe_query rendering is unchanged by the shared helper (#27)', () => {
  it('renders a mixed result byte-identically', () => {
    const rendered = text(
      dataframeQueryTool.format?.({
        columns: ['area', 'value', 'meta', 'note'],
        row_count: 2,
        rows: [
          { area: 'x\\|y', value: 1.5, meta: { a: 'b|c' }, note: 'l1\r\nl2' },
          { area: 'Plain', value: null, meta: null, note: undefined },
        ],
        truncated: false,
      }),
    );
    expect(rendered).toBe(
      [
        '**2 rows**\n',
        '| area | value | meta | note |',
        '| --- | --- | --- | --- |',
        '| x\\\\\\|y | 1.5 | {"a":"b\\|c"} | l1\\r\\nl2 |',
        '| Plain |  |  |  |',
      ].join('\n'),
    );
  });
});

describe('structuredContent keeps raw labels (#27)', () => {
  let dir: string | undefined;
  let mirror: FaostatMirror | undefined;

  /** Sync a QCL mirror holding exactly `observations`. */
  async function sync(observations: ExplicitObservation[]): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'faostat-table-format-'));
    const zip = buildExplicitDomainZip(observations);
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

  afterEach(async () => {
    await mirror?.close();
    mirror = undefined;
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const PIPED = {
    areaCode: 7,
    area: 'Pipe | Land',
    itemCode: 15,
    item: 'Wheat',
    elementCode: 5510,
    element: 'Production',
    unit: 'kg|ha',
    year: 2020,
    value: 1.5,
    flag: 'A',
  } satisfies ExplicitObservation;

  it('faostat_query_observations: raw in structuredContent, escaped in content[]', async () => {
    await sync([PIPED]);
    const ctx = createMockContext({ tenantId: 'table-raw', errors: queryObservationsTool.errors });
    const result = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({ domain: FIXTURE_DOMAIN }),
      ctx,
    );

    expect(result.observations).toEqual([
      expect.objectContaining({ area: 'Pipe | Land', unit: 'kg|ha', flag: 'A' }),
    ]);
    const lines = tableLines(text(queryObservationsTool.format?.(result)), OBSERVATION_HEADER);
    expect(lines[2]).toBe(
      '| Pipe \\| Land (7) | Wheat (15) | Production (5510) | 2020 | 1.5 | kg\\|ha | A |',
    );
    // format() escaped a copy — the result it rendered still carries the raw label.
    expect(result.observations[0]?.area).toBe('Pipe | Land');
  });

  it('faostat_commodity_profile: raw trend unit in structuredContent, escaped in content[]', async () => {
    await sync([PIPED]);
    const ctx = createMockContext({ tenantId: 'trend-raw', errors: commodityProfileTool.errors });
    const result = await commodityProfileTool.handler(
      commodityProfileTool.input.parse({ item_query: 'wheat' }),
      ctx,
    );

    expect(result.production_trend).toEqual([
      expect.objectContaining({ year: 2020, value: 1.5, unit: 'kg|ha', flags: 'A' }),
    ]);
    const lines = tableLines(text(commodityProfileTool.format?.(result)), TREND_HEADER);
    expect(splitRow(lines[2] ?? '').map(renderCell)).toEqual([
      '2020',
      (1.5).toLocaleString(),
      'kg|ha',
      '1',
      'A',
    ]);
    expect(result.production_trend[0]?.unit).toBe('kg|ha');
  });
});
