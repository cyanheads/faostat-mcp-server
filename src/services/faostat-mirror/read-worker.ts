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

/** Build `table`'s planner statistics — `ANALYZE`, which holds the file's write lock throughout. */
export interface AnalyzeRequest {
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
      handle.exec(`ANALYZE ${request.table}`);
      reply = { id: request.id, durationMs: Math.round(performance.now() - start) };
    } else {
      reply = { id: request.id, rows: handle.prepare(request.sql).all(...request.params) };
    }
  } catch (error) {
    reply = { id: request.id, error: toFailure(error) };
  }
  port.postMessage(reply);
});
