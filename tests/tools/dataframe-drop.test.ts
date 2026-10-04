/**
 * @fileoverview `faostat_dataframe_drop` behavior, against a real DuckDB canvas: a
 * staged table is dropped from the canvas, from the provenance
 * `faostat_dataframe_describe` reads, and from SQL; a name not staged is a no-op
 * (`dropped: false` plus a notice); the drop stays on the canvas it resolved; and
 * a lapsed TTL, an unknown `canvas_id`, a malformed name, and a disabled canvas
 * each answer on both client surfaces. The opt-in registration is covered in
 * `dataframe-drop-registration.test.ts`.
 * @module tests/tools/dataframe-drop
 */

import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { OBSERVATION_TABLE_SCHEMA, stageObservations } from '@/services/canvas-staging.js';

/** The text of a contract run's `content[]`. */
function contentText(wire: Awaited<ReturnType<typeof runToolContract>>): string {
  return wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('faostat_dataframe_drop input', () => {
  it('takes a staged table name, with canvas_id optional', () => {
    expect(dataframeDropTool.input.parse({ name: 'faostat_ab12cd34' })).toEqual({
      name: 'faostat_ab12cd34',
    });
    expect(
      dataframeDropTool.input.parse({ name: 'faostat_ab12cd34', canvas_id: 'abc1234567' }),
    ).toEqual({ name: 'faostat_ab12cd34', canvas_id: 'abc1234567' });
  });

  it('rejects a name that is not a staged-table name, and a malformed canvas_id', () => {
    for (const name of [
      '',
      'faostat_',
      'faostat_ab12cd3',
      'faostat_ab12cd345',
      'FAOSTAT_AB12CD34',
      'df_ab12cd34',
      'faostat_ab12cd3!',
    ]) {
      expect(
        () => dataframeDropTool.input.parse({ name }),
        `expected "${name}" to be rejected`,
      ).toThrow();
    }
    expect(() =>
      dataframeDropTool.input.parse({ name: 'faostat_ab12cd34', canvas_id: 'abc' }),
    ).toThrow();
  });

  it('answers a malformed name with InvalidParams naming the expected shape', async () => {
    const wire = await runToolContract(dataframeDropTool, { name: 'faostat_tables' });
    expect(wire.isError).toBe(true);
    const { error } = wire.structuredContent as { error: { code: number } };
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(contentText(wire)).toContain('exactly as faostat_dataframe_describe lists it');
  });
});

/** Enough rows to overflow the inline budget, so staging registers a table. */
function* manyRows(label: string): Generator<Record<string, unknown>> {
  for (let i = 1; i <= 2000; i++) {
    yield { area_code: i, area: `${label} country ${i}`, value: 1000 + i, flag: 'A' };
  }
}

/** A context that can stage, describe, query, and drop on one session canvas. */
const sessionCtx = (tenantId: string) =>
  createMockContext({
    tenantId,
    errors: [
      ...(dataframeDescribeTool.errors ?? []),
      ...(dataframeQueryTool.errors ?? []),
      ...(dataframeDropTool.errors ?? []),
    ],
  });

/** Stage one table on the session canvas (or `canvasId`) and return its handle. */
async function stage(
  ctx: ReturnType<typeof sessionCtx>,
  label: string,
  canvasId?: string,
): Promise<{ canvasId: string; tableName: string }> {
  const staged = await stageObservations(ctx, manyRows(label), {
    sourceTool: 'faostat_query_observations',
    schema: OBSERVATION_TABLE_SCHEMA,
    queryParams: { domain: 'QCL' },
    ...(canvasId ? { canvasId } : {}),
  });
  if (!staged?.spilled) throw new Error('expected the rows to spill to a canvas table');
  return { canvasId: staged.canvasId, tableName: staged.tableName };
}

/** Names `faostat_dataframe_describe` lists on the session canvas (or `canvasId`). */
async function describedNames(
  ctx: ReturnType<typeof sessionCtx>,
  canvasId?: string,
): Promise<string[]> {
  const described = await dataframeDescribeTool.handler(
    dataframeDescribeTool.input.parse(canvasId ? { canvas_id: canvasId } : {}),
    ctx,
  );
  return described.tables.map((t) => t.name);
}

describe('faostat_dataframe_drop on a DuckDB canvas', () => {
  let canvas: DataCanvas;

  beforeAll(() => {
    const built = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
    if (!built) throw new Error('expected a DuckDB canvas to be constructed for the test');
    canvas = built;
    setCanvas(canvas);
  });

  afterEach(() => {
    vi.useRealTimers();
    setCanvas(canvas);
  });

  afterAll(async () => {
    setCanvas(undefined);
    await canvas.shutdown(createMockContext({ tenantId: 'teardown' }));
  });

  it('drops a staged table from the canvas, its provenance, and SQL — and a second drop is a no-op', async () => {
    const ctx = sessionCtx('drop-session');
    const { tableName } = await stage(ctx, 'session');
    expect(await describedNames(ctx)).toContain(tableName);

    const first = await dataframeDropTool.handler(
      dataframeDropTool.input.parse({ name: tableName }),
      ctx,
    );
    expect(first).toEqual({ name: tableName, dropped: true });
    expect(getEnrichment(ctx).notice).toBeUndefined();

    expect(await describedNames(ctx)).not.toContain(tableName);
    expect(await ctx.state.get(`df-meta/${tableName}`)).toBeNull();
    await expect(
      dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: `SELECT COUNT(*) AS n FROM ${tableName}` }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'missing_table' } });

    const second = await dataframeDropTool.handler(
      dataframeDropTool.input.parse({ name: tableName }),
      ctx,
    );
    expect(second).toEqual({ name: tableName, dropped: false });
    expect(getEnrichment(ctx).notice).toMatch(/nothing was dropped/);
  });

  it('drops only the named table, leaving the other staged tables in place', async () => {
    const ctx = sessionCtx('drop-one-of-two');
    const kept = await stage(ctx, 'kept');
    const dropped = await stage(ctx, 'dropped');

    await dataframeDropTool.handler(
      dataframeDropTool.input.parse({ name: dropped.tableName }),
      ctx,
    );

    const names = await describedNames(ctx);
    expect(names).toContain(kept.tableName);
    expect(names).not.toContain(dropped.tableName);
    const { rows } = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({ sql: `SELECT COUNT(*) AS n FROM ${kept.tableName}` }),
      ctx,
    );
    // COUNT(*) is BIGINT, which the canvas returns as a lossless string.
    expect(rows).toEqual([{ n: '2000' }]);
  });

  it('acts only on the canvas it resolves: a table staged on another canvas is untouched until named with its canvas_id', async () => {
    const ctx = sessionCtx('drop-cross-canvas');
    const onSession = await stage(ctx, 'session');
    const second = await canvas.acquire(undefined, ctx);
    const onSecond = await stage(ctx, 'second', second.canvasId);

    // The session canvas holds no such table — nothing dropped anywhere.
    const miss = await dataframeDropTool.handler(
      dataframeDropTool.input.parse({ name: onSecond.tableName }),
      ctx,
    );
    expect(miss.dropped).toBe(false);
    expect(await describedNames(ctx, second.canvasId)).toContain(onSecond.tableName);

    const hit = await dataframeDropTool.handler(
      dataframeDropTool.input.parse({ name: onSecond.tableName, canvas_id: second.canvasId }),
      ctx,
    );
    expect(hit.dropped).toBe(true);
    expect(await describedNames(ctx, second.canvasId)).not.toContain(onSecond.tableName);
    expect(await describedNames(ctx)).toContain(onSession.tableName);
  });

  it('reads a table whose 2-hour TTL lapsed as not staged', async () => {
    const ctx = sessionCtx('drop-expired');
    const { tableName } = await stage(ctx, 'expired');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 60_000);

    const result = await dataframeDropTool.handler(
      dataframeDropTool.input.parse({ name: tableName }),
      ctx,
    );
    expect(result).toEqual({ name: tableName, dropped: false });
    expect(getEnrichment(ctx).notice).toMatch(/expired on its 2-hour TTL/);
    expect(await ctx.state.get(`df-meta/${tableName}`)).toBeNull();
  });

  it('reports a dropped table on structuredContent and content[]', async () => {
    const tenantId = 'drop-wire-hit';
    const { canvasId, tableName } = await stage(sessionCtx(tenantId), 'wire');

    const wire = await runToolContract(
      dataframeDropTool,
      { name: tableName, canvas_id: canvasId },
      { context: { tenantId } },
    );
    expect(wire.isError).toBeFalsy();
    expect(wire.structuredContent).toEqual({ name: tableName, dropped: true });
    expect(contentText(wire)).toBe(`Dropped staged table ${tableName} (dropped: true).`);
  });

  it('answers a name that is not staged with dropped false and the notice on both surfaces', async () => {
    const wire = await runToolContract(
      dataframeDropTool,
      { name: 'faostat_zzzz9999' },
      { context: { tenantId: 'drop-wire-miss' } },
    );
    expect(wire.isError).toBeFalsy();
    const structured = wire.structuredContent as { name: string; dropped: boolean; notice: string };
    expect(structured).toMatchObject({ name: 'faostat_zzzz9999', dropped: false });
    expect(structured.notice).toMatch(/nothing was dropped/);
    const text = contentText(wire);
    expect(text).toContain(
      'faostat_zzzz9999 was not staged on this canvas; nothing dropped (dropped: false).',
    );
    expect(text).toContain(structured.notice);
  });

  it('fails an unknown canvas_id with its declared canvas_not_found recovery on both surfaces', async () => {
    const declared = dataframeDropTool.errors?.find(
      (e) => e.reason === 'canvas_not_found',
    )?.recovery;
    expect(declared).toMatch(/omit canvas_id/);

    const wire = await runToolContract(
      dataframeDropTool,
      { name: 'faostat_ab12cd34', canvas_id: 'zzzzzzzzzz' },
      { context: { tenantId: 'drop-wire-unknown-canvas' } },
    );
    expect(wire.isError).toBe(true);
    const { error } = wire.structuredContent as {
      error: { code: number; data: Record<string, unknown> };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', recovery: { hint: declared } },
    });
    expect(contentText(wire)).toContain(declared);
  });

  it('fails with canvas_disabled on both surfaces when the canvas is off', async () => {
    setCanvas(undefined);
    const declared = dataframeDropTool.errors?.find(
      (e) => e.reason === 'canvas_disabled',
    )?.recovery;
    expect(declared).toContain('CANVAS_PROVIDER_TYPE=duckdb');

    const wire = await runToolContract(
      dataframeDropTool,
      { name: 'faostat_ab12cd34' },
      { context: { tenantId: 'drop-wire-disabled' } },
    );
    expect(wire.isError).toBe(true);
    const { error } = wire.structuredContent as {
      error: { code: number; data: Record<string, unknown> };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled', recovery: { hint: declared } },
    });
    expect(contentText(wire)).toContain(declared);
  });
});
