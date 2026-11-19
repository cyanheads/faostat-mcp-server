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
 * at `faostat_dataframe_describe` before `faostat_dataframe_query` (#23). An item
 * with no trade quantity row points at `faostat_resolve_codes` on TCL, and the
 * row-level pointer names each domain's item when a trade item differs (#66). The
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
  const fail = async () => {
    onAcquire();
    throw new Error('simulated canvas failure');
  };
  // Staging onto the session canvas goes through acquireShared, a named canvas_id through acquire.
  return { acquire: fail, acquireShared: fail } as unknown as DataCanvas;
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

    // TCL is outside this mirror's selection, so the profile has no trade.
    // That has no bearing on whether the set fit inline — a QCL-only set that
    // fits is exactly as complete as a merged one that fits.
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

  it('keeps the call year bounds in the row-level pointer, so following it reads only the profiled window', async () => {
    setCanvas(failingCanvas());
    let wire: WireProfile;
    try {
      wire = await profileWire('profile-staging-failed-bounded', {
        year_start: 2021,
        year_end: 2021,
      });
    } finally {
      setCanvas(canvas);
    }

    expect(wire.notice).toContain(
      'call faostat_query_observations with item codes 15 on QCL (element codes 5510) with year_start 2021 and year_end 2021.',
    );
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
  /** The notice for a selected TCL with no completed sync, whether or not one is running. */
  const TCL_NOT_READY =
    'Trade domain (TCL) is selected but has no completed sync — returning a profile without trade. No configuration change is needed: TCL becomes available once a sync of it completes, run by the server’s scheduled refresh where one is configured or by its operator through mirror:init or mirror:refresh. Check faostat_list_domains with code TCL for its index_ready flag, then call this profile again once it turns true.';

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
   * it selected-but-never-synced — `isSelected` true, `ready` false — the state of a
   * TCL with no completed sync, running or not; omitting TCL leaves it outside the
   * selection entirely.
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

  it('tells a caller whose TCL has no completed sync to wait, not to edit FAOSTAT_DOMAINS', async () => {
    const built = await initMirror([FIXTURE_DOMAIN, TCL]);
    expect(built.isSelected(TCL)).toBe(true);
    expect(await built.ready(TCL)).toBe(false);

    const notice = await profileNotice('profile-trade-indexing');
    // True whether or not a sync of TCL is running: nothing here starts one.
    expect(notice).toContain(TCL_NOT_READY);
    // The config remedy belongs to the not-selected state alone. Following it here
    // means editing a variable that already lists TCL and restarting a sync that
    // may already be underway.
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

  it('leaves trade_item_code unchecked while TCL is still indexing (#66)', async () => {
    await initMirror([FIXTURE_DOMAIN, TCL]);

    const wire = await profileWire('profile-trade-item-indexing', { trade_item_code: 9999 });
    expect(wire.structured).not.toHaveProperty('trade_item');
    expect(wire.notice).toContain(TCL_NOT_READY);
    expect(wire.notice).not.toMatch(/trade_item_code/);
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
    // A caller reading "QCL + TCL" writes SQL against trade element codes that are
    // not in the table.
    expect(notice).not.toMatch(/QCL \+ TCL/);
    expect(notice).toMatch(/the table holds QCL rows only/);
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
    expect(wire.notice).toMatch(/the table holds QCL rows only/);

    // format() sees only the output, which cannot say whether trade reached the
    // table — so its staged line names the table without calling it a merged set.
    expect(wire.formatted).toContain(tableName);
    expect(wire.text).not.toMatch(/merged/i);
    expect(wire.text).not.toMatch(/QCL \+ TCL/);
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
    expect(wire.notice).toMatch(/Merged QCL \+ TCL observations staged/);
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
    // The pointer names the elements the rankings read in each domain, so following
    // it returns the staged set's rows and not every element the item carries.
    expect(wire.notice).toContain(
      'faostat_query_observations with item codes 15 on QCL (element codes 5510) and TCL (element codes 5910) partitioned by year',
    );
  }, 30_000);
});

describe('faostat_commodity_profile lag notice (#50)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  const wheat = { itemCode: 15, item: 'Wheat' };
  const production = { ...wheat, elementCode: 5510, element: 'Production' };
  const imports = { ...wheat, elementCode: 5610, element: 'Import quantity' };
  const exports = { ...wheat, elementCode: 5910, element: 'Export quantity' };
  const alpha = { areaCode: 10, area: 'Alpha' };
  const bravo = { areaCode: 20, area: 'Bravo' };
  const charlie = { areaCode: 30, area: 'Charlie' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-lag-'));
    // QCL runs to 2022 and TCL to 2021. Bravo stops early in both, Charlie in QCL;
    // Alpha leads every ranking, so top_n 1 returns no lagging row.
    const qcl = buildExplicitDomainZip([
      { ...alpha, ...production, year: 2020, value: 98 },
      { ...alpha, ...production, year: 2022, value: 100 },
      { ...bravo, ...production, year: 2019, value: 50 },
      { ...charlie, ...production, year: 2017, value: 1 },
    ]);
    const tcl = buildExplicitDomainZip(
      [
        { ...alpha, ...imports, year: 2021, value: 60 },
        { ...bravo, ...imports, year: 2018, value: 50 },
        { ...alpha, ...exports, year: 2021, value: 7 },
      ],
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
  }, 30_000);

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('names each lagging row returned, per ranking, with a year_start the caller can send', async () => {
    const wire = await profileWire('profile-lag');
    expect(wire.notice).toContain(
      "Rows behind their ranking's latest year — each country ranks at its own latest year with data. In top_producers (latest year 2022): Bravo (20) 2019, 3 years behind; Charlie (30) 2017, 5 years behind. In top_importers (latest year 2021): Bravo (20) 2018, 3 years behind. year_start restricts every ranking to areas with data from that year on, and production_trend to those years: year_start 2022 leaves top_producers only areas reporting in 2022; year_start 2021 leaves top_importers only areas reporting in 2021.",
    );
    expect(wire.text).toContain(`> ${wire.notice}`);
    // content[] shows each row's lag beside its year.
    expect(wire.formatted).toContain('- Bravo (20): 50 t [2019, 3 yr behind, 1 obs, flags A]');
    expect(wire.formatted).toContain('- Alpha (10): 100 t [2022, 0 yr behind, 1 obs, flags A]');
  });

  it('suggests a year_start past the one the call set, never the same one', async () => {
    const wire = await profileWire('profile-lag-bounded', { year_start: 2019 });
    // Bravo's 2019 survives the bound and still trails 2022; TCL's 2018 row does not.
    expect(wire.notice).toContain(
      'In top_producers (latest year 2022): Bravo (20) 2019, 3 years behind. year_start restricts every ranking to areas with data from that year on, and production_trend to those years: year_start 2022 leaves top_producers only areas reporting in 2022.',
    );
    expect(wire.notice).not.toMatch(/top_importers \(latest/);
  });

  it.each([
    ['a year_start that leaves every area current', { year_start: 2020 }],
    ['a top_n that returns no lagging row', { top_n: 1 }],
  ])('leaves the lag part out for %s', async (_case, input) => {
    const wire = await profileWire('profile-lag-none', input);
    expect(wire.notice).not.toMatch(/behind/);
    expect(wire.notice).not.toMatch(/year_start/);
  });
});

describe('faostat_commodity_profile trade item notices (#66)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  /** The pointer to a trade item that the notice adds when no trade quantity element is carried. */
  const POINTER =
    'call faostat_resolve_codes with domain TCL, dimension item, and a query naming the traded product, then pass a returned code as trade_item_code';

  const alpha = { areaCode: 10, area: 'Alpha', year: 2022 };
  const production = { elementCode: 5510, element: 'Production' };
  const exports = { elementCode: 5910, element: 'Export quantity' };
  const imports = { elementCode: 5610, element: 'Import quantity' };
  const headExports = { elementCode: 5908, element: 'Export quantity', unit: 'An' };
  const headImports = { elementCode: 5608, element: 'Import quantity', unit: 'An' };
  const wheat = { itemCode: 15, item: 'Wheat' };
  const palmFruit = { itemCode: 254, item: 'Oil palm fruit' };
  const palmOil = { itemCode: 257, item: 'Palm oil' };
  const bran = { itemCode: 17, item: 'Bran of wheat' };
  const beef = { itemCode: 867, item: 'Meat of cattle' };
  const cattle = { itemCode: 866, item: 'Cattle' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-trade-item-'));
    /*
     * QCL: wheat, oil palm fruit, meat of cattle, and bran. TCL: wheat exports only,
     * palm oil both ways, bran with an export value and no quantity element, and cattle
     * with head-count quantities only (5608/5908); oil palm fruit has no TCL row.
     */
    const qcl = buildExplicitDomainZip([
      { ...alpha, ...wheat, ...production, value: 100 },
      { ...alpha, ...palmFruit, ...production, value: 50 },
      { ...alpha, ...beef, ...production, value: 40 },
      { ...alpha, ...bran, ...production, value: 30 },
    ]);
    const tcl = buildExplicitDomainZip(
      [
        { ...alpha, ...wheat, ...exports, value: 12 },
        { ...alpha, ...palmOil, ...exports, value: 9 },
        { ...alpha, ...palmOil, ...imports, value: 8 },
        { ...alpha, ...bran, elementCode: 5922, element: 'Export value', value: 7 },
        { ...alpha, ...cattle, ...headImports, value: 3 },
        { ...alpha, ...cattle, ...headExports, value: 2 },
      ],
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
  }, 30_000);

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('points an item with no TCL trade quantity row at faostat_resolve_codes on TCL', async () => {
    const wire = await profileWire('profile-pointer', { item_query: 'Oil palm fruit' });
    expect(wire.notice).toContain(
      `TCL holds no export quantity (5910) or import quantity (5610) rows for Oil palm fruit, so top_exporters and top_importers are empty. If the product trades in a processed form, ${POINTER}.`,
    );
    expect(wire.text).toContain(`> ${wire.notice}`);
  });

  it('leaves the pointer out when one side is missing, and when a trade item ranks', async () => {
    const wheatOnly = await profileWire('profile-pointer-one-sided', { item_query: 'Wheat' });
    expect(wheatOnly.notice).toContain(
      'TCL holds no import quantity (5610) rows for Wheat, so top_importers is empty.',
    );
    expect(wheatOnly.notice).not.toContain(POINTER);

    const palm = await profileWire('profile-pointer-traded', {
      item_query: 'Oil palm fruit',
      trade_item_code: palmOil.itemCode,
    });
    expect(palm.structured.trade_item).toEqual({ code: 257, name: 'Palm oil' });
    expect(palm.structured.top_exporters).toMatchObject([{ area_code: 10, value: 9 }]);
    expect(palm.notice).not.toMatch(/TCL holds no/);
    expect(palm.notice).not.toContain(POINTER);
  });

  it('names the elements a supplied trade item carries instead of the pointer, on both surfaces', async () => {
    const wire = await profileWire('profile-pointer-bran', {
      item_query: 'Wheat',
      trade_item_code: bran.itemCode,
    });
    expect(wire.structured.trade_item).toEqual({ code: 17, name: 'Bran of wheat' });
    expect(wire.structured.ranking_elements).toEqual({
      top_producers: [{ element_code: 5510, element: 'Production', units: ['t'] }],
      top_exporters: [],
      top_importers: [],
    });
    expect(wire.notice).toContain(
      'TCL holds no export quantity (5910) or import quantity (5610) rows for Bran of wheat (17), so top_exporters and top_importers are empty. Bran of wheat (17) carries TCL rows only for other elements (5922): pass a trade_item_code whose item carries export quantity (5910) or import quantity (5610), or omit trade_item_code.',
    );
    // The pointer would send the caller back to the code that just ranked nothing.
    expect(wire.notice).not.toContain(POINTER);
    expect(wire.text).toContain(`> ${wire.notice}`);
    expect(wire.formatted).toContain('Trade item: Bran of wheat (17)');
    expect(wire.formatted).toContain('### Top exporters of Bran of wheat (17)\n_None._');
    expect(wire.formatted).toContain('### Top importers of Bran of wheat (17)\n_None._');
  });

  it('names head-count elements a tonne-ranked trade item carries, without a read beyond the element check', async () => {
    const reads = vi.spyOn(mirror.reads, 'all');
    let traded: WireProfile;
    let own: WireProfile;
    let tradedReads: number;
    try {
      traded = await profileWire('profile-pointer-cattle', {
        item_query: 'Meat of cattle',
        trade_item_code: cattle.itemCode,
      });
      tradedReads = reads.mock.calls.length;
      reads.mockClear();
      own = await profileWire('profile-pointer-beef', { item_query: 'Meat of cattle' });
      // The trade item's element read stands in for the selected item's: same read count.
      expect(reads).toHaveBeenCalledTimes(tradedReads);
    } finally {
      reads.mockRestore();
    }
    expect(traded.notice).toContain(
      'TCL holds no export quantity (5910) or import quantity (5610) rows for Cattle (866), so top_exporters and top_importers are empty. Cattle (866) carries TCL rows only for other elements (5608, 5908): pass a trade_item_code whose item carries export quantity (5910) or import quantity (5610), or omit trade_item_code.',
    );
    expect(traded.notice).not.toContain(POINTER);
    expect(traded.text).toContain(`> ${traded.notice}`);
    // Without a trade_item_code the notice keeps the pointer, word for word.
    expect(own.notice).toContain(
      `TCL holds no export quantity (5910) or import quantity (5610) rows for Meat of cattle, so top_exporters and top_importers are empty. If the product trades in a processed form, ${POINTER}.`,
    );
    expect(own.notice).not.toMatch(/carries TCL rows only/);
  });

  it.each([
    ['no quantity element on either side', { item_code: bran.itemCode }, bran.itemCode],
    ['one side ranked', { item_query: 'Wheat' }, wheat.itemCode],
  ])(
    'reads a trade_item_code equal to item_code as omitted in the notice, on both surfaces: %s',
    async (_case, input, code) => {
      // Both calls stage onto one named canvas, so both notices name the same canvas_id.
      const tenant = `profile-pointer-same-${code}`;
      const live = await canvas.acquire(undefined, createMockContext({ tenantId: tenant }));
      const omitted = await profileWire(tenant, { ...input, canvas_id: live.canvasId });
      const same = await profileWire(tenant, {
        ...input,
        canvas_id: live.canvasId,
        trade_item_code: code,
      });
      expect(same.structured.trade_item).toMatchObject({ code });
      expect(same.notice).toBe(omitted.notice);
      expect(same.text).toContain(`> ${omitted.notice}`);
      expect(same.notice).not.toMatch(/carries TCL rows only/);
    },
  );

  it('gives a trade_item_code equal to item_code today’s pointer, word for word', async () => {
    const same = await profileWire('profile-pointer-same-bran', {
      item_code: bran.itemCode,
      trade_item_code: bran.itemCode,
    });
    expect(same.notice).toContain(
      `TCL holds no export quantity (5910) or import quantity (5610) rows for Bran of wheat, so top_exporters and top_importers are empty. If the product trades in a processed form, ${POINTER}.`,
    );
  });

  it('adds neither sentence when a supplied trade item ranks one side', async () => {
    const wire = await profileWire('profile-pointer-one-sided-traded', {
      item_query: 'Oil palm fruit',
      trade_item_code: wheat.itemCode,
    });
    expect(wire.structured.top_exporters).toMatchObject([{ area_code: 10, value: 12 }]);
    expect(wire.notice).toContain(
      'TCL holds no import quantity (5610) rows for Wheat (15), so top_importers is empty.',
    );
    expect(wire.notice).not.toMatch(/carries TCL rows only/);
    expect(wire.notice).not.toContain(POINTER);
  });

  it('names each domain’s item in the row-level pointer when the trade item differs', async () => {
    setCanvas(failingCanvas());
    let traded: WireProfile;
    let same: WireProfile;
    try {
      traded = await profileWire('profile-pointer-row-level', {
        item_query: 'Oil palm fruit',
        trade_item_code: palmOil.itemCode,
      });
      same = await profileWire('profile-pointer-row-level-same', {
        item_query: 'Wheat',
        trade_item_code: wheat.itemCode,
      });
    } finally {
      setCanvas(canvas);
    }
    expect(traded.notice).toContain(
      'for row-level data, call faostat_query_observations with item codes 254 on QCL (element codes 5510) and item codes 257 on TCL (element codes 5910, 5610).',
    );
    // A trade item equal to the selected one reads as the pointer always has.
    expect(same.notice).toContain(
      'for row-level data, call faostat_query_observations with item codes 15 on QCL (element codes 5510) and TCL (element codes 5910).',
    );
  });
});
