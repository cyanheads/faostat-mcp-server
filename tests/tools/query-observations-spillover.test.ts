/**
 * @fileoverview Regression for the spillover dead band (#1). A mid-size result
 * (more rows than the inline page `limit`, but few enough to serialize under the
 * canvas char budget) used to lose rows: the spill *decision* fired on a
 * row-count threshold while `spillover()` materialized against a *character*
 * budget, so in the dead band the helper returned `{spilled:false}` and the
 * handler re-capped output at `limit` — silently dropping rows and emitting an
 * "enable DataCanvas" notice even though DataCanvas was on.
 *
 * These tests run a real domain sync into a temp SQLite mirror and a real DuckDB
 * canvas, then assert the handler returns EVERY matched row inline with a
 * truthful notice (no row loss, no false "enable DataCanvas" advice), and still
 * spills to a canvas table when the result is genuinely large enough to overflow
 * the char budget.
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
  async function syncDomain(countryCount: number, aggregateCount: number): Promise<number> {
    const { zip, total } = buildMidSizeDomainZip({ countryCount, aggregateCount });
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

  it('returns ALL rows inline for a mid-size result (no dropped rows, no false canvas notice)', async () => {
    // 300 countries: well past the default inline page (limit 200) but only ~30k
    // serialized chars — squarely inside the old dead band.
    const total = await syncDomain(300, 0);
    expect(total).toBe(300);

    const ctx = createMockContext({ tenantId: 'spill-test', errors: queryObservationsTool.errors });
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
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

    expect(result.observations).toHaveLength(264);
    expect(result.spilled).toBe(false);
    // The requested aggregate rows (codes >= 5000) are present, not dropped.
    const aggregates = result.observations.filter((o) => o.area_code >= 5000);
    expect(aggregates).toHaveLength(36);

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
    const input = queryObservationsTool.input.parse({
      domain: FIXTURE_DOMAIN,
      item_codes: [15],
      element_codes: [5510],
      year_start: 2020,
      year_end: 2020,
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
});
