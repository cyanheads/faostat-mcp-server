/**
 * @fileoverview `faostat_query_observations` input-validation regression (#12). An
 * explicitly-empty code array must mean "match nothing", never silently broaden to
 * the whole dimension — the mirror's own `.length` guard (in both queryObservations
 * and streamObservations) would drop an empty array and query everything, so the
 * handler short-circuits to a zero-match success before any mirror call. A reversed
 * year range must fail with the declared `invalid_year_range` error rather than the
 * generic empty-result notice; equal bounds stay a valid single-year query. Runs a
 * real domain sync into a temp SQLite mirror (no canvas — these paths return before
 * any spill decision). A lowercase letter in an `item_codes_text` entry reads as the
 * stored uppercase identity in the page, the count, staging, and available elements
 * (#68); that block stages onto a real DuckDB canvas.
 * @module tests/tools/query-observations-validation
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
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
      const text = (queryObservationsTool.format?.(result) ?? [])
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

describe('faostat_query_observations text identities in any letter case (#68)', () => {
  const header =
    'Area Code,Area,Item Code,Item,Element Code,Element,Year Code,Year,Unit,Value,Flag,Source Code,Source';
  /** FS-shaped cube: two text items × three countries × 2021–2022, one element. */
  function textIdentityZip() {
    const rows: string[] = [];
    for (const item of ['210400F', '210400M'])
      for (const area of [1, 2, 3])
        for (const year of [2021, 2022])
          rows.push(
            `${area},Country ${area},${item},Severe ${item},6121,Value,${year},${year},%,${area + year / 1000},E,3050,FAO`,
          );
    return zipSync({
      'FS_All_Data_(Normalized).csv': strToU8([header, ...rows].join('\r\n')),
      'FS_ItemCodes.csv': strToU8('Item Code,Item\n210400F,Severe 210400F\n210400M,Severe 210400M'),
      'FS_AreaCodes.csv': strToU8('Area Code,Area\n1,Country 1\n2,Country 2\n3,Country 3'),
      'FS_Elements.csv': strToU8('Element Code,Element\n6121,Value'),
    });
  }

  let dir: string;
  let mirror: FaostatMirror;
  let canvas: DataCanvas | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-text-case-'));
    const zip = textIdentityZip();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = initFaostatMirror({ dir, domains: ['FS'] });
    await mirror.runDomainSync('FS', 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset('FS'),
    });
  });

  afterEach(async () => {
    setCanvas(undefined);
    await canvas?.shutdown(createMockContext());
    canvas = undefined;
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const items = (rows: { item_code_text: string | null }[]) =>
    [...new Set(rows.map((row) => row.item_code_text))].sort();

  it('reads a lowercase item_codes_text entry in the page and the count on both surfaces', async () => {
    const args = {
      domain: 'FS',
      item_codes_text: ['210400F', '210400m'],
      include_aggregates: true,
      year_start: 2022,
      year_end: 2022,
    };
    const whole = await runToolContract(queryObservationsTool, args);
    expect(whole.isError).toBeFalsy();
    const page = whole.structuredContent as {
      observations: { item_code_text: string | null }[];
      totalCount: number;
    };
    expect(page.observations).toHaveLength(6);
    expect(items(page.observations)).toEqual(['210400F', '210400M']);
    expect(page.totalCount).toBe(6);
    const text = whole.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('(210400M)');
    expect(text).toContain('**6 observation(s)**');

    const counted = await runToolContract(queryObservationsTool, { ...args, limit: 4 });
    expect(counted.structuredContent).toMatchObject({ totalCount: 6, nextOffset: 4 });
    expect(counted.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')).toContain(
      'Showing observations 1–4 of 6.',
    );
  });

  it('stages every matched row and records the uppercased identities', async () => {
    canvas = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
    if (!canvas) throw new Error('Expected canvas');
    setCanvas(canvas);
    const ctx = createMockContext({
      tenantId: 'text-case',
      errors: [...queryObservationsTool.errors!, ...dataframeDescribeTool.errors!],
    });
    const result = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({
        domain: 'FS',
        item_codes_text: ['210400F', '210400m'],
        include_aggregates: true,
        limit: 10,
      }),
      ctx,
    );
    expect(result.spilled).toBe(true);
    expect(result.staged_row_count).toBe(12);
    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ canvas_id: result.canvas_id, name: result.table_name }),
      ctx,
    );
    expect(described.tables[0]?.query_params).toMatchObject({
      item_codes_text: ['210400F', '210400M'],
    });
    const instance = await canvas.acquire(result.canvas_id!, ctx);
    const staged = await instance.query(
      `SELECT item_code_text, COUNT(*) AS n FROM ${result.table_name} GROUP BY item_code_text ORDER BY item_code_text`,
    );
    expect(staged.rows.map((row) => [row.item_code_text, Number(row.n)])).toEqual([
      ['210400F', 6],
      ['210400M', 6],
    ]);
  });

  it('lists available elements for a lowercase identity on both surfaces', async () => {
    const wire = await runToolContract(queryObservationsTool, {
      domain: 'FS',
      item_codes_text: ['210400m'],
      element_codes: [9999],
    });
    expect(wire.structuredContent).toMatchObject({
      observations: [],
      available_elements: [{ code: 6121, name: 'Value', units: ['%'] }],
    });
    expect(wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')).toContain(
      '- **6121** — Value (units: %)',
    );
  });

  it('keeps uppercase input and the identity pattern as in 0.7.0', async () => {
    const wire = await runToolContract(queryObservationsTool, {
      domain: 'FS',
      item_codes_text: ['210400M'],
      year_start: 2022,
      year_end: 2022,
      include_aggregates: true,
    });
    const page = wire.structuredContent as { observations: { item_code_text: string | null }[] };
    expect(items(page.observations)).toEqual(['210400M']);
    expect(page.observations).toHaveLength(3);
    for (const padded of [' 210400F', '210400F ', '210400'])
      expect(
        queryObservationsTool.input.safeParse({ domain: 'FS', item_codes_text: [padded] }).success,
      ).toBe(false);
  });
});
