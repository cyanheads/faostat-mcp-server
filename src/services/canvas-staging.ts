/**
 * @fileoverview Thin staging layer between the FAOSTAT analytical tools and the
 * framework DataCanvas. Holds one shared canvas per tenant (id persisted in
 * `ctx.state`), spills an observation stream to a `faostat_<id>` table with a
 * per-table TTL + provenance metadata, and runs read-only SQL across staged
 * tables. Best-effort: a canvas failure logs and returns a degraded result so
 * the caller's inline answer still lands. Mirrors the secedgar canvas-bridge
 * shape, scoped to FAOSTAT's per-query spillover (tables are ephemeral working
 * slices, not the durable corpus — that lives in the mirror).
 * @module services/canvas-staging
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type ColumnSchema,
  type QueryResult,
  spillover,
} from '@cyanheads/mcp-ts-core/canvas';
import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getCanvas } from './canvas-accessor.js';

/** Per-table provenance persisted in `ctx.state`, surfaced by dataframe_describe. */
export interface StagedTableMeta {
  columnSchema: ColumnSchema[];
  createdAt: string;
  expiresAt: string;
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
  truncated: boolean;
}

/** Result of a spillover staging op. */
export interface StageResult {
  canvasId: string;
  expiresAt: string;
  isNewCanvas: boolean;
  previewRows: Record<string, unknown>[];
  rowCount: number;
  spilled: boolean;
  tableName: string;
  truncated: boolean;
}

const META_PREFIX = 'df-meta/';
const CANVAS_ID_KEY = 'canvas-id';
const TABLE_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Per-table TTL: canvas tables are ephemeral working slices (2h sliding). */
const TABLE_TTL_MS = 2 * 60 * 60 * 1000;
/** Inline preview character budget (≈25k tokens). */
const PREVIEW_CHARS = 100_000;
/**
 * Hard cap on rows staged into a single canvas table. Bounds both the JS-side
 * row buffer and the DuckDB table so one broad query (a large domain like TCL,
 * ~17M rows) can't exhaust the heap. Beyond the cap, the table is truncated and
 * `truncated: true` flows through to dataframe_describe + the spill notice.
 * Callers feed the row source `STAGE_MAX_ROWS + 1` so the overflow is observed.
 */
export const STAGE_MAX_ROWS = 50_000;

/** True when the canvas is enabled on this deployment. */
export function canvasEnabled(): boolean {
  return getCanvas() !== undefined;
}

/** Mint a `faostat_xxxxx` table name. */
function mintTableName(): string {
  return `faostat_${idGenerator.generateRandomString(8, TABLE_CHARSET)}`;
}

/** Acquire the tenant's shared canvas, reusing the stored id when still live. */
async function acquireShared(ctx: Context): Promise<CanvasInstance> {
  const canvas = getCanvas();
  if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
  if (stored) {
    try {
      return await canvas.acquire(stored, ctx);
    } catch {
      await ctx.state.delete(CANVAS_ID_KEY);
    }
  }
  const instance = await canvas.acquire(undefined, ctx);
  await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
  return instance;
}

/**
 * Spill an observation row stream to a canvas table. Inlines a preview and, when
 * the stream overflows the preview budget, registers the full set under a fresh
 * `faostat_<id>` table with a 2h TTL + provenance. Returns a degraded
 * (non-spilled) result if the canvas op fails.
 */
export async function stageObservations<T extends Record<string, unknown>>(
  ctx: Context,
  source: AsyncIterable<T> | Iterable<T>,
  opts: {
    sourceTool: string;
    queryParams: Record<string, unknown>;
    canvasId?: string;
    tableName?: string;
    schema?: ColumnSchema[];
  },
): Promise<StageResult | undefined> {
  const canvas = getCanvas();
  if (!canvas) return;
  try {
    const instance = opts.canvasId
      ? await canvas.acquire(opts.canvasId, ctx)
      : await acquireShared(ctx);
    if (instance.isNew) await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);

    const tableName = opts.tableName ?? mintTableName();
    const result = await spillover({
      canvas: instance,
      source,
      previewChars: PREVIEW_CHARS,
      caps: { maxRows: STAGE_MAX_ROWS },
      tableName,
      ttlMs: TABLE_TTL_MS,
      signal: ctx.signal,
      ...(opts.schema ? { schema: opts.schema } : {}),
    });

    const now = Date.now();
    const expiresAt = new Date(now + TABLE_TTL_MS).toISOString();
    if (result.spilled) {
      const meta: StagedTableMeta = {
        tableName: result.handle.tableName,
        sourceTool: opts.sourceTool,
        queryParams: opts.queryParams,
        createdAt: new Date(now).toISOString(),
        expiresAt,
        rowCount: result.handle.rowCount,
        truncated: result.truncated,
        columnSchema: result.handle.columns.map((name) => ({ name, type: 'VARCHAR' as const })),
      };
      await ctx.state.set(`${META_PREFIX}${result.handle.tableName}`, meta);
      return {
        canvasId: instance.canvasId,
        isNewCanvas: instance.isNew,
        tableName: result.handle.tableName,
        spilled: true,
        previewRows: result.previewRows,
        rowCount: result.handle.rowCount,
        truncated: result.truncated,
        expiresAt,
      };
    }
    return {
      canvasId: instance.canvasId,
      isNewCanvas: instance.isNew,
      tableName: '',
      spilled: false,
      previewRows: result.previewRows,
      rowCount: result.previewRows.length,
      truncated: false,
      expiresAt,
    };
  } catch (error) {
    ctx.log.warning('Canvas staging failed', {
      error: error instanceof Error ? error.message : String(error),
      sourceTool: opts.sourceTool,
    });
    return;
  }
}

/** List staged table metadata for this tenant (newest first), sweeping expired entries. */
export async function describeStaged(ctx: Context, tableName?: string): Promise<StagedTableMeta[]> {
  await sweepExpired(ctx);
  if (tableName) {
    const meta = await ctx.state.get<StagedTableMeta>(`${META_PREFIX}${tableName}`);
    return meta ? [meta] : [];
  }
  const entries: StagedTableMeta[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.state.list(META_PREFIX, {
      ...(cursor !== undefined && { cursor }),
      limit: 100,
    });
    for (const item of page.items) if (item.value) entries.push(item.value as StagedTableMeta);
    cursor = page.cursor;
  } while (cursor);
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Run a read-only SELECT against the tenant's shared canvas. System catalogs are
 * denied so a caller can't enumerate every staged handle. Rebuilds the
 * framework's `missing_table` rejection with FAOSTAT-facing recovery guidance.
 */
export async function queryStaged(
  ctx: Context,
  sql: string,
  opts: { rowLimit: number },
): Promise<{ result: QueryResult }> {
  const canvas = getCanvas();
  if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  await sweepExpired(ctx);
  const instance = await acquireShared(ctx);
  try {
    const result = await instance.query(sql, {
      rowLimit: opts.rowLimit,
      denySystemCatalogs: true,
      signal: ctx.signal,
    });
    return { result };
  } catch (err) {
    if (err instanceof McpError) {
      const data = err.data as Record<string, unknown> | undefined;
      if (data?.reason === 'missing_table') {
        const tableName = data.tableName;
        const subject =
          typeof tableName === 'string' ? `Canvas table "${tableName}"` : 'Canvas table';
        throw notFound(`${subject} does not exist — it may have expired or was never staged.`, {
          reason: 'missing_table',
          ...(tableName !== undefined && { tableName }),
          recovery: {
            hint: 'Call faostat_dataframe_describe to list staged tables, or re-run the query that staged the data.',
          },
        });
      }
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw validationError(msg, {
      reason: 'invalid_sql',
      recovery: {
        hint: 'Check SQL syntax and column names against faostat_dataframe_describe.',
      },
    });
  }
}

/** Drop staged tables whose TTL has elapsed. Best-effort. */
async function sweepExpired(ctx: Context): Promise<void> {
  const canvas = getCanvas();
  if (!canvas) return;
  const nowIso = new Date().toISOString();
  let instance: CanvasInstance | undefined;
  let cursor: string | undefined;
  do {
    const page = await ctx.state.list(META_PREFIX, {
      ...(cursor !== undefined && { cursor }),
      limit: 100,
    });
    for (const item of page.items) {
      const meta = item.value as StagedTableMeta | undefined;
      if (!meta || meta.expiresAt > nowIso) continue;
      instance ??= await acquireShared(ctx).catch(() => undefined);
      if (instance) await instance.drop(meta.tableName).catch(() => {});
      await ctx.state.delete(item.key);
    }
    cursor = page.cursor;
  } while (cursor);
}
