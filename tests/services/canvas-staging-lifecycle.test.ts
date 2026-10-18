/**
 * @fileoverview Staged provenance paging, expiration, and stale session recovery
 * over real tenant storage and DuckDB canvases.
 * @module tests/services/canvas-staging-lifecycle
 */

import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
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
