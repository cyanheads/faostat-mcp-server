/**
 * @fileoverview `faostat_commodity_profile` truthful-notice regressions. The tool
 * stages its merged production+trade set to a canvas table only when the set
 * overflows the inline char budget. When it fits, the rankings already cover the
 * full result — but the old notice/format told the caller to enable
 * `CANVAS_PROVIDER_TYPE=duckdb` even with the canvas on (#1), and the fit-inline
 * fragment was suppressed whenever trade was unavailable, so `content[]` and the
 * enrichment surface disagreed (#20). The trade-domain suites cover #19: the two
 * unavailable states carry different remedies, and the staged-set notice names
 * only what actually reached the table.
 * @module tests/tools/commodity-profile-notice
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { STAGE_MAX_ROWS } from '@/services/canvas-staging.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildDomainZip,
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** Domain code for the trade cube the profile folds in when it is indexed. */
const TCL = 'TCL';

let canvas: DataCanvas;

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
    const formatted = commodityProfileTool.format(result);
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

    const text = commodityProfileTool
      .format(result)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toMatch(/fit inline/i);
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
    const ctx = createMockContext({
      tenantId: 'profile-trunc',
      errors: commodityProfileTool.errors,
    });
    const input = commodityProfileTool.input.parse({ item_query: 'wheat' });
    const result = await commodityProfileTool.handler(input, ctx);

    // The merged set spilled and the STAGED TABLE was capped.
    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.staged_row_count).toBe(STAGE_MAX_ROWS);
    // The rankings and trend are SQL aggregates over the full match, so they are
    // NOT capped: all 260 countries × 200 years are counted (#5, repair d).
    expect(result.trend_points).toBe(52_000);
    expect(result.production_trend).toHaveLength(200);
    expect(result.top_producers).toHaveLength(10);

    // structuredContent notice discloses the cap + actionable recovery, never a
    // "full set" claim.
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/cap|only the first|incomplete/i);
    expect(notice).toMatch(/partitioned by year|year_start/i);
    expect(notice).not.toMatch(/full time-series analysis/i);

    // content[] twin agrees — the canvas table is incomplete, never "Full … staged".
    const text = commodityProfileTool
      .format(result)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toMatch(/incomplete/i);
    expect(text).not.toMatch(/Full merged set staged/i);
  }, 30_000);
});
