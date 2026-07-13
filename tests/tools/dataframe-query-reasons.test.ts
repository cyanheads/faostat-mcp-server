/**
 * @fileoverview `faostat_dataframe_query` error-contract reasons (#2). The SQL
 * gate (in `@cyanheads/mcp-ts-core`) rejects non-read-only or malformed SQL with
 * its own reason strings (`non_select_statement`, `multi_statement`, …). Those
 * used to bubble through undeclared while the tool advertised `invalid_sql`.
 * `queryStaged` normalizes those genuinely non-SELECT / denied / malformed-identifier
 * gate reasons to the stable server-owned `invalid_sql`, while `missing_table` and
 * `system_catalog_access` keep their own declared reasons.
 *
 * Since mcp-ts-core 0.10.8, a SELECT-shaped statement that parses but fails to
 * prepare for a non-table reason (a mistyped column) is classified NATIVELY by the
 * framework as `invalid_sql` with a DuckDB `data.binderMessage`. That already matches
 * the contract, so `queryStaged` passes it through untouched — the bad-column case
 * below is framework-native, not remap-driven, and the binder detail must survive.
 *
 * Runs a real DuckDB canvas with one staged table, then drives the gate through
 * the handler and asserts the surfaced `data.reason` matches the declared
 * contract. Also covers row_limit truncation disclosure (#10 — `truncated` and a
 * materialized `row_count`) and `canvas_id` selection (#11 — own-canvas sanity,
 * unknown token → `canvas_not_found`, and a second distinct canvas selected by id).
 * @module tests/tools/dataframe-query-reasons
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

let canvas: DataCanvas;

/** A handful of synthetic observation rows to register as one canvas table. */
function* sampleRows(): Generator<Record<string, unknown>> {
  for (let i = 1; i <= 5; i++) {
    yield { area_code: i, area: `Country ${i}`, value: 1000 + i, flag: 'A' };
  }
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

describe('faostat_dataframe_query error-contract reasons', () => {
  let tableName: string;
  // One ctx per test: the tool resolves the shared canvas from `ctx.state`
  // (key `canvas-id`), and the mock state is per-ctx, so staging and querying
  // must run on the same ctx for the handler to find the registered table.
  let ctx: Context;
  let seq = 0;

  beforeEach(async () => {
    ctx = createMockContext({ tenantId: `df-reasons-${seq++}`, errors: dataframeQueryTool.errors });
    const instance = await canvas.acquire(undefined, ctx);
    await ctx.state.set('canvas-id', instance.canvasId);
    const handle = await instance.registerTable('faostat_test_tbl', sampleRows(), {
      schema: [
        { name: 'area_code', type: 'BIGINT' },
        { name: 'area', type: 'VARCHAR' },
        { name: 'value', type: 'DOUBLE' },
        { name: 'flag', type: 'VARCHAR' },
      ],
    });
    tableName = handle.tableName;
  });

  const run = (sql: string) => {
    const input = dataframeQueryTool.input.parse({ sql });
    return dataframeQueryTool.handler(input, ctx);
  };

  it('declares the stable contract (invalid_sql, not raw gate reasons)', () => {
    const reasons = dataframeQueryTool.errors.map((e) => e.reason).sort();
    expect(reasons).toEqual([
      'canvas_disabled',
      'canvas_not_found',
      'invalid_sql',
      'missing_table',
      'system_catalog_access',
    ]);
  });

  it('remaps a non-SELECT statement (DROP) to invalid_sql', async () => {
    await expect(run(`DROP TABLE ${tableName}`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
  });

  it('remaps a multi-statement query to invalid_sql', async () => {
    await expect(run(`SELECT 1; SELECT 2`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
  });

  // A bad-column SELECT parses but fails to prepare; mcp-ts-core ≥0.10.8 classifies
  // this natively as `invalid_sql` and carries the DuckDB binder detail (the offending
  // column + candidate bindings) in `data.binderMessage`. queryStaged passes it through
  // unchanged — assert both the contract reason and that the binder detail survives.
  it('surfaces native invalid_sql (with binderMessage) for a SELECT with a bad column', async () => {
    await expect(run(`SELECT nonexistent_col FROM ${tableName}`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_sql',
        binderMessage: expect.stringContaining('nonexistent_col'),
      },
    });
  });

  it('keeps system_catalog_access for a denied catalog reference', async () => {
    await expect(run(`SELECT * FROM information_schema.tables`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'system_catalog_access' },
    });
  });

  it('keeps missing_table for an unknown faostat_ table', async () => {
    await expect(run(`SELECT * FROM faostat_does_not_exist`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table' },
    });
  });

  it('runs a valid SELECT against the staged table', async () => {
    const result = await run(`SELECT area_code, value FROM ${tableName} ORDER BY area_code`);
    expect(result.row_count).toBe(5);
    expect(result.rows).toHaveLength(5);
  });

  // #10 — row_limit truncation disclosure. The staged table holds 5 rows.
  it('sets truncated=true with row_count===rows.length when row_limit caps the result', async () => {
    const input = dataframeQueryTool.input.parse({
      sql: `SELECT * FROM ${tableName}`,
      row_limit: 2,
    });
    const result = await dataframeQueryTool.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(2);
    // The old `rowCount > rows.length` branch never fires on this path: both are 2.
    expect(result.row_count).toBe(result.rows.length);
    const text = dataframeQueryTool
      .format(result)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toMatch(/cap/i);
    expect(text).toMatch(/row_limit|ORDER BY|LIMIT\/OFFSET|GROUP BY/i);
  });

  it('sets truncated=false when row_limit is at least the row count', async () => {
    const input = dataframeQueryTool.input.parse({
      sql: `SELECT * FROM ${tableName}`,
      row_limit: 10,
    });
    const result = await dataframeQueryTool.handler(input, ctx);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(5);
    expect(result.row_count).toBe(5);
  });

  // #11 — canvas_id selection.
  it('accepts an explicit canvas_id for the session canvas (sanity)', async () => {
    const sessionId = await ctx.state.get<string>('canvas-id');
    const input = dataframeQueryTool.input.parse({
      sql: `SELECT area_code, value FROM ${tableName} ORDER BY area_code`,
      canvas_id: sessionId,
    });
    const result = await dataframeQueryTool.handler(input, ctx);
    expect(result.row_count).toBe(5);
    expect(result.rows).toHaveLength(5);
  });

  it('throws canvas_not_found for an unknown canvas_id (not the session canvas)', async () => {
    const input = dataframeQueryTool.input.parse({
      sql: `SELECT COUNT(*) AS n FROM ${tableName}`,
      canvas_id: 'zzzzzzzzzz',
    });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('selects a second, distinct canvas by id — returns ITS table, not the session canvas', async () => {
    const sessionId = await ctx.state.get<string>('canvas-id');
    // A second canvas on the same tenant, holding a differently-named table.
    const second = await canvas.acquire(undefined, ctx);
    expect(second.canvasId).not.toBe(sessionId);
    await second.registerTable(
      'faostat_second_tbl',
      [{ area_code: 99, area: 'Second Canvas', value: 5000, flag: 'E' }],
      {
        schema: [
          { name: 'area_code', type: 'BIGINT' },
          { name: 'area', type: 'VARCHAR' },
          { name: 'value', type: 'DOUBLE' },
          { name: 'flag', type: 'VARCHAR' },
        ],
      },
    );

    const onSecond = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({
        sql: 'SELECT area, value FROM faostat_second_tbl',
        canvas_id: second.canvasId,
      }),
      ctx,
    );
    expect(onSecond.rows).toHaveLength(1);
    expect(onSecond.rows[0]).toMatchObject({ area: 'Second Canvas' });

    // The session canvas cannot see the second canvas's table — isolation holds.
    await expect(run('SELECT area FROM faostat_second_tbl')).rejects.toMatchObject({
      data: { reason: 'missing_table' },
    });
  });
});
