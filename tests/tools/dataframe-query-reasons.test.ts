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
 * materialized `row_count`), `canvas_id` selection (#11 — own-canvas sanity,
 * unknown token → `canvas_not_found`, and a second distinct canvas selected by id),
 * and `row_limit` above its cap (#56 — served at the canvas's configured row limit,
 * whatever that is, never failing on the canvas's own bound).
 * @module tests/tools/dataframe-query-reasons
 */

import { type AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withStrictCountInputs } from '@/mcp-server/tools/count-input.js';
import {
  dataframeQueryRegistration,
  dataframeQueryTool,
} from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { PROFILE_TABLE_SCHEMA } from '@/services/canvas-staging.js';
import { renderCell } from '../helpers/markdown-table.js';

let canvas: DataCanvas;

/** A fresh mock context typed against the tool's declared error contract. */
const makeCtx = (tenantId: string) =>
  createMockContext({ tenantId, errors: dataframeQueryTool.errors });

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
  let ctx: ReturnType<typeof makeCtx>;
  let seq = 0;

  beforeEach(async () => {
    ctx = makeCtx(`df-reasons-${seq++}`);
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
    const reasons = (dataframeQueryTool.errors ?? []).map((e) => e.reason).sort();
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

  // A gated SELECT that prepares cleanly and then fails on the staged data — a cast
  // no row value can satisfy. The framework classifies it as ValidationError with
  // data.reason `sql_execution_error`, which this tool never declares, so queryStaged
  // folds it into the advertised `invalid_sql` and keeps the engine's own recovery hint.
  it('remaps a DuckDB execution-time data error to invalid_sql', async () => {
    await expect(run(`SELECT CAST(area AS INTEGER) AS n FROM ${tableName}`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_sql',
        recovery: { hint: expect.stringMatching(/TRY_CAST/i) },
      },
    });
  });

  it('keeps system_catalog_access for a denied catalog reference', async () => {
    await expect(run(`SELECT * FROM information_schema.tables`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'system_catalog_access' },
    });
  });

  /**
   * The SQL gate reads names, not their role: a name spelled like a DuckDB internal
   * metadata view is refused wherever it stands as an identifier. Each statement is
   * built twice: once with the view's spelling, once with the identifier renamed.
   */
  describe('a name spelled like an internal metadata view', () => {
    const declared = dataframeQueryTool.errors?.find(
      (e) => e.reason === 'system_catalog_access',
    )?.recovery;

    /** Run `sql` through the contract runner against this test's staged canvas. */
    const contract = async (sql: string) => {
      const canvasId = await ctx.state.get<string>('canvas-id');
      if (!canvasId || !ctx.tenantId) throw new Error('Expected a staged session canvas');
      return surfaces(
        await runToolContract(
          dataframeQueryTool,
          { sql, canvas_id: canvasId },
          { context: { tenantId: ctx.tenantId } },
        ),
      );
    };

    it('is declared with a recovery that says to rename it', () => {
      expect(declared).toContain('rename any column alias, CTE, or table alias');
    });

    it.each([
      [
        'a bare column alias',
        'duckdb_tables',
        (t: string, n: string) => `SELECT area AS ${n} FROM ${t}`,
      ],
      [
        'a double-quoted column alias',
        'duckdb_tables',
        (t: string, n: string) => `SELECT area AS "${n}" FROM ${t}`,
      ],
      [
        'an upper-case column alias',
        'duckdb_tables',
        (t: string, n: string) => `SELECT area AS ${n.toUpperCase()} FROM ${t}`,
      ],
      [
        'a CTE name',
        'pg_tables',
        (t: string, n: string) => `WITH ${n} AS (SELECT area FROM ${t}) SELECT area FROM ${n}`,
      ],
      [
        'a table alias',
        'pg_tables',
        (t: string, n: string) => `SELECT ${n}.area FROM ${t} AS ${n}`,
      ],
    ])(
      'as %s is refused with the declared recovery, and answers once renamed',
      async (_role, view, build) => {
        const refused = await contract(build(tableName, view));
        expect(refused.structured.error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'system_catalog_access', recovery: { hint: declared } },
        });
        // content[] escapes Markdown punctuation (`faostat\_\<id>`); compare what renders.
        expect(renderCell(refused.text)).toContain(`Recovery: ${declared}`);

        const renamed = await contract(build(tableName, 'picked'));
        expect(renamed.structured.error).toBeUndefined();
        expect(renamed.structured.rows).toHaveLength(5);
      },
    );

    it('inside a string literal is not refused', async () => {
      const { structured } = await contract(
        `SELECT area, 'duckdb_tables' AS label FROM ${tableName} WHERE area <> 'pg_tables'`,
      );
      expect(structured.error).toBeUndefined();
      expect(structured.rows).toHaveLength(5);
      expect(structured.rows?.[0]).toMatchObject({ label: 'duckdb_tables' });
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

  it('returns an empty SQL page with filter guidance on both public surfaces', async () => {
    const canvasId = await ctx.state.get<string>('canvas-id');
    if (!canvasId) throw new Error('Expected a staged session canvas');
    const tenantId = ctx.tenantId;
    if (!tenantId) throw new Error('Expected the fixture tenant');
    const wire = await runToolContract(
      dataframeQueryTool,
      {
        sql: `SELECT area_code, flag FROM ${tableName} ORDER BY area_code LIMIT 2 OFFSET 5`,
        canvas_id: canvasId,
      },
      { context: { tenantId } },
    );
    expect(wire.isError).not.toBe(true);
    expect(wire.structuredContent).toMatchObject({ rows: [], row_count: 0, truncated: false });
    const text = wire.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    expect(text).toContain('_No rows._');
    expect(text).toContain('Query returned 0 rows');
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
    const text = (dataframeQueryTool.format?.(result) ?? [])
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

describe('faostat_dataframe_query sql description', () => {
  it('names every column a staged table can carry', () => {
    const listed = new Set(dataframeQueryTool.input.shape.sql.description?.match(/\b[a-z_]+\b/g));
    const missing = PROFILE_TABLE_SCHEMA.map((column) => column.name).filter(
      (name) => !listed.has(name),
    );
    expect(missing).toEqual([]);
  });
});

/** What a client reads from a `runToolContract` result: both surfaces. */
function surfaces(wire: Awaited<ReturnType<typeof runToolContract>>) {
  const structured = (wire.structuredContent ?? {}) as Record<string, unknown> & {
    rows?: unknown[];
    notice?: string;
  };
  const text = wire.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return { structured, text };
}

/** The `row_limit` input as `tools/list` advertises it. */
const rowLimitOf = (definition: AnyToolDefinition) =>
  z.toJSONSchema(definition.input, { io: 'input' }).properties?.row_limit;

/** The truncation sentence for `rows` returned, with the raise-row_limit route when it applies. */
const truncationSentence = (rows: number, raiseTo?: number) =>
  `Returned ${rows} rows — capped at row_limit, more rows exist (no exact total on this path). To reach the rest: page deterministically with ORDER BY plus SQL LIMIT/OFFSET${raiseTo === undefined ? '' : `, raise row_limit (at most ${raiseTo} per call)`}, or aggregate with GROUP BY.`;

describe('faostat_dataframe_query row_limit above the default canvas row limit (#56)', () => {
  /** The framework's default canvas row limit, which `dataframeQueryTool` is capped at. */
  const CAP = 10_000;
  const TENANT = 'df-row-limit';
  let canvasId: string;
  let sql: string;

  beforeAll(async () => {
    const ctx = makeCtx(TENANT);
    const instance = await canvas.acquire(undefined, ctx);
    canvasId = instance.canvasId;
    function* rows(): Generator<Record<string, unknown>> {
      for (let i = 1; i <= 20_000; i++) yield { area_code: i, flag: 'A' };
    }
    const { tableName } = await instance.registerTable('faostat_big_tbl', rows(), {
      schema: [
        { name: 'area_code', type: 'BIGINT' },
        { name: 'flag', type: 'VARCHAR' },
      ],
    });
    sql = `SELECT area_code, flag FROM ${tableName} ORDER BY area_code LIMIT 20000`;
  });

  const call = (args: { row_limit?: number; sql?: string }) =>
    runToolContract(
      dataframeQueryTool,
      { canvas_id: canvasId, sql, ...args },
      { context: { tenantId: TENANT } },
    );

  it('serves row_limit 50000 over SELECT … LIMIT 20000 as 10000 rows, truncated, on both surfaces', async () => {
    const wire = await call({ row_limit: 50_000 });
    expect(wire.isError).not.toBe(true);
    const { structured, text } = surfaces(wire);
    expect(structured.rows).toHaveLength(CAP);
    expect(structured).toMatchObject({
      row_count: CAP,
      truncated: true,
      requestedRowLimit: 50_000,
      effectiveRowLimit: CAP,
    });
    const notice = `row_limit 50000 is above the 10000 cap; returned up to 10000. ${truncationSentence(CAP)}`;
    expect(structured.notice).toBe(notice);
    expect(text).toContain('**10000 rows** (truncated — capped at row_limit, more rows exist)');
    expect(text).toContain('**requestedRowLimit:** 50000');
    expect(text).toContain('**effectiveRowLimit:** 10000');
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('raise row_limit');
  });

  it('serves row_limit at the cap as asked, with no clamp fields and no raise route', async () => {
    const wire = await call({ row_limit: CAP });
    expect(wire.isError).not.toBe(true);
    const { structured, text } = surfaces(wire);
    expect(structured.rows).toHaveLength(CAP);
    expect(structured.truncated).toBe(true);
    expect(structured).not.toHaveProperty('requestedRowLimit');
    expect(structured).not.toHaveProperty('effectiveRowLimit');
    expect(structured.notice).toBe(truncationSentence(CAP));
    expect(text).not.toContain('requestedRowLimit');
    expect(text).toContain(`> ${truncationSentence(CAP)}`);
    expect(text).not.toContain('raise row_limit');
  });

  it('names raising row_limit, up to the cap, while row_limit is below it', async () => {
    const wire = await call({ row_limit: 2 });
    const { structured, text } = surfaces(wire);
    expect(structured.rows).toHaveLength(2);
    expect(structured.notice).toBe(truncationSentence(2, CAP));
    expect(text).toContain(`> ${truncationSentence(2, CAP)}`);
  });

  it('leads with the clamp sentence on an empty result too, logging the clamp once', async () => {
    const ctx = makeCtx(TENANT);
    const result = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({
        canvas_id: canvasId,
        sql: sql.replace('ORDER BY', 'WHERE area_code < 0 ORDER BY'),
        row_limit: CAP + 1,
      }),
      ctx,
    );
    expect(result).toMatchObject({ rows: [], row_count: 0, truncated: false });
    expect(getEnrichment(ctx)).toEqual({
      requestedRowLimit: CAP + 1,
      effectiveRowLimit: CAP,
      notice:
        'row_limit 10001 is above the 10000 cap; returned up to 10000. Query returned 0 rows. Verify table names with faostat_dataframe_describe and check the WHERE conditions.',
    });
    const clampLines = (ctx.log as MockContextLogger).calls.filter((c) =>
      c.msg.startsWith('Count input above its cap'),
    );
    expect(clampLines).toHaveLength(1);
  });

  it('advertises row_limit with no maximum, and with maximum 10000 when registered strict', () => {
    const description = 'Hard cap on rows in the response, at most 10000 per call.';
    expect(rowLimitOf(dataframeQueryTool)).toEqual({
      type: 'integer',
      minimum: 1,
      default: 1000,
      description,
    });
    expect(rowLimitOf(withStrictCountInputs(dataframeQueryTool))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: CAP,
      default: 1000,
      description,
    });
  });
});

/**
 * A deployment that sets `CANVAS_DEFAULT_ROW_LIMIT` below 10000: the canvas refuses
 * a larger row limit with `invalid_query_bounds`, so the tool `src/index.ts` registers
 * for it is capped there, and a larger `row_limit` — the default 1000 included — is
 * served at that limit.
 */
describe('faostat_dataframe_query on a canvas configured to 50 rows (#56)', () => {
  const LIMIT = 50;
  const configured = dataframeQueryRegistration(LIMIT);
  const sql = 'SELECT n FROM range(200) t(n) ORDER BY n';
  let small: DataCanvas;

  beforeAll(() => {
    const built = createCanvasService(
      parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb', CANVAS_DEFAULT_ROW_LIMIT: String(LIMIT) }),
    );
    if (!built) throw new Error('expected a DuckDB canvas to be constructed for the test');
    small = built;
    setCanvas(small);
  });

  afterAll(async () => {
    setCanvas(canvas);
    await small.shutdown(createMockContext({ tenantId: 'teardown-small' }));
  });

  const call = (args: { row_limit?: number }) =>
    runToolContract(configured, { sql, ...args }, { context: { tenantId: 'df-small' } });

  it('serves row_limit 80 at the configured 50 with the clamp notice, never invalid_query_bounds', async () => {
    const wire = await call({ row_limit: 80 });
    expect(wire.isError).not.toBe(true);
    const { structured, text } = surfaces(wire);
    expect(structured.rows).toHaveLength(LIMIT);
    expect(structured).toMatchObject({
      truncated: true,
      requestedRowLimit: 80,
      effectiveRowLimit: LIMIT,
    });
    const notice = `row_limit 80 is above the 50 cap; returned up to 50. ${truncationSentence(LIMIT)}`;
    expect(structured.notice).toBe(notice);
    expect(text).toContain('**requestedRowLimit:** 80');
    expect(text).toContain('**effectiveRowLimit:** 50');
    expect(text).toContain(`> ${notice}`);
  });

  it('defaults row_limit to the configured limit, with no clamp', async () => {
    const wire = await call({});
    expect(wire.isError).not.toBe(true);
    const { structured } = surfaces(wire);
    expect(structured.rows).toHaveLength(LIMIT);
    expect(structured).not.toHaveProperty('requestedRowLimit');
    expect(structured.notice).toBe(truncationSentence(LIMIT));
  });

  it('states the configured limit in the default, description, strict maximum, and truncated description', () => {
    const description = 'Hard cap on rows in the response, at most 50 per call.';
    expect(rowLimitOf(configured)).toEqual({
      type: 'integer',
      minimum: 1,
      default: LIMIT,
      description,
    });
    expect(rowLimitOf(withStrictCountInputs(configured))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: LIMIT,
      default: LIMIT,
      description,
    });
    expect(z.toJSONSchema(configured.output).properties?.truncated).toMatchObject({
      description: expect.stringContaining('raise row_limit (at most 50 per call)'),
    });
  });
});
