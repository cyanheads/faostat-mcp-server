/**
 * @fileoverview `faostat_commodity_profile` element selection (#51). The profile
 * picks its elements from what the item carries: Production (5510) when the item
 * has any Production row, otherwise every Stocks element it carries in QCL; for
 * trade, 5610/5910 for a Production item, otherwise every import and export
 * quantity element it carries in TCL. The output names each ranking's elements
 * and units on both surfaces, and an item with no applicable QCL element returns
 * empty sections with a notice naming what it does carry.
 * @module tests/tools/commodity-profile-elements
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildExplicitDomainZip,
  chunkedResponse,
  type ExplicitObservation,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

const QCL = 'QCL';
const TCL = 'TCL';

const ALPHA = { areaCode: 10, area: 'Alpha' } as const;
const BRAVO = { areaCode: 20, area: 'Bravo' } as const;

const PRODUCTION = { elementCode: 5510, element: 'Production', unit: 't' } as const;
const AREA_HARVESTED = { elementCode: 5312, element: 'Area harvested', unit: 'ha' } as const;
const STOCKS_HEAD = { elementCode: 5111, element: 'Stocks', unit: 'An' } as const;
const STOCKS_THOUSAND = { elementCode: 5112, element: 'Stocks', unit: '1000 An' } as const;
const IMPORT_T = { elementCode: 5610, element: 'Import quantity', unit: 't' } as const;
const EXPORT_T = { elementCode: 5910, element: 'Export quantity', unit: 't' } as const;
const IMPORT_HEAD = { elementCode: 5608, element: 'Import quantity', unit: 'An' } as const;
const EXPORT_HEAD = { elementCode: 5908, element: 'Export quantity', unit: 'An' } as const;
const IMPORT_THOUSAND = { elementCode: 5609, element: 'Import quantity', unit: '1000 An' } as const;
const EXPORT_THOUSAND = { elementCode: 5909, element: 'Export quantity', unit: '1000 An' } as const;
const IMPORT_VALUE = { elementCode: 5622, element: 'Import value', unit: '1000 USD' } as const;

const WHEAT = { itemCode: 15, item: 'Wheat' } as const;
const CATTLE = { itemCode: 866, item: 'Cattle' } as const;
const RODENTS = { itemCode: 1150, item: 'Other rodents' } as const;
const BIRDS = { itemCode: 1083, item: 'Other birds' } as const;
const HAY = { itemCode: 300, item: 'Hay' } as const;
const RABBITS = { itemCode: 1140, item: 'Rabbits and hares' } as const;

/** QCL: a Production item, three Stocks items, and an item carrying only Area harvested. */
const QCL_ROWS: ExplicitObservation[] = [
  { ...ALPHA, ...WHEAT, ...PRODUCTION, year: 2022, value: 50 },
  { ...BRAVO, ...WHEAT, ...PRODUCTION, year: 2022, value: 70 },
  { ...ALPHA, ...WHEAT, ...AREA_HARVESTED, year: 2022, value: 9000 },
  { ...ALPHA, ...CATTLE, ...STOCKS_HEAD, year: 2021, value: 100 },
  { ...ALPHA, ...CATTLE, ...STOCKS_HEAD, year: 2022, value: 110 },
  { ...BRAVO, ...CATTLE, ...STOCKS_HEAD, year: 2022, value: 300 },
  { ...ALPHA, ...RODENTS, ...STOCKS_THOUSAND, year: 2022, value: 5 },
  { ...BRAVO, ...BIRDS, ...STOCKS_THOUSAND, year: 2022, value: 7 },
  { ...ALPHA, ...HAY, ...AREA_HARVESTED, year: 2022, value: 12 },
  { ...ALPHA, ...RABBITS, ...STOCKS_THOUSAND, year: 2022, value: 4 },
];

/**
 * TCL: wheat in tonnes plus a stray head-count row that a Production item must
 * not rank; cattle in head plus an import value that no ranking reads; rodents in
 * two units (the 1150 shape); rabbits in two units from one country in one year. The
 * birds and hay carry no trade rows.
 */
const TCL_ROWS: ExplicitObservation[] = [
  { ...ALPHA, ...WHEAT, ...IMPORT_T, year: 2022, value: 7 },
  { ...BRAVO, ...WHEAT, ...EXPORT_T, year: 2022, value: 8 },
  { ...ALPHA, ...WHEAT, ...IMPORT_HEAD, year: 2022, value: 999 },
  { ...ALPHA, ...CATTLE, ...IMPORT_HEAD, year: 2022, value: 10 },
  { ...BRAVO, ...CATTLE, ...IMPORT_HEAD, year: 2022, value: 20 },
  { ...BRAVO, ...CATTLE, ...EXPORT_HEAD, year: 2022, value: 30 },
  { ...ALPHA, ...CATTLE, ...IMPORT_VALUE, year: 2022, value: 5000 },
  { ...ALPHA, ...RODENTS, ...IMPORT_HEAD, year: 2022, value: 40 },
  { ...BRAVO, ...RODENTS, ...EXPORT_HEAD, year: 2022, value: 41 },
  { ...BRAVO, ...RODENTS, ...IMPORT_THOUSAND, year: 2022, value: 2 },
  { ...ALPHA, ...RODENTS, ...EXPORT_THOUSAND, year: 2022, value: 3 },
  { ...ALPHA, ...RABBITS, ...EXPORT_HEAD, year: 2022, value: 6 },
  { ...ALPHA, ...RABBITS, ...EXPORT_THOUSAND, year: 2022, value: 4 },
];

type Ranked = { area_code: number; value: number; unit: string | null; year: number };
type ProfileWire = {
  structured: {
    top_producers: Ranked[];
    top_exporters: Ranked[];
    top_importers: Ranked[];
    production_trend: { year: number; value: number; unit: string | null }[];
    trend_points: number;
    ranking_elements: Record<string, unknown>;
    notice?: string;
  };
  /** The `format()` block alone. */
  formatted: string;
  /** Every `content[]` block joined, the enrichment trailer included. */
  text: string;
};

/** Ranked rows reduced to the fields a selection change would move. */
const rows = (ranked: Ranked[]) => ranked.map((r) => [r.area_code, r.value, r.unit, r.year]);

/** Sync a mirror holding `qcl` and `tcl` (or QCL only), selecting `domains`. */
async function syncMirror(
  dir: string,
  qcl: ExplicitObservation[],
  tcl: ExplicitObservation[] | undefined,
): Promise<FaostatMirror> {
  const zips = {
    [QCL]: buildExplicitDomainZip(qcl, QCL),
    ...(tcl ? { [TCL]: buildExplicitDomainZip(tcl, TCL) } : {}),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) =>
      chunkedResponse(String(url).includes(`_${TCL}_`) ? zips[TCL]! : zips[QCL]!, 1 << 16),
    ),
  );
  const domains = tcl ? [QCL, TCL] : [QCL];
  const mirror = initFaostatMirror({ dir, domains });
  for (const domain of domains) {
    await mirror.runDomainSync(domain, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(domain),
    });
  }
  return mirror;
}

/** Run the profile through its public contract and split out both surfaces. */
async function profile(input: Record<string, unknown>): Promise<ProfileWire> {
  const wire = await runToolContract(commodityProfileTool, input, {
    context: { tenantId: 'profile-elements' },
  });
  expect(wire.isError).toBeFalsy();
  const blocks = wire.content.map((c) => (c.type === 'text' ? c.text : ''));
  return {
    structured: wire.structuredContent as ProfileWire['structured'],
    formatted: blocks[0] ?? '',
    text: blocks.join('\n'),
  };
}

describe('faostat_commodity_profile element selection (#51)', () => {
  let dir: string;
  let mirror: FaostatMirror;
  let canvas: DataCanvas;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-elements-'));
    mirror = await syncMirror(dir, QCL_ROWS, TCL_ROWS);
    // A live canvas reaches the fit-inline disposition, the one that claims a full result.
    const built = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
    if (!built) throw new Error('expected a DuckDB canvas');
    canvas = built;
    setCanvas(canvas);
  }, 30_000);

  afterAll(async () => {
    setCanvas(undefined);
    await canvas.shutdown(createMockContext({ tenantId: 'teardown' }));
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ranks a Production item on 5510 and 5610/5910 alone, as before', async () => {
    const { structured } = await profile({ item_code: WHEAT.itemCode });
    expect(rows(structured.top_producers)).toEqual([
      [20, 70, 't', 2022],
      [10, 50, 't', 2022],
    ]);
    expect(structured.production_trend.map((p) => [p.year, p.value, p.unit])).toEqual([
      [2022, 120, 't'],
    ]);
    // The head-count import row the item also carries never reaches a ranking.
    expect(rows(structured.top_exporters)).toEqual([[20, 8, 't', 2022]]);
    expect(rows(structured.top_importers)).toEqual([[10, 7, 't', 2022]]);
  });

  it('ranks a live-animal item on the Stocks and trade quantity elements it carries', async () => {
    const { structured } = await profile({ item_code: CATTLE.itemCode });
    expect(rows(structured.top_producers)).toEqual([
      [20, 300, 'An', 2022],
      [10, 110, 'An', 2022],
    ]);
    expect(structured.production_trend.map((p) => [p.year, p.value, p.unit])).toEqual([
      [2021, 100, 'An'],
      [2022, 410, 'An'],
    ]);
    expect(structured.trend_points).toBe(3);
    expect(rows(structured.top_exporters)).toEqual([[20, 30, 'An', 2022]]);
    // The import value (5622) is not a quantity element, so it is never summed in.
    expect(rows(structured.top_importers)).toEqual([
      [20, 20, 'An', 2022],
      [10, 10, 'An', 2022],
    ]);
  });

  it('names each ranking’s elements and units on both surfaces', async () => {
    const wheat = await profile({ item_code: WHEAT.itemCode });
    expect(wheat.structured.ranking_elements).toEqual({
      top_producers: [{ element_code: 5510, element: 'Production', units: ['t'] }],
      top_exporters: [{ element_code: 5910, element: 'Export quantity', units: ['t'] }],
      top_importers: [{ element_code: 5610, element: 'Import quantity', units: ['t'] }],
    });
    expect(wheat.formatted).toContain('### Top producers — Production 5510 (t)');
    expect(wheat.formatted).toContain('### Top exporters — Export quantity 5910 (t)');
    expect(wheat.formatted).toContain('### Top importers — Import quantity 5610 (t)');
    expect(wheat.formatted).toContain(
      '### Production trend (2 observation(s)) — Production 5510 (t)',
    );

    const cattle = await profile({ item_code: CATTLE.itemCode });
    expect(cattle.structured.ranking_elements).toEqual({
      top_producers: [{ element_code: 5111, element: 'Stocks', units: ['An'] }],
      top_exporters: [{ element_code: 5908, element: 'Export quantity', units: ['An'] }],
      top_importers: [{ element_code: 5608, element: 'Import quantity', units: ['An'] }],
    });
    expect(cattle.formatted).toContain('### Top producers — Stocks 5111 (An)');
    expect(cattle.formatted).toContain('### Top exporters — Export quantity 5908 (An)');
    expect(cattle.formatted).toContain('### Top importers — Import quantity 5608 (An)');
    expect(cattle.formatted).toContain(
      '### Production trend (3 observation(s)) — Stocks 5111 (An)',
    );
  });

  it('says when Stocks replaced Production, and only then', async () => {
    const cattle = await profile({ item_code: CATTLE.itemCode });
    expect(cattle.structured.notice).toMatch(
      /Stocks replaced Production: Cattle has no Production \(5510\) rows in QCL, so top_producers and production_trend use Stocks 5111 \(An\)/,
    );
    expect(cattle.text).toContain(`> ${cattle.structured.notice}`);
    const wheat = await profile({ item_code: WHEAT.itemCode });
    expect(wheat.structured.notice).not.toMatch(/Stocks/);
  });

  it('ranks a Stocks item’s two trade units as separate rows under the mixed-unit notice', async () => {
    const { structured, formatted } = await profile({ item_code: RODENTS.itemCode });
    expect(rows(structured.top_producers)).toEqual([[10, 5, '1000 An', 2022]]);
    expect(rows(structured.top_exporters)).toEqual([
      [20, 41, 'An', 2022],
      [10, 3, '1000 An', 2022],
    ]);
    expect(rows(structured.top_importers)).toEqual([
      [10, 40, 'An', 2022],
      [20, 2, '1000 An', 2022],
    ]);
    expect(structured.ranking_elements.top_exporters).toEqual([
      { element_code: 5908, element: 'Export quantity', units: ['An'] },
      { element_code: 5909, element: 'Export quantity', units: ['1000 An'] },
    ]);
    expect(formatted).toContain(
      '### Top exporters — Export quantity 5908 (An); Export quantity 5909 (1000 An)',
    );
    expect(structured.notice).toMatch(/more than one unit \(1000 An, An\)/);
  });

  it('keeps one country’s two trade units apart when both fall in its latest year', async () => {
    const { structured } = await profile({ item_code: RABBITS.itemCode });
    expect(rows(structured.top_exporters)).toEqual([
      [10, 6, 'An', 2022],
      [10, 4, '1000 An', 2022],
    ]);
    expect(structured.notice).toMatch(/more than one unit \(1000 An, An\)/);
  });

  it('returns empty sections for an item with no applicable QCL element, naming what it carries', async () => {
    const { structured, formatted, text } = await profile({ item_code: HAY.itemCode });
    expect(structured.top_producers).toEqual([]);
    expect(structured.production_trend).toEqual([]);
    expect(structured.top_exporters).toEqual([]);
    expect(structured.top_importers).toEqual([]);
    expect(structured.ranking_elements).toEqual({
      top_producers: [],
      top_exporters: [],
      top_importers: [],
    });
    expect(structured.notice).toMatch(
      /Hay carries no Production \(5510\) or Stocks \(5111, 5112, 5114\) rows in QCL — its QCL elements are Area harvested 5312 — so top_producers and production_trend are empty\./,
    );
    // Nothing claims an empty profile is the full result.
    expect(text).not.toMatch(/cover the full result/);
    expect(formatted).not.toMatch(/figures above cover/);
  });

  it('says why a Stocks item without trade quantity rows has empty trade sections', async () => {
    const { structured } = await profile({ item_code: BIRDS.itemCode });
    expect(rows(structured.top_producers)).toEqual([[20, 7, '1000 An', 2022]]);
    expect(structured.top_exporters).toEqual([]);
    expect(structured.top_importers).toEqual([]);
    expect(structured.notice).toMatch(
      /TCL holds no export quantity \(5907, 5908, 5909, 5910\) or import quantity \(5607, 5608, 5609, 5610\) rows for Other birds, so top_exporters and top_importers are empty\./,
    );
    // The rankings it did return cover the selected rows in full.
    expect(structured.notice).toMatch(/cover the full result/);
  });

  it('lists the selected elements with no units when the year bounds hold no rows', async () => {
    // Year bounds that hold no rows leave the elements selected but their units empty.
    const { structured, formatted } = await profile({
      item_code: CATTLE.itemCode,
      year_start: 2030,
    });
    expect(structured.top_producers).toEqual([]);
    expect(structured.ranking_elements.top_producers).toEqual([
      { element_code: 5111, element: 'Stocks', units: [] },
    ]);
    expect(formatted).toContain('### Top producers — Stocks 5111\n_None._');
  });
});

describe('faostat_commodity_profile element selection without trade (#51)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-elements-qcl-'));
    mirror = await syncMirror(dir, QCL_ROWS, undefined);
  }, 30_000);

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('names no trade elements when TCL is outside the selection', async () => {
    const { structured, formatted } = await profile({ item_code: CATTLE.itemCode });
    expect(rows(structured.top_producers)).toEqual([
      [20, 300, 'An', 2022],
      [10, 110, 'An', 2022],
    ]);
    expect(structured.ranking_elements).toEqual({
      top_producers: [{ element_code: 5111, element: 'Stocks', units: ['An'] }],
      top_exporters: [],
      top_importers: [],
    });
    expect(formatted).toContain('### Top exporters\n_None._');
    expect(structured.notice).toMatch(/Add TCL to FAOSTAT_DOMAINS/);
    // No trade claim beyond the unavailable-domain one.
    expect(structured.notice).not.toMatch(/TCL holds no/);
  });
});

describe('faostat_commodity_profile staged table for a Stocks item (#51)', () => {
  let dir: string;
  let mirror: FaostatMirror;
  let canvas: DataCanvas;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-elements-staged-'));
    // Enough Stocks rows to overflow the inline budget, plus trade quantity and
    // trade value rows: the table holds what the rankings read, never the value rows.
    const countries = Array.from({ length: 500 }, (_, i) => ({
      areaCode: i + 1,
      area: `Country ${i + 1}`,
    }));
    const qcl = countries.map((c) => ({ ...c, ...CATTLE, ...STOCKS_HEAD, year: 2022, value: 1 }));
    const tcl = countries.slice(0, 20).flatMap((c) => [
      { ...c, ...CATTLE, ...IMPORT_HEAD, year: 2022, value: 2 },
      { ...c, ...CATTLE, ...EXPORT_HEAD, year: 2022, value: 3 },
      { ...c, ...CATTLE, ...IMPORT_VALUE, year: 2022, value: 4 },
    ]);
    mirror = await syncMirror(dir, qcl, tcl);
    const built = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
    if (!built) throw new Error('expected a DuckDB canvas');
    canvas = built;
    setCanvas(canvas);
  }, 30_000);

  afterAll(async () => {
    setCanvas(undefined);
    await canvas.shutdown(createMockContext({ tenantId: 'teardown' }));
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stages the Stocks rows and the trade quantity rows the rankings read', async () => {
    const ctx = createMockContext({
      tenantId: 'profile-elements-staged',
      errors: commodityProfileTool.errors,
    });
    const result = await commodityProfileTool.handler(
      commodityProfileTool.input.parse({ item_code: CATTLE.itemCode }),
      ctx,
    );
    expect(result.spilled).toBe(true);
    const instance = await canvas.acquire(result.canvas_id, ctx);
    const staged = await instance.query(
      `SELECT domain, CAST(element_code AS INTEGER) AS element_code, COUNT(*) AS n FROM ${result.table_name} GROUP BY domain, element_code ORDER BY domain, element_code`,
    );
    // Codes 1–500 hold seven curated roll-ups (261, 265, 266, 268, 269, 351, 420),
    // excluded as aggregates: 493 countries.
    expect(staged.rows.map((r) => [r.domain, r.element_code, Number(r.n)])).toEqual([
      [QCL, 5111, 493],
      [TCL, 5608, 20],
      [TCL, 5908, 20],
    ]);
  }, 30_000);
});
