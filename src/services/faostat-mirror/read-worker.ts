/**
 * @fileoverview Worker-thread entry behind {@link ReadPool} (#3). Runs one job at a
 * time — a cube read, or a statistics build (`ANALYZE`, #24) — against its own
 * read-write SQLite handle per domain file, opened through the framework's
 * `openSqliteHandle` (`bun:sqlite` under Bun, `better-sqlite3` under Node), and
 * replies with the rows, the build's duration, or a serializable error. A handle
 * is cached with the file's epoch and reopened when a request carries a newer one:
 * a connection that has loaded its schema keeps the planner statistics it read
 * then, so the main thread bumps the epoch after each successful `ANALYZE`.
 *
 * A read-triggered build rechecks the lease under its writer lock (#60). A closing
 * build claims the lease so readers in other processes see who is maintaining the
 * store (#72). Index preparation runs on behalf of the sync that already owns it (#70).
 *
 * A build's statistics are one transaction of per-index `ANALYZE` statements (#62),
 * so a worker the pool retires mid-build stops at the end of the statement it is
 * running and, short of its closing `COMMIT`, commits nothing.
 *
 * An open that meets another connection's lock — one recovering the WAL index
 * after other workers' connections were released, say — waits it out inside
 * `openSqliteHandle`, which sets `busy_timeout` before its first read of the file.
 * A failed open rejects as `DatabaseError`, the driver's error on `cause`, and
 * reaches the main thread as that `McpError` code.
 *
 * The file must load as-is from `src/` (Node type-stripping, Bun, Vitest) and from
 * `dist/`: no `@/` alias, extension-aware local runtime imports, and erasable
 * TypeScript only.
 * @module services/faostat-mirror/read-worker
 */

import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort } from 'node:worker_threads';
import {
  openSqliteHandle,
  type SqliteHandle,
  type SqlValue,
  type SyncLease,
} from '@cyanheads/mcp-ts-core/mirror';
import type { DimensionSearchOptions, DimensionSearchResult } from './dimension-search.js';
import type { DimensionKind } from './types.js';

/** Run `sql` against `file` and reply with every row. */
export interface ReadRequest {
  epoch: number;
  file: string;
  id: number;
  op: 'all';
  params: SqlValue[];
  sql: string;
}

/** Resolve a scoped dimension search against a query-only connection. */
export interface ResolveDimensionRequest {
  dimension: DimensionKind;
  epoch: number;
  file: string;
  id: number;
  op: 'resolveDimension';
  options: DimensionSearchOptions;
}

/**
 * Install a requested cube index and build `table`'s planner statistics on the worker,
 * clearing the store's stale flag with them — unless a sync holds the store's lease.
 */
export interface AnalyzeRequest {
  /** Install the cube's area/year index before refreshing planner statistics. */
  areaYearIndex?: boolean;
  epoch: number;
  file: string;
  id: number;
  op: 'analyze';
  state?: { generation: number; closing: boolean };
  table: string;
}

/** Install cube indexes on behalf of the sync that owns the domain store. */
export interface PrepareIndexesRequest {
  /** Set only while the worker may hold the writer lock, allowing the runner to defer renewals. */
  activity: Int32Array;
  epoch: number;
  file: string;
  id: number;
  lease: SyncLease;
  op: 'prepareIndexes';
  statements: string[];
}

/** Close every cached handle, then end the thread. */
export interface CloseRequest {
  op: 'close';
}

/** A job the pool dispatches — a read or a statistics build. */
export type JobRequest =
  | ReadRequest
  | AnalyzeRequest
  | PrepareIndexesRequest
  | ResolveDimensionRequest;

export type WorkerRequest = JobRequest | CloseRequest;

/** A failure, reduced to what survives `postMessage`. `code` is an `McpError` code. */
export interface WorkerFailure {
  code?: number;
  message: string;
  name: string;
}

export type WorkerReply =
  | { id: number; rows: unknown[] }
  | { id: number; matches: DimensionSearchResult }
  | { id: number; durationMs: number }
  | { id: number; prepared: true }
  | { id: number; superseded: true }
  | { id: number; leaseLost: true }
  | { id: number; leaseHeld: true }
  | { id: number; error: WorkerFailure };

const port = parentPort;
if (!port) throw new Error('read-worker runs only as a worker thread.');

const handles = new Map<string, { epoch: number; handle: SqliteHandle }>();
const CLOSING_LEASE_TTL_MS = 120_000;
const searchModule = new URL(
  `./dimension-search${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

async function handleFor(file: string, epoch: number, queryOnly: boolean): Promise<SqliteHandle> {
  const cached = handles.get(file);
  if (cached?.epoch === epoch) return cached.handle;
  cached?.handle.close();
  handles.delete(file);
  const handle = await openSqliteHandle(file);
  try {
    if (queryOnly) handle.exec('PRAGMA query_only = ON');
  } catch (error) {
    handle.close();
    throw error;
  }
  handles.set(file, { epoch, handle });
  return handle;
}

/**
 * True while a sync holds the store's lease (the framework store's
 * `mirror_sync_lease`): an owner whose expiry has not passed, as the framework's own
 * claim reads it.
 */
function syncLeaseHeld(handle: SqliteHandle): boolean {
  return (
    handle
      .prepare(
        'SELECT 1 AS held FROM mirror_sync_lease WHERE id = 1 AND owner IS NOT NULL AND expires_at > ?',
      )
      .get(Date.now()) !== undefined
  );
}

/** Prevent a retired sync from changing the cube after another sync takes ownership. */
function prepareIndexes(handle: SqliteHandle, request: PrepareIndexesRequest): boolean {
  const { owner, generation, ttlMs } = request.lease;
  return handle.transaction(() => {
    const lease = handle
      .prepare(
        'SELECT 1 FROM mirror_sync_lease WHERE id = 1 AND owner = ? AND generation = ? AND expires_at > ?',
      )
      .get(owner, generation, Date.now());
    if (!lease) return false;
    for (const statement of request.statements) handle.exec(statement);
    handle
      .prepare('UPDATE mirror_sync_lease SET expires_at = ? WHERE id = 1')
      .run(Date.now() + ttlMs);
    return true;
  }, 'immediate');
}

/** A build that became obsolete while queued must leave the current statistics alone. */
function superseded(handle: SqliteHandle, request: AnalyzeRequest): boolean {
  return (
    !!request.state &&
    handle
      .prepare('SELECT 1 FROM planner_statistics WHERE stale = 0 AND generation != ?')
      .get(request.state.generation) !== undefined
  );
}

/** Use the same store lease for the closing build after the sync runner releases it. */
function analyze(handle: SqliteHandle, request: AnalyzeRequest): AnalyzeOutcome {
  if (syncLeaseHeld(handle)) return 'leaseHeld';
  if (superseded(handle, request)) return 'superseded';
  if (!request.state?.closing) return buildStatistics(handle, request);
  const owner = crypto.randomUUID();
  const now = Date.now();
  // A committed lease is visible to reads while the analysis write transaction is open.
  let claimed: unknown;
  try {
    claimed = handle
      .prepare(
        'UPDATE mirror_sync_lease SET owner = ?, generation = generation + 1, expires_at = ? WHERE id = 1 AND (owner IS NULL OR expires_at <= ?) RETURNING generation',
      )
      .get(owner, now + CLOSING_LEASE_TTL_MS, now);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !code.startsWith('SQLITE_BUSY')) throw error;
    if (syncLeaseHeld(handle)) return 'leaseHeld';
    if (superseded(handle, request)) return 'superseded';
    throw error;
  }
  if (!claimed) return 'leaseHeld';
  try {
    return buildStatistics(handle, request, owner);
  } finally {
    handle
      .prepare(
        'UPDATE mirror_sync_lease SET owner = NULL, expires_at = NULL WHERE id = 1 AND owner = ?',
      )
      .run(owner);
  }
}

type AnalyzeOutcome = 'built' | 'leaseHeld' | 'superseded';

function analyzeRefusal(
  handle: SqliteHandle,
  request: AnalyzeRequest,
  owner?: string,
): Exclude<AnalyzeOutcome, 'built'> | undefined {
  const available = owner
    ? handle.prepare('SELECT 1 FROM mirror_sync_lease WHERE id = 1 AND owner = ?').get(owner) !==
      undefined
    : !syncLeaseHeld(handle);
  if (!available) return 'leaseHeld';
  if (superseded(handle, request)) return 'superseded';
  return undefined;
}

/**
 * The statements that build `table`'s statistics: one `ANALYZE` per index, partial
 * indexes included (#62), which writes the `sqlite_stat1` and `sqlite_stat4` rows
 * `ANALYZE <table>` would. A table without a full index — never a cube — keeps the
 * whole-table statement: only that one records the table's own row count, and it
 * reports a table that does not exist.
 */
function analyzeStatements(handle: SqliteHandle, table: string): string[] {
  const indexes = handle
    .prepare<{ name: string; partial: number }>('SELECT name, partial FROM pragma_index_list(?)')
    .all(table);
  if (!indexes.some((index) => index.partial === 0)) return [`ANALYZE ${table}`];
  return indexes.map((index) => `ANALYZE "${index.name.replaceAll('"', '""')}"`);
}

/**
 * Install the requested area/year index, then build `table`'s statistics and clear
 * the store's stale flag (`planner_statistics`, which the store's migrations create)
 * in one transaction, so a build that does not commit leaves the flag set. Each step
 * is its own `BEGIN IMMEDIATE`, with the lease and generation rechecked before writes.
 * An index the first step installed stays if the statistics step does not complete.
 *
 * The statistics step is a run of short statements rather than one whole-table
 * `ANALYZE`: a `terminate()` takes effect only once the running statement returns,
 * and under Node the process exit waits for it, so a pool that closes mid-build
 * waits out one index's `ANALYZE`, and the transaction it leaves open commits
 * nothing (#62).
 */
function buildStatistics(
  handle: SqliteHandle,
  request: AnalyzeRequest,
  owner?: string,
): AnalyzeOutcome {
  if (request.areaYearIndex) {
    const indexed = handle.transaction(() => {
      const refusal = analyzeRefusal(handle, request, owner);
      if (refusal) return refusal;
      handle.exec(
        `CREATE INDEX IF NOT EXISTS ${request.table}_area_code_year_idx ON ${request.table}(area_code, year)`,
      );
      return 'built';
    }, 'immediate');
    if (indexed !== 'built') return indexed;
  }
  return handle.transaction(() => {
    const refusal = analyzeRefusal(handle, request, owner);
    if (refusal) return refusal;
    for (const statement of analyzeStatements(handle, request.table)) handle.exec(statement);
    handle.exec(
      request.state
        ? 'UPDATE planner_statistics SET stale = 0, generation = generation + 1'
        : 'UPDATE planner_statistics SET stale = 0',
    );
    return 'built';
  }, 'immediate');
}

function toFailure(error: unknown): WorkerFailure {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const { code } = error as { code?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'number' ? { code } : {}),
  };
}

port.on('message', async (request: WorkerRequest) => {
  if (request.op === 'close') {
    for (const { handle } of handles.values()) handle.close();
    handles.clear();
    port.close();
    return;
  }
  let reply: WorkerReply;
  try {
    const handle = await handleFor(request.file, request.epoch, request.op === 'resolveDimension');
    if (request.op === 'resolveDimension') {
      const { searchDimension }: typeof import('./dimension-search.js') = await import(
        searchModule.href
      );
      reply = {
        id: request.id,
        matches: searchDimension(handle, request.dimension, request.options),
      };
    } else if (request.op === 'analyze') {
      const start = performance.now();
      const outcome = analyze(handle, request);
      reply =
        outcome === 'built'
          ? { id: request.id, durationMs: Math.round(performance.now() - start) }
          : outcome === 'leaseHeld'
            ? { id: request.id, leaseHeld: true }
            : { id: request.id, superseded: true };
    } else if (request.op === 'prepareIndexes') {
      while (Atomics.compareExchange(request.activity, 0, 0, 1) === 2) {
        Atomics.wait(request.activity, 0, 2);
      }
      try {
        reply = prepareIndexes(handle, request)
          ? { id: request.id, prepared: true }
          : { id: request.id, leaseLost: true };
      } finally {
        Atomics.store(request.activity, 0, 0);
      }
    } else {
      reply = { id: request.id, rows: handle.prepare(request.sql).all(...request.params) };
    }
  } catch (error) {
    reply = { id: request.id, error: toFailure(error) };
  }
  port.postMessage(reply);
});
