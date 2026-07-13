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
  SQL_GATE_REASONS,
  spillover,
} from '@cyanheads/mcp-ts-core/canvas';
import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getCanvas } from './canvas-accessor.js';

/** Per-table provenance persisted in `ctx.state`, surfaced by dataframe_describe. */
export interface StagedTableMeta {
  /** Canvas that holds this table — scopes describe listings to the right canvas. */
  canvasId: string;
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
        canvasId: instance.canvasId,
        tableName: result.handle.tableName,
        sourceTool: opts.sourceTool,
        // Strip undefined-valued keys: structuredContent drops them on JSON
        // serialization while content[] renders them as `key=undefined`, so
        // persisting them makes the two surfaces diverge. Clean once at the
        // write site — dataframe_describe's handler and format() both read this.
        queryParams: Object.fromEntries(
          Object.entries(opts.queryParams).filter(([, v]) => v !== undefined),
        ),
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

/**
 * List staged table metadata for the resolved canvas (newest first), sweeping
 * expired entries. An explicit `canvasId` resolves that canvas — throwing the
 * framework's enriched `canvas_not_found` for an unknown/other-tenant id — and
 * scopes the listing to it; omitted uses the session's shared canvas. Filtering
 * on the resolved canvas is what stops a valid-but-different `canvas_id` from
 * leaking another canvas's table metadata.
 */
export async function describeStaged(
  ctx: Context,
  opts: { tableName?: string; canvasId?: string } = {},
): Promise<StagedTableMeta[]> {
  const canvas = getCanvas();
  if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  await sweepExpired(ctx);
  const instance = opts.canvasId
    ? await canvas.acquire(opts.canvasId, ctx)
    : await acquireShared(ctx);
  if (opts.tableName) {
    const meta = await ctx.state.get<StagedTableMeta>(`${META_PREFIX}${opts.tableName}`);
    return meta && meta.canvasId === instance.canvasId ? [meta] : [];
  }
  const entries: StagedTableMeta[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.state.list(META_PREFIX, {
      ...(cursor !== undefined && { cursor }),
      limit: 100,
    });
    for (const item of page.items) {
      const meta = item.value as StagedTableMeta | undefined;
      if (meta && meta.canvasId === instance.canvasId) entries.push(meta);
    }
    cursor = page.cursor;
  } while (cursor);
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * SQL-gate reasons that mean "the SQL is not a valid single read-only SELECT"
 * (non-SELECT statement type, multi-statement, denied function/operator, bad
 * identifier). The tool contract collapses all of them to one stable,
 * server-owned `invalid_sql` reason so a framework rename of any gate reason
 * can't silently change `faostat_dataframe_query`'s advertised `errors[]`.
 *
 * Three gate reasons are deliberately excluded:
 * - `missing_table` and `system_catalog_access` — declared contract reasons in
 *   their own right, with distinct recovery guidance.
 * - `invalid_sql` (`SQL_GATE_REASONS.invalidSql`) — since mcp-ts-core 0.10.8,
 *   a SELECT-shaped statement that parses but fails to prepare for a non-table
 *   reason (mistyped column, unknown function, invalid expression) is thrown
 *   NATIVELY as `invalid_sql` with a DuckDB `data.binderMessage`. That already
 *   matches this tool's declared contract, so it must pass through untouched —
 *   re-wrapping it here would strip the binder detail that names the offending
 *   column. The native classification covers the bad-column SELECT case this
 *   remap previously handled (those used to fall through to
 *   `non_select_statement`); the remap is retained only for the genuinely
 *   non-SELECT / denied / malformed-identifier reasons the gate still emits.
 */
const INVALID_SQL_GATE_REASONS = new Set<string>([
  SQL_GATE_REASONS.nonSelectStatement,
  SQL_GATE_REASONS.multiStatement,
  SQL_GATE_REASONS.planOperatorNotAllowed,
  SQL_GATE_REASONS.deniedFunction,
  SQL_GATE_REASONS.deniedFunctionInPlan,
  SQL_GATE_REASONS.identifierEmpty,
  SQL_GATE_REASONS.identifierShape,
  SQL_GATE_REASONS.identifierReserved,
]);

/**
 * Run a read-only SELECT against the tenant's shared canvas. System catalogs are
 * denied so a caller can't enumerate every staged handle. Normalizes the SQL
 * gate's rejections to this tool's declared contract: `missing_table` (with
 * FAOSTAT-facing recovery), `system_catalog_access` (passed through), the
 * framework-native `invalid_sql` (passed through, preserving `data.binderMessage`),
 * and a stable `invalid_sql` for every other malformed / non-read-only statement —
 * including the gate's own `non_select_statement` / `multi_statement` McpErrors,
 * which otherwise reach the client with an undeclared `data.reason`.
 */
export async function queryStaged(
  ctx: Context,
  sql: string,
  opts: { rowLimit: number; canvasId?: string },
): Promise<{ result: QueryResult }> {
  const canvas = getCanvas();
  if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  await sweepExpired(ctx);
  // An explicit canvas_id resolves that canvas — an unknown/other-tenant id throws
  // the framework's enriched `canvas_not_found` (NotFound), which is left to bubble
  // (it fires here, outside the try below, so it is never remapped to invalid_sql).
  // Omitted falls back to the session's shared canvas.
  const instance = opts.canvasId
    ? await canvas.acquire(opts.canvasId, ctx)
    : await acquireShared(ctx);
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
      const reason = typeof data?.reason === 'string' ? data.reason : undefined;
      // `missing_table` originates in the DuckDB provider (not the SQL gate), as a
      // string-literal reason — match it directly.
      if (reason === 'missing_table') {
        const tableName = data?.tableName;
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
      // system_catalog_access is a declared contract reason — let it through as-is.
      if (reason === SQL_GATE_REASONS.systemCatalogAccess) throw err;
      // Every other gate reason means the SQL is not a valid read-only SELECT.
      // Remap to the stable contract reason, preserving the gate's message.
      if (reason !== undefined && INVALID_SQL_GATE_REASONS.has(reason)) {
        throw validationError(err.message, {
          reason: 'invalid_sql',
          recovery: {
            hint: 'Use one read-only SELECT and verify table/column names against faostat_dataframe_describe.',
          },
        });
      }
      // Falls through here: the framework-native `invalid_sql` (mcp-ts-core ≥0.10.8,
      // SELECT-shaped prepare failures — bad column / unknown function), which already
      // matches the contract and carries `data.binderMessage`. Pass through unchanged.
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

/**
 * Drop staged tables whose TTL has elapsed. Best-effort, and against the shared
 * session canvas only: a table staged on a non-default canvas has its metadata
 * cleared here but the table itself is reclaimed by that canvas's own TTL / cap.
 * (Per-canvas sweeping is a lower-severity follow-up.)
 */
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
