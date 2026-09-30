/**
 * @fileoverview `faostat_commodity_profile` truthful-notice regressions. The tool
 * stages its merged production+trade set to a canvas table only when the set
 * overflows the inline char budget. When it fits, the rankings already cover the
 * full result — but the old notice/format told the caller to enable
 * `CANVAS_PROVIDER_TYPE=duckdb` even with the canvas on (#1), and the fit-inline
 * fragment was suppressed whenever trade was unavailable, so `content[]` and the
 * enrichment surface disagreed (#20). The trade-domain suites cover #19: the two
 * unavailable states carry different remedies, and the staged-set notice names
 * only what actually reached the table. Every staging branch states its
 * disposition in the notice (#31) — a failed staging as a failure, a disabled
 * canvas with the enable advice — and every branch returning a `canvas_id` points
 * at `faostat_dataframe_describe` before `faostat_dataframe_query` (#23). The
 * wire-level cases run through `runToolContract`, so the notice is read from
 * `structuredContent` and from the `content[]` trailer the framework renders.
 * @module tests/tools/commodity-profile-notice
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { STAGE_MAX_ROWS } from '@/services/canvas-staging.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildDomainZip,
  buildExplicitDomainZip,
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** Domain code for the trade cube the profile folds in when it is indexed. */
const TCL = 'TCL';

/** The canvas-disabled advice, unchanged from the text `format()` used to carry alone. */
const DISABLED_ADVICE = 'enable CANVAS_PROVIDER_TYPE=duckdb for deeper SQL on large results';

/** Neutral `format()` line for a response that carries no canvas table. */
const NO_TABLE_LINE = '_No canvas table was staged for this result._';

let canvas: DataCanvas;

/** Both client surfaces of one wire-level call. */
interface WireProfile {
  /** The `format()` block alone — `content[0]`, before the enrichment trailer. */
  formatted: string;
  notice: string | undefined;
  structured: Record<string, unknown>;
  /** Every `content[]` block joined, the enrichment trailer included. */
  text: string;
}

/** Run the profile through its public contract and split out both surfaces. */
async function profileWire(tenantId: string, input: Record<string, unknown> = {}) {
  const wire = await runToolContract(
    commodityProfileTool,
    { item_query: 'wheat', ...input },
    { context: { tenantId } },
  );
  expect(wire.isError).toBeFalsy();
  const blocks = wire.content.map((c) => (c.type === 'text' ? c.text : ''));
  const structured = wire.structuredContent as Record<string, unknown>;
  return {
    formatted: blocks[0] ?? '',
    notice: structured.notice as string | undefined,
    structured,
    text: blocks.join('\n'),
  } satisfies WireProfile;
}

/**
 * Assert the notice reached both surfaces and points at the dataframe pair,
 * `faostat_dataframe_describe` first. `pointer` is the exact describe call the
 * notice must spell out.
 */
function expectDescribeThenQuery(wire: WireProfile, pointer: string) {
  const notice = wire.notice as string;
  expect(notice).toContain(pointer);
  const describeAt = notice.indexOf('faostat_dataframe_describe');
  expect(describeAt).toBeGreaterThanOrEqual(0);
  expect(notice.indexOf('faostat_dataframe_query')).toBeGreaterThan(describeAt);
  // The framework renders the notice as a `> …` trailer line on content[].
  expect(wire.text).toContain(`> ${notice}`);
}

/** A canvas whose every acquire fails — the staging layer degrades to `undefined`. */
function failingCanvas(onAcquire: () => void = () => {}): DataCanvas {
  return {
    acquire: async () => {
      onAcquire();
      throw new Error('simulated canvas failure');
    },
  } as unknown as DataCanvas;
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

describe('faostat_commodity_profile notice (canvas on, merged set fits inline)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-'));
    const zip = buildDomainZip(); // QCL with Wheat (15) / Production (5510)
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

  it('does not advise enabling an already-on canvas when the set fits inline', async () => {
    const ctx = createMockContext({ tenantId: 'profile', errors: commodityProfileTool.errors });
    const input = commodityProfileTool.input.parse({ item_query: 'wheat' });
    const result = await commodityProfileTool.handler(input, ctx);

    // Small fixture: the merged set fits under the char budget, so no table.
    expect(result.spilled).toBe(false);
    // canvas_id is still surfaced (the canvas is on) — the discriminator the
    // format() uses to avoid the misleading "enable canvas" line.
    expect(result.canvas_id).toBeDefined();
    expect(result.top_producers.length).toBeGreaterThan(0);

    const notice = getEnrichment(ctx).notice as string | undefined;
    if (notice !== undefined) {
      expect(notice).not.toMatch(/CANVAS_PROVIDER_TYPE/i);
      expect(notice).not.toMatch(/enable.*canvas/i);
    }

    // The content[] twin must not tell the caller to enable a canvas that is on.
    const formatted = commodityProfileTool.format?.(result) ?? [];
    const text = formatted.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).not.toMatch(/CANVAS_PROVIDER_TYPE/i);
    expect(text).not.toMatch(/enable.*duckdb/i);
  });

  it('reports the fit-inline disposition on BOTH surfaces when trade is unavailable (#20)', async () => {
    const ctx = createMockContext({
      tenantId: 'profile-fit-inline',
      errors: commodityProfileTool.errors,
    });
    const input = commodityProfileTool.input.parse({ item_query: 'wheat' });
    const result = await commodityProfileTool.handler(input, ctx);

    // TCL is outside this mirror's selection, so the profile is production-only.
    // That has no bearing on whether the set fit inline — a production-only set
    // that fits is exactly as complete as a merged one that fits.
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeDefined();
    expect(result.top_exporters).toHaveLength(0);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/fit inline/i);

    const text = (commodityProfileTool.format?.(result) ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toMatch(/fit inline/i);
  });

  it('points the fit-inline canvas_id at faostat_dataframe_describe on both surfaces (#23)', async () => {
    const wire = await profileWire('profile-fit-inline-pointer');

    expect(wire.structured.spilled).toBe(false);
    const canvasId = wire.structured.canvas_id as string;
    expect(canvasId).toBeDefined();
    expect(wire.structured.table_name).toBeUndefined();

    expect(wire.notice).toMatch(/fit inline/i);
    expectDescribeThenQuery(wire, `faostat_dataframe_describe (canvas_id ${canvasId})`);
    // Claims no staged table, and never advises enabling a canvas that is on.
    expect(wire.notice).toMatch(/no canvas table was staged/i);
    expect(wire.notice).not.toMatch(/staged on canvas table/i);
    expect(wire.text).not.toMatch(/CANVAS_PROVIDER_TYPE/);
    expect(wire.formatted).toMatch(/fit inline/i);
  });

  it('discloses a failed staging as a failure on both surfaces, never as a disabled canvas (#31)', async () => {
    setCanvas(failingCanvas());
    let wire: WireProfile;
    try {
      wire = await profileWire('profile-staging-failed');
    } finally {
      setCanvas(canvas);
    }

    // Staging failed, so nothing points at a canvas — but the rankings stand.
    expect(wire.structured.spilled).toBe(false);
    expect(wire.structured.canvas_id).toBeUndefined();
    expect(wire.structured.table_name).toBeUndefined();
    expect((wire.structured.top_producers as unknown[]).length).toBeGreaterThan(0);

    expect(wire.notice).toMatch(/could not be staged/i);
    expect(wire.notice).toMatch(/rankings and trend above/i);
    expect(wire.text).toContain(`> ${wire.notice}`);
    // The canvas is on: neither surface may tell the caller to enable it.
    expect(wire.notice).not.toMatch(/CANVAS_PROVIDER_TYPE/);
    expect(wire.text).not.toMatch(/CANVAS_PROVIDER_TYPE/);
    // format() cannot tell this case from a disabled canvas, so its line is neutral.
    expect(wire.formatted).toContain(NO_TABLE_LINE);
  });

  it('carries the enable-the-canvas advice on both surfaces when the canvas is disabled (#31)', async () => {
    setCanvas(undefined);
    let wire: WireProfile;
    try {
      wire = await profileWire('profile-canvas-disabled');
    } finally {
      setCanvas(canvas);
    }

    expect(wire.structured.spilled).toBe(false);
    expect(wire.structured.canvas_id).toBeUndefined();
    expect(wire.notice).toContain(DISABLED_ADVICE);
    expect(wire.notice).not.toMatch(/could not be staged/i);
    expect(wire.text).toContain(`> ${wire.notice}`);
    // Stated once, by the notice — format()'s own line is the neutral one.
    expect(wire.formatted).toContain(NO_TABLE_LINE);
    expect(wire.formatted).not.toMatch(/CANVAS_PROVIDER_TYPE/);
    expect(wire.text.split(DISABLED_ADVICE)).toHaveLength(2);
  });

  it('fails a call cancelled during staging instead of degrading to the staging-failed notice (#31)', async () => {
    const controller = new AbortController();
    // The caller abandons the request while the set is being staged.
    setCanvas(failingCanvas(() => controller.abort()));
    let wire: Awaited<ReturnType<typeof runToolContract>>;
    try {
      wire = await runToolContract(
        commodityProfileTool,
        { item_query: 'wheat' },
        { context: { tenantId: 'profile-staging-cancelled', signal: controller.signal } },
      );
    } finally {
      setCanvas(canvas);
    }

    expect(wire.isError).toBe(true);
    const error = (wire.structuredContent as { error: { code: number } }).error;
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    const text = wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).not.toMatch(/could not be staged/i);
  });

  it('fails an unknown canvas_id with canvas_not_found and the declared recovery on both surfaces (#35)', async () => {
    const wire = await runToolContract(
      commodityProfileTool,
      { item_query: 'wheat', canvas_id: 'zzzzzzzzzz' },
      { context: { tenantId: 'profile-unknown-canvas' } },
    );

    expect(wire.isError).toBe(true);
    const { error } = wire.structuredContent as {
      error: { code: number; data: Record<string, unknown> };
    };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('canvas_not_found');
    const entry = commodityProfileTool.errors?.find((e) => e.reason === 'canvas_not_found');
    expect(entry).toBeDefined();
    const recovery = (entry as { recovery: string }).recovery;
    expect((error.data.recovery as { hint: string }).hint).toBe(recovery);
    const text = wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(recovery);
    expect(text).not.toMatch(/could not be staged/i);
  });

  it('uses the canvas the caller names when it resolves (#35)', async () => {
    const tenantId = 'profile-explicit-live';
    const live = await canvas.acquire(undefined, createMockContext({ tenantId }));
    const wire = await profileWire(tenantId, { canvas_id: live.canvasId });

    expect(wire.structured.canvas_id).toBe(live.canvasId);
    expect(wire.notice).toMatch(/fit inline/i);
  });
});

describe('faostat_commodity_profile canvas pointers in the definition (#23)', () => {
  it('names both dataframe tools, describe first, wherever a canvas handle is described', () => {
    const shape = commodityProfileTool.output.shape;
    for (const field of [shape.canvas_id, shape.table_name]) {
      expect(field.description).toMatch(/faostat_dataframe_describe[\s\S]*faostat_dataframe_query/);
    }
    // The inline-fit canvas_id carries no table — its description says so.
    expect(shape.canvas_id.description).toMatch(/fit inline/i);
    expect(commodityProfileTool.description).toMatch(
      /too large to inline[^.]*faostat_dataframe_describe[^.]*faostat_dataframe_query/,
    );
  });

  it('never abbreviates the describe tool to the non-callable `/ _describe` shorthand', () => {
    const surface = `${commodityProfileTool.description}${JSON.stringify(
      z.toJSONSchema(commodityProfileTool.output),
    )}`;
    expect(surface).not.toContain('/ _describe');
  });
});

describe('faostat_commodity_profile trade-domain states (#19)', () => {
  let dir: string;
  let mirror: FaostatMirror | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-trade-'));
    const zip = buildDomainZip(); // QCL with Wheat (15) / Production (5510)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 64)),
    );
  });

  afterEach(async () => {
    await mirror?.close();
    mirror = undefined;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Build a mirror over `domains` and sync QCL only. Listing TCL therefore leaves
   * it selected-but-never-synced — `isSelected` true, `ready` false — which is the
   * mid-index state; omitting TCL leaves it outside the selection entirely.
   */
  async function initMirror(domains: string[]): Promise<FaostatMirror> {
    const built = initFaostatMirror({ dir, domains });
    mirror = built;
    await built.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
    return built;
  }

  async function profileNotice(tenantId: string): Promise<string> {
    const ctx = createMockContext({ tenantId, errors: commodityProfileTool.errors });
    const input = commodityProfileTool.input.parse({ item_query: 'wheat' });
    await commodityProfileTool.handler(input, ctx);
    return getEnrichment(ctx).notice as string;
  }

  it('tells a caller whose TCL is still indexing to wait, not to edit FAOSTAT_DOMAINS', async () => {
    const built = await initMirror([FIXTURE_DOMAIN, TCL]);
    expect(built.isSelected(TCL)).toBe(true);
    expect(await built.ready(TCL)).toBe(false);

    const notice = await profileNotice('profile-trade-indexing');
    expect(notice).toMatch(/has not finished its initial sync/i);
    // The config remedy belongs to the not-selected state alone. Following it here
    // means editing a variable that already lists TCL and restarting a sync that
    // was already underway.
    expect(notice).not.toMatch(/FAOSTAT_DOMAINS/);
    expect(notice).not.toMatch(/re-sync/i);
  });

  it('keeps the config remedy when TCL is absent from the selection', async () => {
    await initMirror([FIXTURE_DOMAIN]);

    const notice = await profileNotice('profile-trade-absent');
    expect(notice).toMatch(/not in the local mirror selection/i);
    expect(notice).toMatch(/Add TCL to FAOSTAT_DOMAINS/);
    expect(notice).not.toMatch(/initial sync/i);
  });
});

describe('faostat_commodity_profile staged-set notice (trade unavailable) (#19)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-staged-'));
    // Enough QCL production rows to overflow the inline preview budget without
    // reaching the 50,000-row staging cap, so the set spills but is not truncated.
    const { zip } = buildMidSizeDomainZip({ countryCount: 500, years: 4 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 18)),
    );
    // TCL is not selected, so nothing but QCL production reaches the table.
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

  it('describes the staged table by what it holds, not by what a merge would have held', async () => {
    const ctx = createMockContext({
      tenantId: 'profile-staged',
      errors: commodityProfileTool.errors,
    });
    const input = commodityProfileTool.input.parse({ item_query: 'wheat' });
    const result = await commodityProfileTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.top_exporters).toHaveLength(0);
    expect(result.top_importers).toHaveLength(0);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(result.table_name as string);
    // A caller reading "production + trade" writes SQL against trade element codes
    // that are not in the table.
    expect(notice).not.toMatch(/production \+ trade/i);
    expect(notice).toMatch(/production rows only/i);
  }, 30_000);

  it('points at describe-then-query on both surfaces, and no surface implies staged trade rows (#23)', async () => {
    const wire = await profileWire('profile-staged-wire');
    const tableName = wire.structured.table_name as string;
    const canvasId = wire.structured.canvas_id as string;

    expect(wire.structured.spilled).toBe(true);
    expect(wire.structured.truncated).toBe(false);
    expectDescribeThenQuery(
      wire,
      `faostat_dataframe_describe (name ${tableName}, canvas_id ${canvasId})`,
    );
    expect(wire.notice).toMatch(/production rows only/i);

    // format() sees only the output, which cannot say whether trade reached the
    // table — so its staged line names the table without calling it a merged set.
    expect(wire.formatted).toContain(tableName);
    expect(wire.text).not.toMatch(/merged/i);
    expect(wire.text).not.toMatch(/production \+ trade/i);
  }, 30_000);

  it('hands faostat_dataframe_describe a name and canvas_id that return exactly the staged table (#23)', async () => {
    // Both contracts on one context: describe reads the session state staging wrote.
    const ctx = createMockContext({
      tenantId: 'profile-staged-describe',
      errors: [...(commodityProfileTool.errors ?? []), ...(dataframeDescribeTool.errors ?? [])],
    });
    const result = await commodityProfileTool.handler(
      commodityProfileTool.input.parse({ item_query: 'wheat' }),
      ctx,
    );
    const notice = getEnrichment(ctx).notice as string;
    const pointer = /faostat_dataframe_describe \(name (\S+), canvas_id ([\w-]+)\)/.exec(notice);
    expect(pointer).not.toBeNull();
    const [, name, canvasId] = pointer as RegExpExecArray;
    expect(name).toBe(result.table_name);
    expect(canvasId).toBe(result.canvas_id);

    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ name, canvas_id: canvasId }),
      ctx,
    );
    expect(described.tables.map((t) => t.name)).toEqual([result.table_name]);
    expect(described.tables[0]?.source_tool).toBe('faostat_commodity_profile');
    expect(described.tables[0]?.column_schema.at(-1)).toEqual({ name: 'domain', type: 'VARCHAR' });
  }, 30_000);
});

describe('faostat_commodity_profile staged-set notice (trade included) (#19, #23)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  /** Trade rows for two countries QCL also carries — enough to reach the table. */
  const TRADE = [
    { areaCode: 7, area: 'Country 7', elementCode: 5910, element: 'Export quantity', value: 12 },
    { areaCode: 8, area: 'Country 8', elementCode: 5610, element: 'Import quantity', value: 9 },
  ].map((t) => ({ ...t, itemCode: 15, item: 'Wheat', year: 2023 }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-merged-'));
    // The production rows alone overflow the inline budget; the trade rows follow
    // them onto the table, so it holds both domains.
    const qcl = buildMidSizeDomainZip({ countryCount: 500, years: 4 }).zip;
    const tcl = buildExplicitDomainZip(TRADE, TCL);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        chunkedResponse(String(url).includes(`_${TCL}_`) ? tcl : qcl, 1 << 18),
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
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the merged table and points at describe-then-query on both surfaces', async () => {
    const wire = await profileWire('profile-merged-wire');
    const tableName = wire.structured.table_name as string;
    const canvasId = wire.structured.canvas_id as string;

    expect(wire.structured.spilled).toBe(true);
    expect(wire.structured.truncated).toBe(false);
    expect((wire.structured.top_exporters as unknown[]).length).toBeGreaterThan(0);
    expect(wire.notice).toMatch(/production \+ trade observations staged/i);
    expectDescribeThenQuery(
      wire,
      `faostat_dataframe_describe (name ${tableName}, canvas_id ${canvasId})`,
    );
    expect(wire.formatted).toContain(tableName);
    expect(wire.formatted).toMatch(/staged \(spilled\)/);
  }, 30_000);
});

describe('faostat_commodity_profile truncation disclosure (production exceeds the 50k cap) (#9)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-trunc-'));
    // 260 countries × 200 years = 52,000 QCL production rows for Wheat(15), all
    // country codes (< 5000) so the country-only production path reaches the cap.
    // TCL stays unindexed — tradeMissing short-circuits the trade stream.
    const { zip } = buildMidSizeDomainZip({ countryCount: 260, years: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 18)),
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

  it('flags truncated and never claims a full/complete set when production exceeds the cap', async () => {
    const wire = await profileWire('profile-trunc');
    const result = wire.structured;

    // The observation set spilled and the STAGED TABLE was capped.
    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.staged_row_count).toBe(STAGE_MAX_ROWS);
    // The rankings and trend are SQL aggregates over the full match, so they are
    // NOT capped: all 260 countries × 200 years are counted (#5, repair d).
    expect(result.trend_points).toBe(52_000);
    expect(result.production_trend).toHaveLength(200);
    expect(result.top_producers).toHaveLength(10);

    // structuredContent notice discloses the cap + actionable recovery, never a
    // "full set" claim — and points at the table it did stage, describe first (#23).
    const notice = wire.notice as string;
    expect(notice).toMatch(/cap|only the first|incomplete/i);
    expect(notice).toMatch(/partitioned by year|year_start/i);
    expect(notice).not.toMatch(/full time-series analysis/i);
    expectDescribeThenQuery(
      wire,
      `faostat_dataframe_describe (name ${result.table_name}, canvas_id ${result.canvas_id})`,
    );

    // content[] twin agrees — the canvas table is incomplete, never "Full … staged",
    // and with trade unindexed nothing on it may read as a merged set.
    expect(wire.formatted).toMatch(/incomplete/i);
    expect(wire.formatted).not.toMatch(/Full .* staged/i);
    expect(wire.text).not.toMatch(/merged/i);
    // The staging-cap PREFIX wording (#9) on the truncated field is untouched.
    expect(commodityProfileTool.output.shape.truncated.description).toMatch(/PREFIX/);
  }, 30_000);
});

describe('faostat_commodity_profile truncation disclosure (trade included)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-trunc-trade-'));
    // 52,000 production rows fill the cap on their own. Trade rows stream after
    // production, so none of them reach the capped table.
    const qcl = buildMidSizeDomainZip({ countryCount: 260, years: 200 }).zip;
    const tcl = buildExplicitDomainZip(
      [{ areaCode: 7, area: 'Country 7', elementCode: 5910, element: 'Export quantity' }].map(
        (t) => ({ ...t, itemCode: 15, item: 'Wheat', year: 2023, value: 12 }),
      ),
      TCL,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        chunkedResponse(String(url).includes(`_${TCL}_`) ? tcl : qcl, 1 << 18),
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
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes the row-level recovery through the trade domain too, since trade rows sit past the cap', async () => {
    const wire = await profileWire('profile-trunc-trade');

    expect(wire.structured.truncated).toBe(true);
    expect((wire.structured.top_exporters as unknown[]).length).toBeGreaterThan(0);
    expect(wire.notice).toMatch(/faostat_query_observations on QCL and TCL with item codes 15/);
  }, 30_000);
});
