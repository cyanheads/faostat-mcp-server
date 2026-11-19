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
 * A build writes only while no sync holds the store's lease (#60): it holds the
 * write lock past `busy_timeout`, so one running under a sync in another process
 * would fail that sync's next page commit. It reads the lease under the write lock
 * it is about to write under, so no sync claims the lease mid-step, and replies
 * `leaseHeld` instead of building when a sync holds it.
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
 * `dist/`: package and `node:` imports only — no `@/` alias, no relative runtime
 * import — and erasable TypeScript only.
 * @module services/faostat-mirror/read-worker
 */

import { parentPort } from 'node:worker_threads';
import { openSqliteHandle, type SqliteHandle, type SqlValue } from '@cyanheads/mcp-ts-core/mirror';

/** Run `sql` against `file` and reply with every row. */
export interface ReadRequest {
  epoch: number;
  file: string;
  id: number;
  op: 'all';
  params: SqlValue[];
  sql: string;
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
  table: string;
}

/** Close every cached handle, then end the thread. */
export interface CloseRequest {
  op: 'close';
}

/** A job the pool dispatches — a read or a statistics build. */
export type JobRequest = ReadRequest | AnalyzeRequest;

export type WorkerRequest = JobRequest | CloseRequest;

/** A failure, reduced to what survives `postMessage`. `code` is an `McpError` code. */
export interface WorkerFailure {
  code?: number;
  message: string;
  name: string;
}

export type WorkerReply =
  | { id: number; rows: unknown[] }
  | { id: number; durationMs: number }
  | { id: number; leaseHeld: true }
  | { id: number; error: WorkerFailure };

const port = parentPort;
if (!port) throw new Error('read-worker runs only as a worker thread.');

const handles = new Map<string, { epoch: number; handle: SqliteHandle }>();

async function handleFor(file: string, epoch: number): Promise<SqliteHandle> {
  const cached = handles.get(file);
  if (cached?.epoch === epoch) return cached.handle;
  cached?.handle.close();
  handles.delete(file);
  const handle = await openSqliteHandle(file);
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
 * is its own `BEGIN IMMEDIATE` and writes only once it finds no sync holding the
 * lease. False when a lease stopped it; an index the first step installed stays.
 *
 * The statistics step is a run of short statements rather than one whole-table
 * `ANALYZE`: a `terminate()` takes effect only once the running statement returns,
 * and under Node the process exit waits for it, so a pool that closes mid-build
 * waits out one index's `ANALYZE`, and the transaction it leaves open commits
 * nothing (#62).
 */
function buildStatistics(handle: SqliteHandle, request: AnalyzeRequest): boolean {
  if (request.areaYearIndex) {
    const indexed = handle.transaction(() => {
      if (syncLeaseHeld(handle)) return false;
      handle.exec(
        `CREATE INDEX IF NOT EXISTS ${request.table}_area_code_year_idx ON ${request.table}(area_code, year)`,
      );
      return true;
    }, 'immediate');
    if (!indexed) return false;
  }
  return handle.transaction(() => {
    if (syncLeaseHeld(handle)) return false;
    for (const statement of analyzeStatements(handle, request.table)) handle.exec(statement);
    handle.exec('UPDATE planner_statistics SET stale = 0');
    return true;
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
    const handle = await handleFor(request.file, request.epoch);
    if (request.op === 'analyze') {
      const start = performance.now();
      reply = buildStatistics(handle, request)
        ? { id: request.id, durationMs: Math.round(performance.now() - start) }
        : { id: request.id, leaseHeld: true };
    } else {
      reply = { id: request.id, rows: handle.prepare(request.sql).all(...request.params) };
    }
  } catch (error) {
    reply = { id: request.id, error: toFailure(error) };
  }
  port.postMessage(reply);
});
