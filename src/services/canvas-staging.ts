/**
 * @fileoverview Thin staging layer between the FAOSTAT analytical tools and the
 * framework DataCanvas. Holds one shared canvas per tenant (id persisted in
 * `ctx.state`), spills an observation stream to a `faostat_<id>` table with a
 * per-table TTL + provenance metadata, runs read-only SQL across staged tables,
 * and drops one ahead of its TTL on request. Spilling is best-effort: a canvas
 * failure logs and returns a degraded result so the caller's inline answer still
 * lands — except a caller-named canvas that does not resolve, which fails the
 * call. Mirrors the secedgar canvas-bridge
 * shape, scoped to FAOSTAT's per-query spillover (tables are ephemeral working
 * slices, not the durable corpus — that lives in the mirror).
 * @module services/canvas-staging
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  DUCKDB_ERROR_REASONS,
  type QueryResult,
  type RegisterTableResult,
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
  /** Schema DuckDB resolved for the table, read back from the canvas at stage time. */
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

/**
 * Column schema of a table staged from `FaostatMirror.streamObservations` rows —
 * the ten columns that stream selects, in its order. Declared rather than inferred:
 * the framework would type each column from the rows already buffered for the
 * inline preview, and `value` is the one column that window can mistype — whole
 * numbers infer BIGINT, an all-null window VARCHAR — after which every later row is
 * coerced to that type (a fractional value truncated) without an error. `nullable`
 * is left at its default (`true`), matching an inferred schema.
 */
export const OBSERVATION_TABLE_SCHEMA: ColumnSchema[] = [
  { name: 'area_code', type: 'BIGINT' },
  { name: 'area', type: 'VARCHAR' },
  { name: 'item_code', type: 'BIGINT' },
  { name: 'item', type: 'VARCHAR' },
  { name: 'element_code', type: 'BIGINT' },
  { name: 'element', type: 'VARCHAR' },
  { name: 'year', type: 'BIGINT' },
  { name: 'unit', type: 'VARCHAR' },
  { name: 'value', type: 'DOUBLE' },
  { name: 'flag', type: 'VARCHAR' },
];

/**
 * Column schema of a `faostat_commodity_profile` table: the observation columns
 * plus the `domain` (`QCL` / `TCL`) each merged row came from.
 */
export const PROFILE_TABLE_SCHEMA: ColumnSchema[] = [
  ...OBSERVATION_TABLE_SCHEMA,
  { name: 'domain', type: 'VARCHAR' },
];

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
 * Acquire the canvas a caller named by `canvas_id`. An unknown or expired id is the
 * caller's input, so its `canvas_not_found` propagates — for staging, rather than
 * degrading the call — rethrown without the framework's recovery hint, which sends
 * the caller back to the tool that produced the id. A hint set on the error
 * outranks a declared one, so with it gone each tool's own declared recovery fills
 * both surfaces instead (#35).
 */
async function acquireExplicit(
  canvas: DataCanvas,
  canvasId: string,
  ctx: Context,
): Promise<CanvasInstance> {
  try {
    return await canvas.acquire(canvasId, ctx);
  } catch (error) {
    if (error instanceof McpError && error.data?.reason === 'canvas_not_found') {
      const { recovery: _frameworkHint, ...data } = error.data;
      throw new McpError(error.code, error.message, data, { cause: error });
    }
    throw error;
  }
}

/**
 * Spill an observation row stream to a canvas table. Inlines a preview and, when
 * the stream overflows the preview budget, registers the full set under a fresh
 * `faostat_<id>` table with a 2h TTL + provenance. Returns a degraded
 * (non-spilled) result if the canvas op fails — except that a caller-named
 * `canvasId` that does not resolve fails the call with `canvas_not_found` (#35).
 * Omitted, the session canvas is used, and a dead one is replaced silently.
 *
 * `previewLimit` adds a row-count spill trigger on top of the character budget:
 * a stream that drains under the budget but yields more rows than the caller can
 * show inline is registered too, so the caller can cap its inline page at that
 * limit without the rows past it becoming unreachable (issue #14). Omit it to
 * spill on the character budget alone.
 *
 * `schema` types the table on both registration paths — pass
 * {@link OBSERVATION_TABLE_SCHEMA} or {@link PROFILE_TABLE_SCHEMA} to match the
 * rows. It also sets the table's column order; a row key it does not name is not
 * staged, and a name absent from a row stages as NULL.
 *
 * A failure the `source` itself raises is rethrown rather than degraded: that is
 * the mirror read failing (the per-call `query_timeout` ceiling, a cancellation, a
 * crashed read worker — #3), and an inline fallback would present a truncated
 * page as the call's answer.
 */
export async function stageObservations<T extends Record<string, unknown>>(
  ctx: Context,
  source: AsyncIterable<T> | Iterable<T>,
  opts: {
    sourceTool: string;
    queryParams: Record<string, unknown>;
    schema: ColumnSchema[];
    canvasId?: string;
    previewLimit?: number;
    tableName?: string;
  },
): Promise<StageResult | undefined> {
  const canvas = getCanvas();
  if (!canvas) return;
  // Resolved outside the degrade path below: a bad id is the caller's to fix.
  const named = opts.canvasId ? await acquireExplicit(canvas, opts.canvasId, ctx) : undefined;
  // What the source threw, if anything — spillover passes it through unchanged, so
  // the catch below tells a read failure from a canvas failure by identity.
  let readFailure: unknown;
  async function* recorded(): AsyncGenerator<T> {
    try {
      yield* source;
    } catch (error) {
      readFailure = error;
      throw error;
    }
  }
  try {
    const instance = named ?? (await acquireShared(ctx));

    const tableName = opts.tableName ?? mintTableName();
    const result = await spillover({
      canvas: instance,
      source: recorded(),
      previewChars: PREVIEW_CHARS,
      caps: { maxRows: STAGE_MAX_ROWS },
      tableName,
      ttlMs: TABLE_TTL_MS,
      signal: ctx.signal,
      schema: opts.schema,
    });

    // The character budget alone leaves a band where the stream drains whole yet
    // still carries more rows than the caller shows inline. Register that buffered
    // set so the caller's inline cap costs nothing in reachability: every row is on
    // the table. Bounded by the preview budget, so it is a small in-memory array.
    let handle: RegisterTableResult | undefined;
    if (result.spilled) {
      handle = result.handle;
    } else if (opts.previewLimit !== undefined && result.previewRows.length > opts.previewLimit) {
      handle = await instance.registerTable(tableName, result.previewRows, {
        schema: opts.schema,
        ttlMs: TABLE_TTL_MS,
        signal: ctx.signal,
      });
    }

    const now = Date.now();
    const expiresAt = new Date(now + TABLE_TTL_MS).toISOString();
    if (handle) {
      // Only the char-budget spill can hit the row cap; the buffered registration
      // above is bounded by the preview budget, far under it.
      const truncated = result.spilled ? result.truncated : false;
      // The spill handle carries column NAMES only — the types DuckDB registered
      // are only readable from the catalog. Read them back once here, at stage
      // time, so the persisted metadata dataframe_describe serves is the contract
      // SQL callers must actually match rather than a synthesized VARCHAR each.
      const [tableInfo] = await instance.describe({ tableName: handle.tableName });
      if (!tableInfo) {
        throw new Error(
          `Staged table "${handle.tableName}" is absent from canvas ${instance.canvasId}.`,
        );
      }
      const meta: StagedTableMeta = {
        canvasId: instance.canvasId,
        tableName: handle.tableName,
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
        rowCount: handle.rowCount,
        truncated,
        columnSchema: tableInfo.columns,
      };
      await ctx.state.set(`${META_PREFIX}${handle.tableName}`, meta);
      return {
        canvasId: instance.canvasId,
        isNewCanvas: instance.isNew,
        tableName: handle.tableName,
        spilled: true,
        previewRows: result.previewRows,
        rowCount: handle.rowCount,
        truncated,
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
    // A cancelled call, or a source read that failed, must not degrade into a
    // "successful" inline answer.
    if (ctx.signal?.aborted || error === readFailure) throw error;
    ctx.log.warning('Canvas staging failed', {
      error: error instanceof Error ? error.message : String(error),
      sourceTool: opts.sourceTool,
    });
    return;
  }
}

/**
 * List staged table metadata for the resolved canvas (newest first), sweeping
 * expired entries. An explicit `canvasId` resolves that canvas — throwing
 * `canvas_not_found` for an unknown/other-tenant id, which the tool's declared
 * recovery completes (see {@link acquireExplicit}) — and scopes the listing to it;
 * omitted uses the session's shared canvas. Filtering on the resolved canvas is
 * what stops a valid-but-different `canvas_id` from leaking another canvas's table
 * metadata.
 */
export async function describeStaged(
  ctx: Context,
  opts: { tableName?: string; canvasId?: string } = {},
): Promise<StagedTableMeta[]> {
  const canvas = getCanvas();
  if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  await sweepExpired(ctx);
  const instance = opts.canvasId
    ? await acquireExplicit(canvas, opts.canvasId, ctx)
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
 * Drop one staged table and its provenance ahead of its TTL; resolves `true` when a
 * table by that name existed on the resolved canvas. An explicit `canvasId` resolves
 * that canvas — throwing `canvas_not_found` for an unknown/other-tenant id, which the
 * tool's declared recovery completes (see {@link acquireExplicit}); omitted uses the
 * session's shared canvas. Only that canvas's table is dropped and only metadata
 * recorded for it is cleared, so a valid-but-different `canvas_id` reaches nothing
 * staged elsewhere.
 */
export async function dropStaged(
  ctx: Context,
  tableName: string,
  opts: { canvasId?: string } = {},
): Promise<boolean> {
  const canvas = getCanvas();
  if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  await sweepExpired(ctx);
  const instance = opts.canvasId
    ? await acquireExplicit(canvas, opts.canvasId, ctx)
    : await acquireShared(ctx);
  const dropped = await instance.drop(tableName);
  const metaKey = `${META_PREFIX}${tableName}`;
  const meta = await ctx.state.get<StagedTableMeta>(metaKey);
  if (meta?.canvasId === instance.canvasId) await ctx.state.delete(metaKey);
  return dropped;
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
 * The DuckDB engine's own caller-side rejections, which the framework classifies as
 * `ValidationError` with one of these reasons rather than as a gate rejection: SQL the
 * engine could not parse, a write it refused, and a gated SELECT that prepared cleanly
 * and then failed on the staged data (a cast a row's value cannot satisfy). All three
 * are what `faostat_dataframe_query` advertises as `invalid_sql` — "a syntax or
 * execution error, or not a single read-only SELECT" — so they are folded into the
 * same remap. Without it they reach the client carrying a `data.reason` the tool's
 * `errors[]` never declared, which is the failure the gate remap above exists to stop.
 */
const DUCKDB_INVALID_SQL_REASONS = new Set<string>(Object.values(DUCKDB_ERROR_REASONS));

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
  // `canvas_not_found` (NotFound) with no hint of its own, so the tool's declared
  // recovery fills in. It is left to bubble (it fires here, outside the try below,
  // so it is never remapped to invalid_sql). Omitted falls back to the session's
  // shared canvas.
  const instance = opts.canvasId
    ? await acquireExplicit(canvas, opts.canvasId, ctx)
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
      // Every other gate reason, plus the engine's own caller-side rejections, means
      // the SQL is not a valid read-only SELECT (or failed executing). Remap to the
      // stable contract reason, preserving the message and — when the framework
      // synthesized one — its per-reason recovery hint, which is more specific than
      // the generic fallback (e.g. "wrap the cast in TRY_CAST" for a bad conversion).
      if (
        reason !== undefined &&
        (INVALID_SQL_GATE_REASONS.has(reason) || DUCKDB_INVALID_SQL_REASONS.has(reason))
      ) {
        const hint = (data?.recovery as { hint?: string } | undefined)?.hint;
        throw validationError(err.message, {
          reason: 'invalid_sql',
          recovery: {
            hint:
              hint ??
              'Use one read-only SELECT and verify table/column names against faostat_dataframe_describe.',
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
