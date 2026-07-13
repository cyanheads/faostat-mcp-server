/**
 * @fileoverview The dataframe tools' `canvas_id` is optional AND honored (#11).
 * The schema cases assert an omitted `canvas_id` still parses — the handlers
 * resolve the session's shared canvas from `ctx.state`, so requiring it only
 * added friction and broke the discovery call (`faostat_dataframe_describe` with
 * no args). The handler cases assert `faostat_dataframe_describe` acts on the
 * token: an explicit id for the session's own canvas lists its tables, an unknown
 * id throws `canvas_not_found` (NotFound) instead of silently listing the session
 * canvas, and a valid id for a second, distinct canvas lists ONLY that canvas's
 * tables — closing the leak where a valid-but-different id returned the wrong
 * canvas's metadata.
 * @module tests/tools/dataframe-canvas-id-optional
 */

import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { stageObservations } from '@/services/canvas-staging.js';

describe('faostat_dataframe_describe input', () => {
  it('accepts no arguments (canvas_id omitted — the discovery call)', () => {
    expect(() => dataframeDescribeTool.input.parse({})).not.toThrow();
    const parsed = dataframeDescribeTool.input.parse({});
    expect(parsed.canvas_id).toBeUndefined();
  });

  it('still accepts an explicit canvas_id and table name', () => {
    const parsed = dataframeDescribeTool.input.parse({
      canvas_id: 'abc1234567',
      name: 'faostat_xyz',
    });
    expect(parsed.canvas_id).toBe('abc1234567');
    expect(parsed.name).toBe('faostat_xyz');
  });
});

describe('faostat_dataframe_query input', () => {
  it('accepts a SQL-only call with canvas_id omitted', () => {
    const parsed = dataframeQueryTool.input.parse({ sql: 'SELECT 1' });
    expect(parsed.canvas_id).toBeUndefined();
    expect(parsed.sql).toBe('SELECT 1');
    expect(parsed.row_limit).toBe(1000); // default applies
  });

  it('still requires sql', () => {
    expect(() => dataframeQueryTool.input.parse({ canvas_id: 'abc1234567' })).toThrow();
  });
});

/**
 * Enough synthetic rows to overflow the ~100k-char inline budget so
 * `stageObservations` spills and persists `StagedTableMeta` — the only path that
 * writes the metadata `dataframe_describe` lists.
 */
function* manyRows(label: string): Generator<Record<string, unknown>> {
  for (let i = 1; i <= 2000; i++) {
    yield { area_code: i, area: `${label} country ${i}`, value: 1000 + i, flag: 'A' };
  }
}

describe('faostat_dataframe_describe honors canvas_id (handler behavior)', () => {
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

  it('lists the session canvas tables when canvas_id is omitted or matches it', async () => {
    const ctx = createMockContext({
      tenantId: 'df-describe-own',
      errors: dataframeDescribeTool.errors,
    });
    const staged = await stageObservations(ctx, manyRows('own'), {
      sourceTool: 'faostat_query_observations',
      queryParams: { domain: 'QCL' },
    });
    expect(staged?.spilled).toBe(true);

    // Omitted canvas_id → the session canvas → the staged table is listed.
    const omitted = await dataframeDescribeTool.handler(dataframeDescribeTool.input.parse({}), ctx);
    expect(omitted.tables.map((t) => t.name)).toContain(staged?.tableName);

    // Explicit session canvas_id → same result.
    const explicit = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ canvas_id: staged?.canvasId }),
      ctx,
    );
    expect(explicit.tables.map((t) => t.name)).toContain(staged?.tableName);
  });

  it('throws canvas_not_found for an unknown canvas_id (not the session canvas)', async () => {
    const ctx = createMockContext({
      tenantId: 'df-describe-unknown',
      errors: dataframeDescribeTool.errors,
    });
    await stageObservations(ctx, manyRows('own'), {
      sourceTool: 'faostat_query_observations',
      queryParams: { domain: 'QCL' },
    });

    await expect(
      dataframeDescribeTool.handler(
        dataframeDescribeTool.input.parse({ canvas_id: 'zzzzzzzzzz' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('lists only the selected canvas tables for a second, distinct canvas', async () => {
    const ctx = createMockContext({
      tenantId: 'df-describe-cross',
      errors: dataframeDescribeTool.errors,
    });
    // Table A on the session (shared) canvas.
    const a = await stageObservations(ctx, manyRows('session'), {
      sourceTool: 'faostat_query_observations',
      queryParams: { domain: 'QCL' },
    });
    // Table B on a second, distinct canvas.
    const second = await canvas.acquire(undefined, ctx);
    expect(second.canvasId).not.toBe(a?.canvasId);
    const b = await stageObservations(ctx, manyRows('second'), {
      sourceTool: 'faostat_commodity_profile',
      queryParams: { domain: 'TCL' },
      canvasId: second.canvasId,
    });
    expect(b?.canvasId).toBe(second.canvasId);

    // Describe the second canvas → only table B, never table A.
    const onSecond = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ canvas_id: second.canvasId }),
      ctx,
    );
    const secondNames = onSecond.tables.map((t) => t.name);
    expect(secondNames).toContain(b?.tableName);
    expect(secondNames).not.toContain(a?.tableName);

    // And the session canvas lists table A, not table B.
    const onSession = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({}),
      ctx,
    );
    const sessionNames = onSession.tables.map((t) => t.name);
    expect(sessionNames).toContain(a?.tableName);
    expect(sessionNames).not.toContain(b?.tableName);
  });
});
