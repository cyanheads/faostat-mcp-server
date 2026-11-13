/**
 * @fileoverview Staged provenance paging, expiration, and stale session recovery
 * over real tenant storage and DuckDB canvases. The shared-canvas cases (#58) pin
 * one canvas per tenant under concurrent first stagings, the purge of a dead
 * canvas's provenance before its replacement is stored, and describe/drop
 * answering a tenant with no live canvas without minting one.
 * @module tests/services/canvas-staging-lifecycle
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCanvas } from '@/services/canvas-accessor.js';
import {
  describeStaged,
  dropStaged,
  queryStaged,
  type StagedTableMeta,
  stageObservations,
} from '@/services/canvas-staging.js';

let canvas: DataCanvas;

/**
 * Stage two rows as `tableName`. `previewLimit: 1` registers the buffered set, so
 * the table and its `df-meta/` record exist without a char-budget-sized stream.
 */
function stageTwoRows(ctx: Context, tableName: string) {
  return stageObservations(ctx, [{ value: 1 }, { value: 2 }], {
    sourceTool: 'faostat_query_observations',
    queryParams: {},
    schema: [{ name: 'value', type: 'DOUBLE' }],
    tableName,
    previewLimit: 1,
  });
}

/** Every `df-meta/` record in the tenant's state, whatever canvas it names. */
async function stagedRecords(ctx: Context): Promise<StagedTableMeta[]> {
  const records: StagedTableMeta[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.state.list('df-meta/', cursor ? { cursor } : {});
    records.push(...page.items.map((item) => item.value as StagedTableMeta));
    cursor = page.cursor;
  } while (cursor);
  return records;
}

beforeEach(() => {
  const built = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
  if (!built) throw new Error('Expected DuckDB canvas');
  canvas = built;
  setCanvas(canvas);
});

afterEach(async () => {
  setCanvas(undefined);
  await canvas.shutdown(createMockContext());
});

describe('canvas staging lifecycle', () => {
  it('pages metadata past 100 entries, scopes the canvas, and sorts newest first', async () => {
    const ctx = createMockContext();
    const instance = await canvas.acquire(undefined, ctx);
    const other = await canvas.acquire(undefined, ctx);
    await ctx.state.set('canvas-id', instance.canvasId);
    const now = Date.now();
    for (let i = 0; i < 105; i++) {
      const tableName = `faostat_meta_${String(i).padStart(3, '0')}`;
      const meta: StagedTableMeta = {
        canvasId: instance.canvasId,
        tableName,
        sourceTool: 'faostat_query_observations',
        queryParams: { domain: 'QCL' },
        rowCount: 1,
        truncated: false,
        createdAt: new Date(now - i * 1000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        columnSchema: [],
      };
      await ctx.state.set(`df-meta/${tableName}`, meta);
    }
    const foreign: StagedTableMeta = {
      canvasId: other.canvasId,
      tableName: 'faostat_foreign',
      sourceTool: 'faostat_query_observations',
      queryParams: {},
      rowCount: 0,
      truncated: false,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      columnSchema: [],
    };
    await ctx.state.set('df-meta/faostat_foreign', foreign);
    const listed = await describeStaged(ctx);
    expect(listed.map((meta) => meta.tableName)).toEqual(
      Array.from({ length: 105 }, (_, i) => `faostat_meta_${String(i).padStart(3, '0')}`),
    );
    expect(await describeStaged(ctx, { tableName: 'faostat_foreign' })).toEqual([]);
    expect(await describeStaged(ctx, { canvasId: other.canvasId })).toEqual([foreign]);
  });

  it('sweeps expired provenance and its actual table while preserving live tables', async () => {
    const ctx = createMockContext();
    const expired = await stageObservations(ctx, [{ value: 1 }, { value: 2 }], {
      sourceTool: 'faostat_query_observations',
      queryParams: {},
      schema: [{ name: 'value', type: 'DOUBLE' }],
      tableName: 'faostat_expired',
      previewLimit: 1,
    });
    expect(expired?.spilled).toBe(true);
    const meta = await ctx.state.get<StagedTableMeta>('df-meta/faostat_expired');
    if (!meta) throw new Error('Expected persisted provenance');
    await ctx.state.set('df-meta/faostat_expired', {
      ...meta,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const live = await stageObservations(ctx, [{ value: 3 }, { value: 4 }], {
      sourceTool: 'faostat_query_observations',
      queryParams: {},
      schema: [{ name: 'value', type: 'DOUBLE' }],
      tableName: 'faostat_live',
      previewLimit: 1,
    });
    expect(live?.canvasId).toBe(expired?.canvasId);
    expect((await describeStaged(ctx)).map((entry) => entry.tableName)).toEqual(['faostat_live']);
    expect(await ctx.state.get('df-meta/faostat_expired')).toBeNull();
    const instance = await canvas.acquire(live?.canvasId, ctx);
    expect(await instance.describe()).toEqual([expect.objectContaining({ name: 'faostat_live' })]);
  });

  it('replaces an expired shared canvas token and keeps an inline result reachable', async () => {
    const ctx = createMockContext();
    await ctx.state.set('canvas-id', 'notlive000');
    const staged = await stageObservations(ctx, [{ value: 7 }], {
      sourceTool: 'faostat_query_observations',
      queryParams: {},
      schema: [{ name: 'value', type: 'DOUBLE' }],
    });
    expect(staged).toMatchObject({ spilled: false, rowCount: 1, previewRows: [{ value: 7 }] });
    expect(staged?.canvasId).not.toBe('notlive000');
    expect(await ctx.state.get('canvas-id')).toBe(staged?.canvasId);
  });

  it('lands concurrent first stagings on one shared canvas, each table reachable without canvas_id (#58)', async () => {
    const ctx = createMockContext({ tenantId: 'concurrent-first' });
    const names = ['a', 'b', 'c', 'd', 'e'].map((suffix) => `faostat_race_${suffix}`);

    const staged = await Promise.all(names.map((name) => stageTwoRows(ctx, name)));

    expect(staged.map((result) => result?.spilled)).toEqual([true, true, true, true, true]);
    expect(new Set(staged.map((result) => result?.canvasId)).size).toBe(1);
    expect(canvas.countForTenant(ctx)).toBe(1);
    expect(await ctx.state.get('canvas-id')).toBe(staged[0]?.canvasId);
    for (const name of names) {
      const { result } = await queryStaged(ctx, `SELECT count(*) AS n FROM ${name}`, {
        rowLimit: 1,
      });
      expect(Number(result.rows[0]?.n)).toBe(2);
    }
    expect((await describeStaged(ctx)).map((meta) => meta.tableName).sort()).toEqual(names);
  });

  it('purges the records of a dead stored canvas before its replacement is stored (#58)', async () => {
    const ctx = createMockContext({ tenantId: 'dead-stored-canvas' });
    const first = await stageTwoRows(ctx, 'faostat_old_a');
    await stageTwoRows(ctx, 'faostat_old_b');
    const deadId = first?.canvasId as string;
    expect(await canvas.drop(deadId, ctx)).toBe(true);
    // The slot still names the dead canvas, so the framework hands onReplace its id.
    expect(await ctx.state.get('canvas-id')).toBe(deadId);

    const replacement = await stageTwoRows(ctx, 'faostat_new');

    expect(replacement?.canvasId).not.toBe(deadId);
    expect(await ctx.state.get('canvas-id')).toBe(replacement?.canvasId);
    const records = await stagedRecords(ctx);
    expect(records.map((meta) => meta.tableName)).toEqual(['faostat_new']);
    expect(records.map((meta) => meta.canvasId)).toEqual([replacement?.canvasId]);
    expect((await describeStaged(ctx)).map((meta) => meta.tableName)).toEqual(['faostat_new']);
  });

  it('purges the records of a canvas whose stored id expired with it (#58)', async () => {
    const ctx = createMockContext({ tenantId: 'expired-slot' });
    const first = await stageTwoRows(ctx, 'faostat_capped');
    expect(await canvas.drop(first?.canvasId as string, ctx)).toBe(true);
    // The stored id carries the canvas's absolute cap as its TTL, so a canvas that
    // reached the cap leaves an empty slot: onReplace gets no previous id.
    await ctx.state.delete('canvas-id');

    const replacement = await stageTwoRows(ctx, 'faostat_after_cap');

    const records = await stagedRecords(ctx);
    expect(records.map((meta) => meta.tableName)).toEqual(['faostat_after_cap']);
    expect(records.map((meta) => meta.canvasId)).toEqual([replacement?.canvasId]);
  });

  it('answers describe and drop without minting a canvas when none is live (#58)', async () => {
    const ctx = createMockContext({ tenantId: 'no-live-canvas' });
    expect(await describeStaged(ctx)).toEqual([]);
    expect(await describeStaged(ctx, { tableName: 'faostat_missing' })).toEqual([]);
    expect(await dropStaged(ctx, 'faostat_missing')).toBe(false);
    expect(canvas.countForTenant(ctx)).toBe(0);
    expect(await ctx.state.get('canvas-id')).toBeNull();

    // A dead stored canvas: its records go, nothing is listed, nothing is minted.
    const staged = await stageTwoRows(ctx, 'faostat_orphaned');
    expect(await canvas.drop(staged?.canvasId as string, ctx)).toBe(true);
    expect(await describeStaged(ctx)).toEqual([]);
    expect(await dropStaged(ctx, 'faostat_orphaned')).toBe(false);
    expect(await stagedRecords(ctx)).toEqual([]);
    expect(canvas.countForTenant(ctx)).toBe(0);
    expect(await ctx.state.get('canvas-id')).toBeNull();
  });

  it('still runs SQL for a tenant with no live canvas', async () => {
    const ctx = createMockContext({ tenantId: 'query-no-canvas' });
    const { result } = await queryStaged(ctx, 'SELECT 42 AS n', { rowLimit: 1 });
    expect(Number(result.rows[0]?.n)).toBe(42);
    await expect(
      queryStaged(ctx, 'SELECT * FROM faostat_none', { rowLimit: 1 }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'missing_table' } });
  });

  it('rejects a cancelled call instead of degrading it to an unstaged answer', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = createMockContext({ tenantId: 'cancelled', signal: controller.signal });
    await expect(stageTwoRows(ctx, 'faostat_cancelled')).rejects.toThrow();
    await expect(describeStaged(ctx)).rejects.toThrow();
    await expect(dropStaged(ctx, 'faostat_cancelled')).rejects.toThrow();
  });

  it('leaves staging off and rejects direct SQL/metadata mutations when canvas is disabled', async () => {
    setCanvas(undefined);
    const ctx = createMockContext();
    expect(
      await stageObservations(ctx, [], {
        sourceTool: 'faostat_query_observations',
        queryParams: {},
        schema: [],
      }),
    ).toBeUndefined();
    await expect(describeStaged(ctx)).rejects.toThrow('DataCanvas is not enabled');
    await expect(dropStaged(ctx, 'faostat_missing')).rejects.toThrow('DataCanvas is not enabled');
    await expect(queryStaged(ctx, 'SELECT 1', { rowLimit: 1 })).rejects.toThrow(
      'DataCanvas is not enabled',
    );
  });
});
