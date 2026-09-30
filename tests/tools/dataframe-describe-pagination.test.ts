/**
 * @fileoverview Bounded listing for `faostat_dataframe_describe`. The tool
 * returned every staged table on the canvas — each with its full column schema —
 * with no cap and no way to page, so a session that spills repeatedly grew an
 * unbounded response until the 2h table TTL swept it. These lock the fix:
 * `offset` + `limit` page the newest-first listing, `truncated` / `nextOffset`
 * disclose the cap and the exact next retrieval input, consecutive pages tile
 * the staged set gap- and duplicate-free, `totalMatches` reports the whole set
 * behind the page, an offset past the end reads as such rather than as an empty
 * canvas, and a `name` lookup stays single-page — `limit` never binds there, so
 * `truncated` must stay false rather than name a ceiling that did not apply.
 * @module tests/tools/dataframe-describe-pagination
 */

import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { OBSERVATION_TABLE_SCHEMA, stageObservations } from '@/services/canvas-staging.js';

let canvas: DataCanvas;

/** A mock context typed against the tool's declared error contract. */
const makeCtx = (tenantId: string) =>
  createMockContext({ tenantId, errors: dataframeDescribeTool.errors });

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

/**
 * Stage `count` tables onto one context's shared canvas. `previewLimit: 0`
 * forces registration for a row set far under the character budget, so the
 * listing can be grown to an arbitrary size without staging real cube volume.
 */
async function stageTables(ctx: ReturnType<typeof makeCtx>, count: number): Promise<string[]> {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const staged = await stageObservations(
      ctx,
      [{ area_code: i, area: `Country ${i}`, value: 100 + i, flag: 'A' }],
      {
        sourceTool: 'faostat_query_observations',
        schema: OBSERVATION_TABLE_SCHEMA,
        queryParams: { domain: 'QCL', item_codes: [i] },
        previewLimit: 0,
      },
    );
    if (!staged?.spilled) throw new Error('expected the staging helper to register a table');
    names.push(staged.tableName);
  }
  return names;
}

/** Run the tool on `ctx`; return the result plus its enrichment. */
async function describe_(ctx: ReturnType<typeof makeCtx>, input: Record<string, unknown> = {}) {
  const result = await dataframeDescribeTool.handler(dataframeDescribeTool.input.parse(input), ctx);
  return { result, enrichment: getEnrichment(ctx) };
}

describe('faostat_dataframe_describe bounded listing', () => {
  it('pages the staged tables with nextOffset and a continue notice, no gaps or duplicates', async () => {
    const ctx = makeCtx('describe-paging');
    const staged = await stageTables(ctx, 7);

    const page1 = await describe_(ctx, { limit: 3, offset: 0 });
    expect(page1.result.tables).toHaveLength(3);
    expect(page1.enrichment.totalMatches).toBe(7);
    expect(page1.enrichment.truncated).toBe(true);
    expect(page1.enrichment.nextOffset).toBe(3);
    expect(page1.enrichment.notice).toMatch(/offset 3/);
    expect(page1.enrichment.notice).toMatch(/next page/i);

    const page2 = await describe_(ctx, { limit: 3, offset: 3 });
    expect(page2.result.tables).toHaveLength(3);
    expect(page2.enrichment.nextOffset).toBe(6);

    // The final page drains the tail and stops paging.
    const page3 = await describe_(ctx, { limit: 3, offset: 6 });
    expect(page3.result.tables).toHaveLength(1);
    expect(page3.enrichment.truncated).toBe(false);

    // Consecutive pages tile the staged set exactly — no gaps, no duplicates.
    const seen = [page1, page2, page3].flatMap((p) => p.result.tables.map((t) => t.name));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...staged].sort());
  });

  it('omits nextOffset when the whole staged set fits in one page', async () => {
    const ctx = makeCtx('describe-single-page');
    await stageTables(ctx, 3);

    const { result, enrichment } = await describe_(ctx, { limit: 5 });
    expect(result.tables).toHaveLength(3);
    expect(enrichment.totalMatches).toBe(3);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('caps an unbounded listing call at the default and discloses the full count', async () => {
    const ctx = makeCtx('describe-default-cap');
    await stageTables(ctx, 25);

    // No limit passed — the default must bound the response rather than dumping
    // every staged table with its full column schema, and must say so.
    const { result, enrichment } = await describe_(ctx);
    const defaultLimit = dataframeDescribeTool.input.parse({}).limit as number;
    expect(result.tables).toHaveLength(defaultLimit);
    expect(enrichment.totalMatches).toBe(25);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.nextOffset).toBe(defaultLimit);
  });

  it('reports an offset past the end without pretending the canvas is empty', async () => {
    const ctx = makeCtx('describe-offset-past-end');
    await stageTables(ctx, 3);

    const { result, enrichment } = await describe_(ctx, { limit: 5, offset: 99 });
    expect(result.tables).toEqual([]);
    expect(enrichment.totalMatches).toBe(3);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toMatch(/Offset 99 is past the 3 staged table\(s\)/);
  });

  it('keeps a name lookup single-page — limit never binds, so truncated stays false', async () => {
    const ctx = makeCtx('describe-name-lookup');
    const staged = await stageTables(ctx, 5);
    const target = staged[2];
    if (!target) throw new Error('expected a staged table to look up');

    // limit 1 is below the 5 staged tables: were the cap applied to a name
    // lookup, truncated would read true and advertise a page that does not exist.
    const { result, enrichment } = await describe_(ctx, { name: target, limit: 1, offset: 4 });
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.name).toBe(target);
    expect(enrichment.totalMatches).toBe(1);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('still throws missing_table for a name miss, not an empty page', async () => {
    const ctx = makeCtx('describe-name-miss');
    await stageTables(ctx, 2);

    await expect(
      describe_(ctx, { name: 'faostat_does_not_exist', limit: 1 }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table' },
    });
  });

  it('points an empty canvas at the tools that stage a table', async () => {
    const ctx = makeCtx('describe-empty');
    const { result, enrichment } = await describe_(ctx);
    expect(result.tables).toEqual([]);
    expect(enrichment.totalMatches).toBe(0);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toMatch(/No tables are staged/i);
    expect(enrichment.notice).toMatch(/faostat_query_observations/);
  });

  it('renders only the current page into content[], so both surfaces agree', async () => {
    const ctx = makeCtx('describe-format-page');
    const staged = await stageTables(ctx, 6);

    const { result } = await describe_(ctx, { limit: 2, offset: 0 });
    const text = (dataframeDescribeTool.format?.(result) ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toContain('**2 staged table(s):**');
    const shown = result.tables.map((t) => t.name);
    for (const name of shown) expect(text).toContain(`### ${name}`);
    // Tables on later pages must not leak into this page's render.
    for (const name of staged.filter((n) => !shown.includes(n))) {
      expect(text).not.toContain(`### ${name}`);
    }
  });
});
