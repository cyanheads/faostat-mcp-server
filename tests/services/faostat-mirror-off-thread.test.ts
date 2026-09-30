/**
 * @fileoverview Off-thread cube reads (#3). Every cube read runs on the
 * `ReadPool` worker threads, so a slow statement delays only its own caller.
 * Covered here, on whichever driver the lane loads (`bun run test` runs the file
 * under Bun with `bun:sqlite`, then under Node with `better-sqlite3`):
 *
 *  - the pool: the main thread keeps ticking through a recursive-CTE spin (with a
 *    same-thread control that shows the gap it closes), an unrelated read is
 *    answered while a slow one runs, the queue is FIFO, the ceiling and a
 *    cancellation cut off a read queued or running, a cut-off worker is retired
 *    and replaced under the four-thread cap, a crashed worker fails its read
 *    retryably, `invalidate()` makes a worker replan from rewritten statistics,
 *    and `close()` settles everything;
 *  - statistics builds on the pool (#24): `analyze()` runs `ANALYZE` on a worker,
 *    a failing build keeps its worker, a second build waits while reads pass it,
 *    and `close()` settles queued and running builds;
 *  - `FaostatMirror`: all five read paths honor an aborted signal, and a
 *    successful ANALYZE invalidates the domain file's worker handles;
 *  - the tools: the declared `query_timeout` on both client surfaces, a
 *    cancellation mid-read settling as `RequestCancelled` rather than a degraded
 *    success, a read failure in the staging stream failing the call, and a
 *    domain's first data read answering without waiting for its statistics
 *    build (#24);
 *  - `stageObservations`: a failure its source raises is rethrown, a canvas
 *    failure still degrades.
 *
 * Spins are sized from a per-run calibration, so their durations hold across
 * runtimes and machines; the one test that asserts a minimum duration resizes its
 * spin from measured runs, since load at calibration time can undersize it. Every
 * pool waits out its retired workers before the next test: under Node, process
 * exit waits for a worker mid-statement.
 * @module tests/services/faostat-mirror-off-thread
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanvasInstance,
  createCanvasService,
  type DataCanvas,
} from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { openSqliteHandle, type SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { OBSERVATION_TABLE_SCHEMA, stageObservations } from '@/services/canvas-staging.js';
import { FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { type ReadJob, ReadPool, withQueryCeiling } from '@/services/faostat-mirror/read-pool.js';
import {
  buildDomainZip,
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** Any tool definition `runToolContract` accepts. */
type AnyToolDefinition = Parameters<typeof runToolContract>[0];

/** Worker entry that crashes on `sql: 'crash'` and answers anything else with `{ ok: 1 }`. */
const CRASH_ENTRY = new URL('../fixtures/crash-read-worker.mjs', import.meta.url);

/** A pure-CPU statement SQLite cannot be interrupted out of: count to `n` recursively. */
const SPIN_SQL =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c';

/** Real DuckDB canvas shared across the file (staging and the spilling tool call). */
let canvas: DataCanvas;
/** Scratch directory; `spinFile` is the SQLite file the pool-level reads open. */
let dir: string;
let spinFile: string;
/**
 * A main-thread connection held on `spinFile` for the whole file, as the mirror
 * holds one on every domain file before a worker reads it.
 */
let spinHolder: SqliteHandle;
/** Spin iterations per millisecond on this runtime, measured through the pool. */
let iterationsPerMs: number;

function spin(iterations: number): ReadJob {
  return { file: spinFile, sql: SPIN_SQL, params: [iterations] };
}

/** A spin sized to run for about `ms` on this runtime. */
function spinFor(ms: number): ReadJob {
  return spin(Math.ceil(iterationsPerMs * ms));
}

/** A read that returns at once. */
function quick(n = 1): ReadJob {
  return { file: spinFile, sql: 'SELECT ? AS n', params: [n] };
}

/** A signal already aborted with the ceiling's own error, as if the call's 45 s ran out. */
function timedOut(): AbortSignal {
  const controller = new AbortController();
  controller.abort(
    timeout('Mirror reads for this call ran past the ceiling.', {
      reason: 'query_timeout',
      retryable: true,
    }),
  );
  return controller.signal;
}

/** A fresh SQLite file under `dir` holding an indexed table `t`, for a statistics build. */
async function analyzable(name: string): Promise<string> {
  const file = join(dir, name);
  const handle = await openSqliteHandle(file);
  handle.exec('CREATE TABLE t (a INTEGER, b INTEGER); CREATE INDEX t_a ON t (a);');
  const insert = handle.prepare('INSERT INTO t VALUES (?, ?)');
  handle.transaction(() => {
    for (let i = 0; i < 500; i++) insert.run(i % 7, i);
  });
  handle.close();
  return file;
}

/** `sqlite_stat1` rows for table `t` in `file`, read on a fresh connection. */
async function statRowCount(file: string): Promise<number> {
  const handle = await openSqliteHandle(file);
  const present = handle
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`)
    .get();
  const count = present
    ? (handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl = 't'`).get()
        ?.n ?? 0)
    : 0;
  handle.close();
  return count;
}

/** Pools a test creates — closed, with their retired workers waited out, after it. */
const pools: ReadPool[] = [];

function track(pool: ReadPool): ReadPool {
  pools.push(pool);
  return pool;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'faostat-off-thread-'));
  spinFile = join(dir, 'spin.db');
  spinHolder = await openSqliteHandle(spinFile);
  const built = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
  if (!built) throw new Error('expected a DuckDB canvas to be constructed for the test');
  canvas = built;
  setCanvas(canvas);

  const pool = new ReadPool();
  await pool.all(spin(1));
  const iterations = 2_000_000;
  const start = performance.now();
  await pool.all(spin(iterations));
  iterationsPerMs = iterations / (performance.now() - start);
  await pool.close();
}, 30_000);

afterAll(async () => {
  setCanvas(undefined);
  await canvas.shutdown(createMockContext({ tenantId: 'teardown' }));
  spinHolder.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const pool of pools.splice(0)) {
    await pool.close();
    await vi.waitFor(() => expect(pool.stats().retired).toBe(0), {
      timeout: 20_000,
      interval: 50,
    });
  }
}, 30_000);

describe('ReadPool', () => {
  it('keeps the main thread ticking through a slow statement that stalls it when run inline', async () => {
    /** Longest gap between 5 ms ticks while `read` runs, and how long `read` took. */
    async function measure(read: () => unknown): Promise<{ duration: number; maxGap: number }> {
      let last = performance.now();
      let maxGap = 0;
      const beat = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 5);
      const start = performance.now();
      await read();
      const duration = performance.now() - start;
      clearInterval(beat);
      return { duration, maxGap: Math.max(maxGap, performance.now() - last) };
    }

    const pool = track(new ReadPool());
    await pool.all(quick()); // spawn and open outside the measured window
    /**
     * The file's calibration may have run under heavier parallel load than this
     * test sees, which undersizes the spin. Resize it from each measured run until
     * one lasts past the floor; the gap bound is checked on that run alone.
     */
    let iterations = Math.ceil(iterationsPerMs * 600);
    let offThread = await measure(() => pool.all(spin(iterations)));
    for (let resized = 0; offThread.duration <= 300 && resized < 4; resized++) {
      iterations = Math.ceil((iterations * 600) / offThread.duration);
      offThread = await measure(() => pool.all(spin(iterations)));
    }
    expect(offThread.duration).toBeGreaterThan(300);
    expect(offThread.maxGap).toBeLessThan(offThread.duration / 3);

    // Control: the same statement on a main-thread handle freezes the timer for
    // its whole run — the stall every request used to wait out.
    const job = spin(iterations);
    const handle = await openSqliteHandle(spinFile);
    const inline = await measure(() => handle.prepare(job.sql).all(...job.params));
    handle.close();
    expect(inline.maxGap).toBeGreaterThan(inline.duration * 0.8);
  }, 30_000);

  it('answers other reads while a slow one runs, and serves its queue first in, first out', async () => {
    const pool = track(new ReadPool());
    const order: string[] = [];
    const note =
      (label: string) =>
      <T>(rows: T) => {
        order.push(label);
        return rows;
      };
    const slow = pool.all<{ n: number }>(spinFor(2000)).then(note('slow'));
    const short = pool.all(spinFor(300)).then(note('short'));
    const queued = [1, 2, 3].map((n) =>
      pool.all<{ n: number }>(quick(n)).then(note(`queued ${n}`)),
    );
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 3 });

    const answered = await Promise.all(queued);
    expect(answered.map(([row]) => row?.n)).toEqual([1, 2, 3]);
    // The queue drained through the worker the short spin freed, in submission
    // order, while the slow spin still held the other one.
    expect(order).toEqual(['short', 'queued 1', 'queued 2', 'queued 3']);
    expect(pool.stats()).toMatchObject({ busy: 1, queued: 0 });

    const [total] = await slow;
    expect(total?.n).toBe(spinFor(2000).params[0]);
    await short;
    expect(order.at(-1)).toBe('slow');
  }, 30_000);

  it('cuts a running read off at the ceiling with a retryable query_timeout, then serves the next read on a replacement', async () => {
    const pool = track(new ReadPool());
    await pool.all(quick()); // a warm worker, so the ceiling lands mid-statement

    await expect(pool.all(spinFor(2500), withQueryCeiling(undefined, 100))).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'query_timeout', retryable: true },
    });
    // Rejected while the statement still runs: its worker is retired, not idle.
    expect(pool.stats()).toMatchObject({ busy: 0, live: 0, retired: 1, threads: 1 });

    await expect(pool.all(quick(7))).resolves.toEqual([{ n: 7 }]);
    expect(pool.stats()).toMatchObject({ live: 1, retired: 1, threads: 2 });
  }, 30_000);

  it('times out a read still waiting in the queue without retiring a worker', async () => {
    const pool = track(new ReadPool());
    const busy = [pool.all(spinFor(1500)), pool.all(spinFor(1500))];
    const waiting = pool.all(quick(), withQueryCeiling(undefined, 100));
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 1 });

    await expect(waiting).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'query_timeout' },
    });
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 0, retired: 0 });
    await Promise.all(busy);
  }, 30_000);

  it('rejects a cancelled read with RequestCancelled — before it starts, queued, or running', async () => {
    const pool = track(new ReadPool());
    await expect(pool.all(quick(), AbortSignal.abort())).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });

    await Promise.all([pool.all(quick()), pool.all(quick())]); // two warm workers
    const running = new AbortController();
    const waiting = new AbortController();
    const cancelled = pool.all(spinFor(2000), running.signal);
    const other = pool.all(spinFor(800));
    const queued = pool.all(quick(), waiting.signal);
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 1 });

    waiting.abort();
    await expect(queued).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 0, retired: 0 });

    running.abort();
    await expect(cancelled).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(pool.stats()).toMatchObject({ busy: 1, retired: 1 });
    await other;
  }, 30_000);

  it('rejects with the abort reason itself when the signal carries an McpError', async () => {
    const pool = track(new ReadPool());
    const reason = new McpError(JsonRpcErrorCode.Timeout, 'typed abort reason', {
      reason: 'query_timeout',
    });
    const controller = new AbortController();
    controller.abort(reason);
    await expect(pool.all(quick(), controller.signal)).rejects.toBe(reason);
  });

  it('never holds more than four threads: past two retired workers, a replacement waits for one to exit', async () => {
    const pool = track(new ReadPool());
    let maxThreads = 0;
    const sample = setInterval(() => {
      maxThreads = Math.max(maxThreads, pool.stats().threads);
    }, 5);

    /** Two long reads on the two warm workers, both cut off at 100 ms. */
    async function cutOffBoth(): Promise<void> {
      await Promise.all([pool.all(quick()), pool.all(quick())]);
      const reads = [
        pool.all(spinFor(3000), withQueryCeiling(undefined, 100)),
        pool.all(spinFor(3000), withQueryCeiling(undefined, 100)),
      ];
      const settled = await Promise.allSettled(reads);
      expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    }

    await cutOffBoth();
    expect(pool.stats()).toMatchObject({ live: 0, retired: 2, threads: 2 });
    await cutOffBoth();
    expect(pool.stats()).toMatchObject({ live: 0, retired: 4, threads: 4 });

    // At the cap: the read waits in the queue — no fifth thread.
    const next = pool.all(quick(9));
    expect(pool.stats()).toMatchObject({ live: 0, queued: 1, threads: 4 });
    await expect(next).resolves.toEqual([{ n: 9 }]);
    // Served only once a retired worker had exited.
    expect(pool.stats().retired).toBeLessThan(4);

    clearInterval(sample);
    expect(maxThreads).toBe(4);
  }, 30_000);

  it('fails a read whose worker dies with a retryable ServiceUnavailable, and respawns for the next', async () => {
    const pool = track(new ReadPool(CRASH_ENTRY));
    await expect(pool.all({ file: spinFile, sql: 'crash', params: [] })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: true },
    });
    expect(pool.stats()).toMatchObject({ busy: 0, live: 0, retired: 0 });
    await expect(pool.all(quick())).resolves.toEqual([{ ok: 1 }]);
  });

  it("rejects a failing statement with the driver's error and keeps the worker", async () => {
    const pool = track(new ReadPool());
    await expect(
      pool.all({ file: spinFile, sql: 'SELECT * FROM missing_table', params: [] }),
    ).rejects.toThrow(/no such table/);
    expect(pool.stats()).toMatchObject({ busy: 0, live: 1, retired: 0 });
    await expect(pool.all(quick(3))).resolves.toEqual([{ n: 3 }]);
  });

  it('reopens a worker handle after invalidate(), so the worker plans from rewritten statistics', async () => {
    const file = join(dir, 'stats.db');
    const main = await openSqliteHandle(file);
    main.exec(
      'CREATE TABLE t (a INTEGER, b INTEGER, c INTEGER); CREATE INDEX t_a ON t (a); CREATE INDEX t_bc ON t (b, c);',
    );
    const insert = main.prepare('INSERT INTO t VALUES (?, ?, ?)');
    main.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run(i % 2, i % 100, i);
    });
    main.exec('ANALYZE t');
    // STAT4 (better-sqlite3's build) would plan from samples instead — drop them so
    // both drivers plan from the seeded stat1 figures alone.
    if (
      main
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat4'`)
        .get()
    ) {
      main.exec('DELETE FROM sqlite_stat4');
    }
    /** Rewrite `t`'s stat1 rows and reload them on the main connection only. */
    function seed(stats: [index: string, stat: string][]): void {
      main.exec(`DELETE FROM sqlite_stat1 WHERE tbl = 't'`);
      const row = main.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)');
      for (const [index, stat] of stats) row.run('t', index, stat);
      main.exec('ANALYZE sqlite_schema');
    }

    const pool = track(new ReadPool());
    const plan = async () => {
      const rows = await pool.all<{ detail: string }>({
        file,
        sql: 'EXPLAIN QUERY PLAN SELECT * FROM t WHERE a = ? AND b = ?',
        params: [1, 5],
      });
      return rows.map((r) => r.detail).join(' | ');
    };

    seed([
      ['t_a', '2000 1000'],
      ['t_bc', '2000 20 1'],
    ]);
    expect(await plan()).toMatch(/USING INDEX t_bc/);

    seed([
      ['t_a', '2000 1'],
      ['t_bc', '2000 1000 1'],
    ]);
    // The worker's connection already loaded its schema, so it keeps the old
    // statistics — the staleness invalidate() exists to clear.
    expect(await plan()).toMatch(/USING INDEX t_bc/);

    pool.invalidate(file);
    expect(await plan()).toMatch(/USING INDEX t_a /);
    main.close();
  });

  it('builds planner statistics on a worker and resolves with how long ANALYZE ran (#24)', async () => {
    const file = await analyzable('build.db');
    const pool = track(new ReadPool());
    await expect(pool.analyze(file, 't')).resolves.toBeGreaterThanOrEqual(0);
    expect(await statRowCount(file)).toBeGreaterThan(0);
    // The worker that built them still serves reads.
    await expect(pool.all(quick(2))).resolves.toEqual([{ n: 2 }]);
    expect(pool.stats()).toMatchObject({ building: 0, busy: 0, live: 1 });
  });

  it("rejects a failing build with the driver's error and keeps the worker (#24)", async () => {
    const pool = track(new ReadPool());
    await expect(pool.analyze(spinFile, 'missing_table')).rejects.toThrow(/no such table/);
    expect(pool.stats()).toMatchObject({ building: 0, busy: 0, live: 1, retired: 0 });
  });

  it('never gives both workers to builds: a second build waits while reads pass it (#24)', async () => {
    const [first, second] = [await analyzable('build-a.db'), await analyzable('build-b.db')];
    const pool = track(new ReadPool());
    // The first build waits on this lock in its busy handler, as behind a writer.
    const holder = await openSqliteHandle(first);
    holder.exec('BEGIN IMMEDIATE');
    let builds: Promise<number>[];
    try {
      builds = [pool.analyze(first, 't'), pool.analyze(second, 't')];
      expect(pool.stats()).toMatchObject({ building: 1, busy: 1, queued: 1 });
      await expect(pool.all(quick(4))).resolves.toEqual([{ n: 4 }]);
      await expect(pool.all(spinFor(200))).resolves.toHaveLength(1);
      expect(pool.stats()).toMatchObject({ building: 1, queued: 1 });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    const durations = await Promise.all(builds);
    expect(durations.every((ms) => ms >= 0)).toBe(true);
    expect(pool.stats()).toMatchObject({ building: 0, busy: 0, queued: 0 });
    expect(await statRowCount(first)).toBeGreaterThan(0);
    expect(await statRowCount(second)).toBeGreaterThan(0);
  }, 30_000);

  it('close() rejects a queued build and retires the worker running one (#24)', async () => {
    const [first, second] = [await analyzable('close-a.db'), await analyzable('close-b.db')];
    const pool = track(new ReadPool());
    const holder = await openSqliteHandle(first);
    holder.exec('BEGIN IMMEDIATE');
    try {
      const builds = [pool.analyze(first, 't'), pool.analyze(second, 't')];
      await pool.close();
      for (const outcome of await Promise.allSettled(builds)) {
        expect(outcome).toMatchObject({
          status: 'rejected',
          reason: { code: JsonRpcErrorCode.ServiceUnavailable },
        });
      }
      expect(pool.stats()).toMatchObject({ building: 0, queued: 0, retired: 1 });
      await expect(pool.analyze(second, 't')).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 30_000);

  it('close() rejects queued and running reads, retires busy workers, ends idle ones, and refuses new reads', async () => {
    const idle = track(new ReadPool());
    await Promise.all([idle.all(quick()), idle.all(quick())]);
    expect(idle.stats()).toMatchObject({ live: 2, threads: 2 });
    await idle.close();
    expect(idle.stats()).toMatchObject({ live: 0, retired: 0, threads: 0 });

    const busy = track(new ReadPool());
    await Promise.all([busy.all(quick()), busy.all(quick())]);
    const reads = [busy.all(spinFor(1000)), busy.all(spinFor(1000)), busy.all(quick())];
    expect(busy.stats()).toMatchObject({ busy: 2, queued: 1 });
    await busy.close();
    const settled = await Promise.allSettled(reads);
    for (const outcome of settled) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { code: JsonRpcErrorCode.ServiceUnavailable },
      });
    }
    expect(busy.stats()).toMatchObject({ busy: 0, live: 0, queued: 0, retired: 2 });
    await expect(busy.all(quick())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringMatching(/closed/),
    });
  }, 30_000);
});

describe('FaostatMirror reads on the pool', () => {
  let domainDir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    domainDir = mkdtempSync(join(tmpdir(), 'faostat-off-thread-mirror-'));
    const zip = buildDomainZip();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 64)),
    );
    mirror = new FaostatMirror({ dir: domainDir, domains: [FIXTURE_DOMAIN] });
  });

  afterEach(async () => {
    await mirror.close();
    rmSync(domainDir, { recursive: true, force: true });
  });

  async function sync(): Promise<void> {
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
  }

  const all = { includeAggregates: true };
  const readPaths: [string, (m: FaostatMirror, signal: AbortSignal) => Promise<unknown>][] = [
    [
      'queryObservations',
      (m, s) => m.queryObservations(FIXTURE_DOMAIN, { ...all, limit: 10, offset: 0 }, s),
    ],
    [
      'streamObservations',
      async (m, s) => {
        const rows: unknown[] = [];
        for await (const row of m.streamObservations(FIXTURE_DOMAIN, all, 10, s)) rows.push(row);
        return rows;
      },
    ],
    ['rankAreaTotals', (m, s) => m.rankAreaTotals(FIXTURE_DOMAIN, all, 5, s)],
    ['sumByYear', (m, s) => m.sumByYear(FIXTURE_DOMAIN, all, s)],
    [
      'domainDimensionCodes (via resolve)',
      (m, s) => m.resolve(FIXTURE_DOMAIN, 'item', { limit: 10, signal: s }),
    ],
  ];

  it.each(readPaths)(
    '%s rejects with RequestCancelled under an aborted signal',
    async (_name, read) => {
      await sync();
      await expect(read(mirror, AbortSignal.abort())).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
      });
    },
  );

  it.each(readPaths)('%s answers under a live readSignal()', async (_name, read) => {
    await sync();
    const result = await read(mirror, mirror.readSignal(new AbortController().signal));
    expect(result).toBeDefined();
  });

  it('answers each read path with the rows it returned on the main thread', async () => {
    await sync();
    const signal = mirror.readSignal();
    const page = await mirror.queryObservations(
      FIXTURE_DOMAIN,
      { areaCodes: [2], includeAggregates: false, limit: 10, offset: 0 },
      signal,
    );
    expect(page).toMatchObject({ total: 2, totalIsExact: true });
    expect(page.rows.map(({ year, value, flag }) => ({ year, value, flag }))).toEqual([
      { year: 2020, value: 5000, flag: 'A' },
      { year: 2021, value: 5200, flag: 'E' },
    ]);
    const trend = await mirror.sumByYear(FIXTURE_DOMAIN, { includeAggregates: false }, signal);
    expect(trend).toEqual([
      { year: 2020, unit: 't', value: 5000, observations: 1, flags: 'A' },
      { year: 2021, unit: 't', value: 5200, observations: 1, flags: 'E' },
    ]);
    const resolved = await mirror.resolve(FIXTURE_DOMAIN, 'item', {
      query: 'wheat',
      limit: 5,
      signal,
    });
    expect(resolved.matches.map((m) => m.code)).toEqual([15]);
  });

  it('invalidates the worker handles on a domain file after a successful ANALYZE', async () => {
    const invalidate = vi.spyOn(mirror.reads, 'invalidate');
    await sync();
    expect(invalidate).toHaveBeenCalledWith(join(domainDir, `domain-${FIXTURE_DOMAIN}.db`));
  });

  it('closes the read pool with the mirror', async () => {
    await sync();
    await mirror.queryObservations(FIXTURE_DOMAIN, { ...all, limit: 10, offset: 0 });
    expect(mirror.reads.stats().live).toBe(1);
    await mirror.close();
    expect(mirror.reads.stats()).toMatchObject({ live: 0, threads: 0 });
    await expect(
      mirror.queryObservations(FIXTURE_DOMAIN, { ...all, limit: 10, offset: 0 }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });
});

describe('tool calls on the pool', () => {
  let domainDir: string;
  let mirror: FaostatMirror;

  /**
   * Sync a domain of `countryCount` country rows, then register a fresh singleton
   * mirror on it, as a server starts against a synced volume. Its pool starts cold:
   * the sync's statistics build ran on the syncing instance's workers.
   */
  async function syncMirror(countryCount: number, queryCeilingMs?: number): Promise<void> {
    const { zip } = buildMidSizeDomainZip({ countryCount });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    const syncing = new FaostatMirror({ dir: domainDir, domains: [FIXTURE_DOMAIN] });
    await syncing.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
    await syncing.close();
    mirror = initFaostatMirror({
      dir: domainDir,
      domains: [FIXTURE_DOMAIN],
      ...(queryCeilingMs !== undefined ? { queryCeilingMs } : {}),
    });
  }

  /** Split a failed call's two surfaces. */
  function failure(wire: Awaited<ReturnType<typeof runToolContract>>) {
    expect(wire.isError).toBe(true);
    const { error } = wire.structuredContent as {
      error: { code: number; data: Record<string, unknown>; message: string };
    };
    return { error, text: wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') };
  }

  /** The recovery a tool declares for `query_timeout`. */
  function declaredRecovery(tool: AnyToolDefinition): string {
    const entry = tool.errors?.find((e) => e.reason === 'query_timeout');
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.Timeout, retryable: true });
    return (entry as { recovery: string }).recovery;
  }

  beforeEach(() => {
    domainDir = mkdtempSync(join(tmpdir(), 'faostat-off-thread-tools-'));
  });

  afterEach(async () => {
    await mirror.close();
    rmSync(domainDir, { recursive: true, force: true });
  });

  it.each([
    ['faostat_query_observations', queryObservationsTool, { domain: FIXTURE_DOMAIN }],
    ['faostat_commodity_profile', commodityProfileTool, { item_query: 'wheat' }],
    ['faostat_resolve_codes', resolveCodesTool, { domain: FIXTURE_DOMAIN, dimension: 'item' }],
  ] as [string, AnyToolDefinition, Record<string, unknown>][])(
    '%s fails with the declared, retryable query_timeout once the call ceiling passes',
    async (_name, tool, input) => {
      // A 1 ms ceiling fires long before a cold worker can load and answer.
      await syncMirror(5, 1);
      const { error, text } = failure(await runToolContract(tool, input));
      const recovery = declaredRecovery(tool);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'query_timeout', retryable: true, recovery: { hint: recovery } },
      });
      expect(text).toContain(recovery);
      expect(text).toContain('query_timeout');
    },
  );

  it("answers a domain's first data read without spending its ceiling on the statistics build (#24)", async () => {
    // A domain without `sqlite_stat1` (synced before statistics shipped, or whose
    // last build failed), in a fresh process. Its first data read used to run
    // ANALYZE on the main thread inside the call's ceiling — minutes on TCL, past the
    // 45 s query_timeout. A held write lock keeps the build waiting in its busy
    // handler for longer than this call's 2 s ceiling.
    await syncMirror(120, 2_000);
    const file = join(domainDir, `domain-${FIXTURE_DOMAIN}.db`);
    const domain = mirror.getMirror(FIXTURE_DOMAIN);
    if (!domain) throw new Error('mirror not found');
    // Opening the handle also runs the store DDL, which needs the lock taken below.
    (await domain.raw()).exec('DROP TABLE sqlite_stat1');

    const holder = await openSqliteHandle(file);
    holder.exec('BEGIN IMMEDIATE');
    let wire: Awaited<ReturnType<typeof runToolContract>>;
    try {
      wire = await runToolContract(
        commodityProfileTool,
        { item_query: 'wheat' },
        { context: { tenantId: 'off-thread-cold-first-read' } },
      );
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(wire.isError).toBeFalsy();
    const profile = wire.structuredContent as { resolved_items: { code: number }[] };
    expect(profile.resolved_items.map((item) => item.code)).toEqual([15]);

    // The build it scheduled lands once the lock clears.
    const probe = await openSqliteHandle(file);
    await vi.waitFor(
      () =>
        expect(
          probe
            .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`)
            .get(),
        ).toBeDefined(),
      { timeout: 10_000, interval: 20 },
    );
    probe.close();
  }, 30_000);

  it.each([
    ['the overflow probe', 1],
    ['the staging stream', 2],
  ])(
    'settles a cancellation during %s as RequestCancelled, never a degraded success',
    async (_name, cancelOnRead) => {
      await syncMirror(120);
      const controller = new AbortController();
      const all = mirror.reads.all.bind(mirror.reads);
      let reads = 0;
      vi.spyOn(mirror.reads, 'all').mockImplementation((job, signal) => {
        const pending = all(job, signal);
        if (++reads === cancelOnRead) controller.abort();
        return pending;
      });
      const wire = await runToolContract(
        queryObservationsTool,
        { domain: FIXTURE_DOMAIN },
        { context: { tenantId: 'off-thread-cancel', signal: controller.signal } },
      );
      expect(reads).toBe(cancelOnRead);
      expect(failure(wire).error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    },
  );

  it('fails the call when the staging stream read times out, instead of falling back to an inline page', async () => {
    await syncMirror(120);
    const all = mirror.reads.all.bind(mirror.reads);
    let reads = 0;
    // The probe answers; the stream behind the spill runs out of ceiling.
    vi.spyOn(mirror.reads, 'all').mockImplementation((job, signal) =>
      ++reads === 2 ? all(job, timedOut()) : all(job, signal),
    );
    const { error, text } = failure(
      await runToolContract(
        queryObservationsTool,
        { domain: FIXTURE_DOMAIN },
        { context: { tenantId: 'off-thread-stream-timeout' } },
      ),
    );
    expect(reads).toBe(2);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'query_timeout', retryable: true },
    });
    expect(text).toContain(declaredRecovery(queryObservationsTool));
    expect(text).not.toMatch(/inline page/);
  });
});

describe('stageObservations with a failing source stream', () => {
  /** One staged-shape observation row. */
  function observation(areaCode: number): Record<string, unknown> {
    return {
      area_code: areaCode,
      area: `Country ${areaCode}`,
      item_code: 15,
      item: 'Wheat',
      element_code: 5510,
      element: 'Production',
      year: 2020,
      unit: 't',
      value: 1000 + areaCode,
      flag: 'A',
    };
  }

  it('rethrows a mirror-read failure the source raised instead of degrading to an inline page', async () => {
    const failure = timeout('Mirror reads for this call ran past the ceiling.', {
      reason: 'query_timeout',
      retryable: true,
    });
    async function* source() {
      yield observation(1);
      yield observation(2);
      throw failure;
    }
    const ctx = createMockContext({ tenantId: 'staging-rethrow' });
    await expect(
      stageObservations(ctx, source(), {
        sourceTool: 'faostat_query_observations',
        queryParams: {},
        schema: OBSERVATION_TABLE_SCHEMA,
      }),
    ).rejects.toBe(failure);
  });

  it('still degrades when the canvas fails and the source is healthy', async () => {
    vi.spyOn(CanvasInstance.prototype, 'registerTable').mockRejectedValueOnce(
      new Error('simulated registerTable failure'),
    );
    async function* source() {
      yield observation(1);
      yield observation(2);
    }
    const ctx = createMockContext({ tenantId: 'staging-degrade' });
    const staged = await stageObservations(ctx, source(), {
      sourceTool: 'faostat_query_observations',
      queryParams: {},
      schema: OBSERVATION_TABLE_SCHEMA,
      previewLimit: 1,
    });
    expect(staged).toBeUndefined();
  });
});
