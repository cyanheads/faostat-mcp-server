/**
 * @fileoverview `ReadPool` — runs cube reads off the main thread (#3). Both SQLite
 * drivers are synchronous and neither can interrupt a running statement, so a read
 * on the main thread stalls every request, `/healthz` included, for its full
 * duration. The pool hands each read to one of two `node:worker_threads` workers
 * (the same API under Bun and Node) through a FIFO queue. The main thread keeps
 * building the SQL and owns the framework `Mirror` (sync and DDL).
 *
 * A read that outlives its signal — the per-call ceiling or a cancellation — is cut
 * off: the caller is rejected at once and the worker, which `terminate()` stops only
 * once its statement returns, is retired and replaced. Retired workers count toward
 * a four-thread cap, so a replacement waits for one to exit before the pool would
 * pass it.
 *
 * The same workers build a domain's planner statistics (`ANALYZE`, #24) — seconds on
 * QCL, over a minute on TCL. A build takes no signal: nothing waits on it inside a
 * tool call, so no ceiling or cancellation applies. It queues with the reads, first
 * in, first out, but never takes a worker while another build runs: a queued build
 * lets reads pass it, and the two workers never both hold a build, so reads always
 * keep one.
 * @module services/faostat-mirror/read-pool
 */

import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  McpError,
  requestCancelled,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import type { SqlValue } from '@cyanheads/mcp-ts-core/mirror';
import type {
  AnalyzeRequest,
  JobRequest,
  ReadRequest,
  WorkerFailure,
  WorkerReply,
  WorkerRequest,
} from './read-worker.js';

/**
 * Per-tool-call ceiling on mirror reads, queue wait included — under the MCP SDK's
 * 60 s default client timeout, so the caller gets a declared `query_timeout`
 * rather than a transport timeout.
 */
export const QUERY_CEILING_MS = 45_000;

/** Workers serving jobs. */
const POOL_SIZE = 2;
/** Live plus retired workers the pool may hold — two retired beyond {@link POOL_SIZE}. */
const MAX_THREADS = 4;

/**
 * The worker entry beside this module, with this module's own extension: `.ts`
 * from source (Vitest, Bun), `.js` from `dist/` (the npm bin, `.mcpb`, Docker).
 */
const DEFAULT_ENTRY = new URL(
  `./read-worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

/** One read: a statement built on the main thread, run against a domain file. */
export interface ReadJob {
  file: string;
  params: SqlValue[];
  sql: string;
}

/** Point-in-time pool counters. `threads` never exceeds four. */
export interface ReadPoolStats {
  /** Workers running a statistics build — never more than one. */
  building: number;
  /** Workers running a job, read or build. */
  busy: number;
  /** Workers serving jobs, busy or idle. */
  live: number;
  /** Jobs waiting for a worker. */
  queued: number;
  /** Cut-off workers still finishing their statement. */
  retired: number;
  /** `live + retired`. */
  threads: number;
}

/** What a queued job asks its worker to do, minus the `id` and `epoch` added at dispatch. */
type JobSpec = Omit<ReadRequest, 'id' | 'epoch'> | Omit<AnalyzeRequest, 'id' | 'epoch'>;

interface PendingJob {
  /** Removes the abort listener once the job settles. */
  detach: () => void;
  id: number;
  reject: (error: unknown) => void;
  /** Settles with a read's rows, or a build's duration in ms. */
  resolve: (value: unknown) => void;
  spec: JobSpec;
}

/** One of the {@link POOL_SIZE} places a worker serves from; both fields clear as it frees up. */
interface Slot {
  job?: PendingJob | undefined;
  worker?: Worker | undefined;
}

/**
 * Combine a tool call's signal with the {@link QUERY_CEILING_MS} ceiling. The
 * ceiling aborts with a retryable `Timeout` carrying `reason: 'query_timeout'`,
 * which the tools declare; created once per call, it covers every read the call
 * makes, queue wait and execution alike.
 */
export function withQueryCeiling(
  signal: AbortSignal | undefined,
  ms = QUERY_CEILING_MS,
): AbortSignal {
  const ceiling = new AbortController();
  const timer = setTimeout(
    () =>
      ceiling.abort(
        timeout(`Mirror reads for this call ran past the ${ms / 1000}s ceiling.`, {
          reason: 'query_timeout',
          retryable: true,
        }),
      ),
    ms,
  );
  timer.unref();
  return signal ? AbortSignal.any([signal, ceiling.signal]) : ceiling.signal;
}

/** The error a read rejects with once `signal` aborts: its reason when typed, else a cancellation. */
function abortError(signal: AbortSignal): McpError {
  const { reason } = signal;
  return reason instanceof McpError
    ? reason
    : requestCancelled('The mirror read was cancelled.', {}, { cause: reason });
}

/** Rebuild a worker-side failure on the main thread. */
function fromFailure({ code, message, name }: WorkerFailure): Error {
  if (code !== undefined) return new McpError(code, message);
  return Object.assign(new Error(message), { name });
}

export class ReadPool {
  private closed = false;
  private readonly entry: URL;
  /** Bumped per file by {@link invalidate}; a worker reopens a handle opened under an older one. */
  private readonly epochs = new Map<string, number>();
  private nextId = 0;
  private readonly queue: PendingJob[] = [];
  private readonly retired = new Set<Worker>();
  private readonly slots: Slot[] = Array.from({ length: POOL_SIZE }, () => ({}));

  /** @param entry Worker entry module — injectable so tests can run a fixture worker. */
  constructor(entry: URL = DEFAULT_ENTRY) {
    this.entry = entry;
  }

  /**
   * Run `job` on a worker and resolve with its rows. Rejects with the abort reason
   * when `signal` aborts first — its own `McpError` (the ceiling's `query_timeout`),
   * or `RequestCancelled` for any other reason — whether the read is still queued
   * or already running.
   */
  all<TRow>(job: ReadJob, signal?: AbortSignal): Promise<TRow[]> {
    if (this.closed) {
      return Promise.reject(serviceUnavailable('The mirror read pool is closed.'));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<TRow[]>((resolve, reject) => {
      const read = this.enqueue({ op: 'all', ...job }, resolve as (rows: unknown) => void, reject);
      if (signal) {
        const onAbort = () => this.cutOff(read, abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        read.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.pump();
    });
  }

  /**
   * Build `table`'s planner statistics in `file` on a worker, and resolve with how
   * long the `ANALYZE` statement ran, in ms. Takes no signal, so it is never cut off:
   * it rejects only with the driver's error (a writer holding the lock past
   * `busy_timeout`, a read-only file), with `DatabaseError` when the worker cannot
   * open the file, or when the pool closes first. The caller reports success to the
   * other workers with {@link invalidate}.
   */
  analyze(file: string, table: string): Promise<number> {
    if (this.closed) {
      return Promise.reject(serviceUnavailable('The mirror read pool is closed.'));
    }
    return new Promise<number>((resolve, reject) => {
      this.enqueue({ op: 'analyze', file, table }, resolve as (ms: unknown) => void, reject);
      this.pump();
    });
  }

  /**
   * Make workers reopen their handle on `file` before its next job. Call after
   * rewriting the file's planner statistics: a connection that already loaded its
   * schema keeps the statistics it read then.
   */
  invalidate(file: string): void {
    this.epochs.set(file, (this.epochs.get(file) ?? 0) + 1);
  }

  stats(): ReadPoolStats {
    const live = this.slots.filter((slot) => slot.worker).length;
    return {
      building: this.building(),
      busy: this.slots.filter((slot) => slot.job).length,
      live,
      queued: this.queue.length,
      retired: this.retired.size,
      threads: live + this.retired.size,
    };
  }

  /**
   * Reject every queued and running job, close idle workers and wait for them to
   * exit. A worker mid-statement is retired rather than awaited — neither driver
   * can interrupt it, and under Node the process exit still waits for it.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closing = () => serviceUnavailable('The mirror read pool closed before the job ran.');
    for (const job of this.queue.splice(0)) this.fail(job, closing());
    const exits: Promise<unknown>[] = [];
    for (const slot of this.slots) {
      const { job, worker } = slot;
      if (!worker) continue;
      if (job) {
        slot.job = undefined;
        this.fail(job, closing());
        this.retire(slot);
        continue;
      }
      slot.worker = undefined;
      worker.ref();
      exits.push(new Promise((resolve) => worker.once('exit', resolve)));
      worker.postMessage({ op: 'close' } satisfies WorkerRequest);
    }
    await Promise.all(exits);
  }

  private enqueue(
    spec: JobSpec,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  ): PendingJob {
    const job: PendingJob = { id: ++this.nextId, spec, resolve, reject, detach: () => {} };
    this.queue.push(job);
    return job;
  }

  /** Workers running a statistics build. */
  private building(): number {
    return this.slots.filter((slot) => slot.job?.spec.op === 'analyze').length;
  }

  /**
   * Hand queued jobs, oldest first, to free workers — spawning one only under the
   * thread cap. A build waits while another build runs, and reads behind it pass.
   */
  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.job) continue;
      const buildRunning = this.building() > 0;
      const next = this.queue.findIndex((job) => job.spec.op === 'all' || !buildRunning);
      if (next === -1) return;
      if (!slot.worker) {
        if (this.stats().threads >= MAX_THREADS) continue;
        slot.worker = this.spawn();
      }
      const [job] = this.queue.splice(next, 1) as [PendingJob];
      slot.job = job;
      slot.worker.ref();
      slot.worker.postMessage({
        ...job.spec,
        id: job.id,
        epoch: this.epochs.get(job.spec.file) ?? 0,
      } satisfies JobRequest);
    }
  }

  private spawn(): Worker {
    const worker = new Worker(this.entry);
    worker.unref();
    let failure: unknown;
    worker.on('error', (error) => {
      failure = error;
    });
    worker.on('message', (reply: WorkerReply) => {
      const slot = this.slots.find((candidate) => candidate.worker === worker);
      const job = slot?.job;
      if (!slot || job?.id !== reply.id) return;
      slot.job = undefined;
      worker.unref();
      job.detach();
      if ('error' in reply) job.reject(fromFailure(reply.error));
      else job.resolve('rows' in reply ? reply.rows : reply.durationMs);
      this.pump();
    });
    worker.on('exit', (code) => {
      if (this.retired.delete(worker)) {
        this.pump();
        return;
      }
      const slot = this.slots.find((candidate) => candidate.worker === worker);
      if (!slot) return;
      slot.worker = undefined;
      const { job } = slot;
      slot.job = undefined;
      if (job) {
        this.fail(
          job,
          serviceUnavailable(
            `The mirror read worker exited (code ${code}) before the job returned.`,
            { retryable: true },
            failure === undefined ? undefined : { cause: failure },
          ),
        );
      }
      this.pump();
    });
    return worker;
  }

  /** Reject `read` with `error` at once, wherever it is; a running read's worker is retired. */
  private cutOff(read: PendingJob, error: McpError): void {
    const queued = this.queue.indexOf(read);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.fail(read, error);
      return;
    }
    const slot = this.slots.find((candidate) => candidate.job === read);
    if (!slot) return;
    slot.job = undefined;
    this.fail(read, error);
    this.retire(slot);
    this.pump();
  }

  /** Stop the slot's worker and count it as retired until it exits. */
  private retire(slot: Slot): void {
    const { worker } = slot;
    if (!worker) return;
    slot.worker = undefined;
    this.retired.add(worker);
    worker.unref();
    void worker.terminate();
  }

  private fail(job: PendingJob, error: unknown): void {
    job.detach();
    job.reject(error);
  }
}
