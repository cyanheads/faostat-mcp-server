/**
 * @fileoverview Regression for the spillover dead band (#1). A mid-size result
 * (more rows than the inline page `limit`, but few enough to serialize under the
 * canvas char budget) used to lose rows: the spill *decision* fired on a
 * row-count threshold while `spillover()` materialized against a *character*
 * budget, so in the dead band the helper returned `{spilled:false}` and the
 * handler re-capped output at `limit` — silently dropping rows and emitting an
 * "enable DataCanvas" notice even though DataCanvas was on.
 *
 * Closing that band by returning the whole buffered set then left `limit`
 * unenforced for those same mid-size results (#14). The contract both issues
 * settle on: the inline page never exceeds `limit`, and a match that outgrows the
 * page is staged in full to a canvas table — so capping the page never costs
 * reachability.
 *
 * These tests run a real domain sync into a temp SQLite mirror and a real DuckDB
 * canvas, then assert the inline page honors `limit`, every matched row is
 * reachable (inline when it fits, on the staged table otherwise), the notice is
 * truthful (no false "enable DataCanvas" advice), and the char-budget spill path
 * still works for genuinely large results. The one path where no table can hold
 * the remainder — a canvas op that fails outright — is covered too: it must
 * disclose the shortfall rather than pass a capped page off as the whole result.
 * @module tests/tools/query-observations-spillover
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { STAGE_MAX_ROWS } from '@/services/canvas-staging.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** Real DuckDB canvas shared across the suite (lazy-loads `@duckdb/node-api`). */
let canvas: DataCanvas;

beforeAll(() => {
  // CANVAS_PROVIDER_TYPE=duckdb makes the factory build an in-process DuckDB
  // canvas — the same engine the server runs, so the spill path is exercised for
  // real rather than faked.
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

describe('faostat_query_observations spillover dead band', () => {
  let dir: string;
  let mirror: FaostatMirror;

  /** Sync a synthetic domain of `country + aggregate` rows into a fresh mirror. */
  async function syncDomain(
    countryCount: number,
    aggregateCount: number,
    years = 1,
  ): Promise<number> {
    const { zip, total } = buildMidSizeDomainZip({ countryCount, aggregateCount, years });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 256)),
    );
    mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
    return total;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-spill-'));
  });

  afterEach(async () => {
    await mirror?.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a result within the inline budget inline — the probe never spills at the boundary', async () => {
    // Exactly INLINE_PREVIEW_ROWS (50) country rows: the LIMIT probe returns the
    // exact count and the tool stays inline without staging to a canvas — the same
    // decision the old COUNT(*) made, now without scanning the whole cube.
    const total = await syncDomain(50, 0);
    expect(total).toBe(50);

    const ctx = createMockContext({
      tenantId: 'spill-boundary',
      errors: queryObservationsTool.errors,
    });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
    });

    const result = await queryObservationsTool.handler(input, ctx);

    expect(result.observations).toHaveLength(50);
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    // Exact total surfaced from the probe (not a floor) — the match fit the budget.
    expect(getEnrichment(ctx).totalCount).toBe(50);
  });

  it('returns a mid-size result whole inline when it fits under limit (no dropped rows, no false canvas notice)', async () => {
    // 300 countries and a limit that covers them: the stream drains under both the
    // char budget and the caller's inline budget, so every row comes back inline
    // with no canvas table — the #1 guarantee, stated as the caller's own cap.
    const total = await syncDomain(300, 0);
    expect(total).toBe(300);

    const ctx = createMockContext({ tenantId: 'spill-test', errors: queryObservationsTool.errors });
    // include_aggregates so the synthetic codes 1..300 (which include real FAOSTAT
    // roll-up codes like 265) aren't deny-set-excluded — this test exercises the
    // spillover dead band, not aggregate classification (#4).
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
      include_aggregates: true,
      limit: 300,
    });

    const result = await queryObservationsTool.handler(input, ctx);

    // No row loss: every matched row is reachable inline.
    expect(result.observations).toHaveLength(300);
    // It fit under the char budget, so no canvas table was registered.
    expect(result.spilled).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();

    // Row identity preserved end-to-end — codes 1..300, no gaps, no dupes.
    const codes = result.observations.map((o) => o.area_code).sort((a, b) => a - b);
    expect(codes[0]).toBe(1);
    expect(codes.at(-1)).toBe(300);
    expect(new Set(codes).size).toBe(300);
    // Values round-trip from the mirror (value = 1000 + area_code).
    for (const o of result.observations) {
      expect(o.value).toBe(1000 + o.area_code);
      expect(o.flag).not.toBeNull();
    }

    // The notice must NOT tell the caller to enable an already-on DataCanvas.
    const notice = getEnrichment(ctx).notice as string | undefined;
    if (notice !== undefined) {
      expect(notice).not.toMatch(/enable datacanvas/i);
      expect(notice).not.toMatch(/CANVAS_PROVIDER_TYPE/i);
    }
  });

  it('caps the inline page at limit and stages the whole mid-size set to a canvas table (#14)', async () => {
    // Same 300-row mid-size match under the DEFAULT limit (200). The inline page
    // honors `limit` — but the rows past it are on the canvas table, not dropped,
    // which is what keeps #1 closed while the input contract is honored.
    const total = await syncDomain(300, 0);
    expect(total).toBe(300);

    const ctx = createMockContext({ tenantId: 'spill-cap', errors: queryObservationsTool.errors });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
      include_aggregates: true,
    });

    const result = await queryObservationsTool.handler(input, ctx);

    expect(result.observations).toHaveLength(200);
    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.staged_row_count).toBe(300);
    expect(getEnrichment(ctx).totalCount).toBe(300);

    // Every matched row — including the 100 past the inline page — is on the table.
    const instance = await canvas.acquire(result.canvas_id, ctx);
    const staged = await instance.query(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT area_code) AS areas, MIN(area_code) AS lo, MAX(area_code) AS hi FROM ${result.table_name}`,
      { rowLimit: 1, denySystemCatalogs: true },
    );
    expect(Number(staged.rows[0]?.n)).toBe(300);
    expect(Number(staged.rows[0]?.areas)).toBe(300);
    expect(Number(staged.rows[0]?.lo)).toBe(1);
    expect(Number(staged.rows[0]?.hi)).toBe(300);

    // The notice points at the table and never advises enabling an already-on canvas.
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/staged on canvas table/i);
    expect(notice).toMatch(/first 200/);
    expect(notice).not.toMatch(/enable datacanvas/i);
  });

  it('honors an explicit small limit on a mid-size match, full set still reachable (#14)', async () => {
    // The issue's repro: 238 matches with limit 1 used to return all 238 inline.
    const total = await syncDomain(238, 0);
    expect(total).toBe(238);

    const ctx = createMockContext({
      tenantId: 'spill-limit-1',
      errors: queryObservationsTool.errors,
    });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
      include_aggregates: true,
      limit: 1,
    });

    const result = await queryObservationsTool.handler(input, ctx);

    expect(result.observations).toHaveLength(1);
    expect(result.spilled).toBe(true);
    expect(result.staged_row_count).toBe(238);
    expect(getEnrichment(ctx).totalCount).toBe(238);

    const instance = await canvas.acquire(result.canvas_id, ctx);
    const counted = await instance.query(`SELECT COUNT(*) AS n FROM ${result.table_name}`, {
      rowLimit: 1,
      denySystemCatalogs: true,
    });
    expect(Number(counted.rows[0]?.n)).toBe(238);

    // content[] twin carries the same one-row page, not a different slice.
    const text = queryObservationsTool
      .format(result)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toMatch(/\*\*1 observation\(s\)\*\*/);
    expect(text).toMatch(new RegExp(String(result.table_name)));
  });

  it('discloses the shortfall when staging fails and the response falls back to an inline page', async () => {
    // An unknown canvas_id makes the staging layer's acquire throw, so it returns
    // undefined and the handler falls back to the inline page. The probe fetches
    // max(limit, 50) rows, so at the default limit the page length equals the
    // reported total — the row comparison alone cannot see the shortfall, and
    // without the totalIsExact trigger this returned 200 of 300 rows announcing
    // itself as the whole exact result, with no table holding the rest.
    const total = await syncDomain(300, 0);
    expect(total).toBe(300);

    const ctx = createMockContext({
      tenantId: 'spill-canvas-fail',
      errors: queryObservationsTool.errors,
    });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
      include_aggregates: true,
      canvas_id: 'no-such-canvas',
    });

    const result = await queryObservationsTool.handler(input, ctx);

    expect(result.observations).toHaveLength(200);
    expect(result.spilled).toBe(false);
    expect(result.table_name).toBeUndefined();

    // The notice names the shortfall as a floor and says no table holds the rest.
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/more than 200/);
    expect(notice).toMatch(/failed/i);
    expect(notice).toMatch(/raise limit/i);
  });

  it('matches the issue repro shape: mid-size with aggregates included, every row reachable', async () => {
    // 264-row analogue of the issue's RL repro: 228 countries + 36 aggregates.
    const total = await syncDomain(228, 36);
    expect(total).toBe(264);

    const ctx = createMockContext({
      tenantId: 'spill-test-2',
      errors: queryObservationsTool.errors,
    });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
      include_aggregates: true,
    });

    const result = await queryObservationsTool.handler(input, ctx);

    // Past the default limit, so the set stages; the inline page is the cap.
    expect(result.observations).toHaveLength(200);
    expect(result.spilled).toBe(true);

    // The requested aggregate rows (codes >= 5000) are present on the staged
    // table, not dropped — all 36 of them, whether or not they made the page.
    const instance = await canvas.acquire(result.canvas_id, ctx);
    const staged = await instance.query(
      `SELECT COUNT(*) AS n FROM ${result.table_name} WHERE area_code >= 5000`,
      { rowLimit: 1, denySystemCatalogs: true },
    );
    expect(Number(staged.rows[0]?.n)).toBe(36);

    const totalCount = (getEnrichment(ctx).totalCount as number | undefined) ?? 0;
    expect(totalCount).toBe(264);
  });

  it('still spills to a canvas table when the result overflows the char budget', async () => {
    // 1200 countries (~120k+ serialized chars) overflows the 100k inline budget,
    // so the helper registers a canvas table and returns a token + preview.
    const total = await syncDomain(1200, 0);
    expect(total).toBe(1200);

    const ctx = createMockContext({
      tenantId: 'spill-test-3',
      errors: queryObservationsTool.errors,
    });
    // include_aggregates so the synthetic codes 1..1200 (which include real FAOSTAT
    // roll-up codes like 265/351) aren't deny-set-excluded — this test exercises the
    // char-budget spill, not aggregate classification (#4).
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
      include_aggregates: true,
    });

    const result = await queryObservationsTool.handler(input, ctx);

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBeDefined();
    expect(result.table_name).toBeDefined();
    // The preview is a slice, not the whole set — the full set lives on the table.
    expect(result.observations.length).toBeLessThan(1200);
    expect(result.observations.length).toBeGreaterThan(0);

    // The spill notice points at the canvas table, and the full set is reachable
    // there via the staging layer (acquire the same shared canvas + count rows).
    const notice = getEnrichment(ctx).notice as string | undefined;
    expect(notice).toMatch(/staged on canvas table/i);

    const instance = await canvas.acquire(result.canvas_id, ctx);
    const counted = await instance.query(`SELECT COUNT(*) AS n FROM ${result.table_name}`, {
      rowLimit: 1,
      denySystemCatalogs: true,
    });
    expect(Number(counted.rows[0]?.n)).toBe(1200);
  });

  it('discloses truncation honestly when the staged set hits the 50k cap (never "complete") (#9)', async () => {
    // 260 countries × 200 years = 52,000 country rows (codes < 5000, so none are
    // excluded as aggregates) — past STAGE_MAX_ROWS (50k). The spill helper caps the
    // table at the limit and reports truncated; the tool must surface that, not
    // claim a complete set.
    const total = await syncDomain(260, 0, 200);
    expect(total).toBe(52_000);
    expect(total).toBeGreaterThan(STAGE_MAX_ROWS);

    const ctx = createMockContext({
      tenantId: 'spill-trunc',
      errors: queryObservationsTool.errors,
    });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
    });

    const result = await queryObservationsTool.handler(input, ctx);

    // The staged table is a capped prefix — and the output says so.
    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.staged_row_count).toBe(STAGE_MAX_ROWS);
    expect(result.canvas_id).toBeDefined();
    expect(result.table_name).toBeDefined();

    // structuredContent notice discloses the cap + actionable recovery, and never
    // claims completeness.
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/staging cap|only the first/i);
    expect(notice).toMatch(/partition|year_start|narrower/i);
    expect(notice).not.toMatch(/complete set/i);
    expect(notice).not.toMatch(/over the full set/i);

    // content[] twin agrees — INCOMPLETE, never "the complete set".
    const text = queryObservationsTool
      .format(result)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toMatch(/INCOMPLETE|Partial result/i);
    expect(text).not.toMatch(/query the table for the complete set/i);

    // The staged table really is capped at STAGE_MAX_ROWS (not the full 52k match).
    const instance = await canvas.acquire(result.canvas_id, ctx);
    const counted = await instance.query(`SELECT COUNT(*) AS n FROM ${result.table_name}`, {
      rowLimit: 1,
      denySystemCatalogs: true,
    });
    expect(Number(counted.rows[0]?.n)).toBe(STAGE_MAX_ROWS);
  }, 30_000);
});
