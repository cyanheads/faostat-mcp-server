/**
 * @fileoverview Index + overflow-probe regression for the event-loop-blocking
 * query path (#3). Syncs a mid-size synthetic domain, then asserts (a) the
 * element/year-filtered `ORDER BY year` shapes are served by a composite index
 * rather than a full materialize-and-sort — confirmed via `EXPLAIN QUERY PLAN` on
 * the statement `buildObservationSql` builds (no "USE TEMP B-TREE FOR ORDER BY"),
 * and (b) a broad query stays bounded and correct through the LIMIT-probe path
 * that replaced the per-call `COUNT(*)`. The third suite pins the item-filtered
 * shape (#33): it seeks the item composite and sorts only its match. The fourth
 * pins the ranking's single read of its match (#59) under every statistics state.
 *
 * Declaring those indexes is not enough on its own: without `sqlite_stat1` the
 * cost-based optimizer cannot compare them and picks the less selective one for
 * the item+element filter shape the aggregation paths use — measured on the real
 * mirror as seconds per query instead of milliseconds. The second suite here
 * covers the statistics lifecycle that fixes it. A data read that finds them
 * missing or not covering an index schedules one background build on the read pool and answers without waiting
 * for it (#24), a failed build is retried by a later read within a fixed budget
 * (#21) while a build the pool's shutdown ends is neither warned about nor
 * counted (#46), the dimension-code discovery read never schedules one (#22), a sync
 * rebuilds them when it applied rows or finds them missing or not covering an
 * index, and a build and a sync of the same domain never overlap.
 * @module tests/services/faostat-mirror-index
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  openSqliteHandle,
  type SqliteHandle,
  type SqlValue,
  type SyncResult,
} from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildObservationSql,
  FaostatMirror,
  type ObservationQuery,
  type ObservationRead,
} from '@/services/faostat-mirror/faostat-mirror.js';
import {
  buildExplicitDomainZip,
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

type ObservationFilters = Omit<ObservationQuery, 'limit' | 'offset'>;

/** Run EXPLAIN QUERY PLAN and flatten the plan into one detail string. */
function queryPlan(handle: SqliteHandle, sql: string, params: SqlValue[]): string {
  const rows = handle.prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return rows.map((r) => r.detail).join(' | ');
}

/** The plan of the statement a read path prepares for `filters` + `read`, params bound. */
function readPlan(handle: SqliteHandle, filters: ObservationFilters, read: ObservationRead) {
  const { sql, params } = buildObservationSql(FIXTURE_DOMAIN, filters, read);
  return queryPlan(handle, sql, params);
}

describe('FaostatMirror index + overflow probe (#3)', () => {
  let dir: string;
  let mirror: FaostatMirror;
  const COUNTRIES = 400;
  const YEARS = 12;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-index-'));
    // ~5k country rows (400 × 12) + a few aggregates — enough that the planner
    // prefers an index over a full scan + sort for the ORDER BY year + LIMIT shape.
    const { zip } = buildMidSizeDomainZip({
      countryCount: COUNTRIES,
      aggregateCount: 20,
      years: YEARS,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
  }, 30_000);

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the composite indexes on the domain table', async () => {
    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const names = handle
      .prepare<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? ORDER BY name`,
      )
      .all(`obs_${FIXTURE_DOMAIN}`)
      .map((r) => r.name);
    expect(names).toContain(`obs_${FIXTURE_DOMAIN}_element_code_year_idx`);
    expect(names).toContain(`obs_${FIXTURE_DOMAIN}_item_code_element_code_year_idx`);
  });

  it('keeps multi-area reads globally ordered by year', async () => {
    const result = await mirror.queryObservations(FIXTURE_DOMAIN, {
      areaCodes: [1, 2],
      includeAggregates: false,
      limit: 100,
      offset: 0,
    });
    expect(result.rows).toHaveLength(YEARS * 2);
    expect(result.rows.map((row) => row.year)).toEqual(
      result.rows.map((row) => row.year).sort((a, b) => a - b),
    );
  });

  it('serves a single-area page without sorting its full match (#34)', async () => {
    const handle = await mirror.getMirror(FIXTURE_DOMAIN)!.raw();
    const detail = readPlan(
      handle,
      { areaCodes: [1], includeAggregates: false },
      { kind: 'page', limit: 2, offset: 0 },
    );
    expect(detail).toMatch(/USING INDEX obs_QCL_area_code_year_idx/);
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('serves the element-filter + ORDER BY year shape from an index, no temp-b-tree sort', async () => {
    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    // The issue's repro shape: element-only filter, aggregate-excluded, sorted by
    // year with a LIMIT (the overflow probe). The (element_code, year) index must
    // satisfy both the seek and the sort so the LIMIT bounds the scan.
    const detail = readPlan(
      handle,
      { elementCodes: [5510], includeAggregates: false },
      { kind: 'page', limit: 51, offset: 0 },
    );
    expect(detail).toMatch(/USING INDEX obs_QCL_element_code_year_idx/);
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('serves the streamObservations spill shape from an index, no temp-b-tree sort', async () => {
    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const detail = readPlan(
      handle,
      { elementCodes: [5510], includeAggregates: false },
      { kind: 'stream', limit: 50_001 },
    );
    expect(detail).toMatch(/USING INDEX obs_QCL_element_code_year_idx/);
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('sorts the commodity item+element match instead of walking an index in year order (#33)', async () => {
    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    // An item filter bounds the match, so the read sorts the matched rows. Every
    // row in this fixture is item 15, so the planner rightly scans rather than
    // seeks; the item-composite seek under real-mirror statistics is pinned in the
    // multi-item suite below.
    const detail = readPlan(
      handle,
      { itemCodes: [15], elementCodes: [5510], includeAggregates: false },
      { kind: 'page', limit: 51, offset: 0 },
    );
    expect(detail).not.toMatch(/obs_QCL_element_code_year_idx/);
    expect(detail).toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('bounds a broad query via the LIMIT probe and reports an inexact floor', async () => {
    // A broad element-only match spans all COUNTRIES × YEARS country rows. The probe
    // fetches limit+1, caps rows at limit, and marks the total a floor (not exact).
    const res = await mirror.queryObservations(FIXTURE_DOMAIN, {
      elementCodes: [5510],
      includeAggregates: false,
      limit: 50,
      offset: 0,
    });
    expect(res.totalIsExact).toBe(false);
    expect(res.total).toBe(50);
    expect(res.rows).toHaveLength(50);
    expect(res.rows.every((r) => r.area_code < 5000)).toBe(true);
  });

  it('reports an exact total when the match drains under the limit', async () => {
    // One country's rows across YEARS years — well under the limit → exact count.
    const res = await mirror.queryObservations(FIXTURE_DOMAIN, {
      areaCodes: [1],
      includeAggregates: false,
      limit: 1000,
      offset: 0,
    });
    expect(res.totalIsExact).toBe(true);
    expect(res.total).toBe(YEARS);
    expect(res.rows).toHaveLength(YEARS);
  });

  it('counts a match exactly up to the cap and reads one row past it, never the rest (#52)', async () => {
    // One country: YEARS (12) rows.
    const oneArea = { areaCodes: [1], includeAggregates: false };
    expect(await mirror.countObservations(FIXTURE_DOMAIN, oneArea, 100)).toBe(12);
    // At the cap the count is still exact.
    expect(await mirror.countObservations(FIXTURE_DOMAIN, oneArea, 12)).toBe(12);
    // One past the cap reads as cap + 1: more than the cap matched.
    expect(await mirror.countObservations(FIXTURE_DOMAIN, oneArea, 11)).toBe(12);
    // Far past it, the count stops at cap + 1 rather than reading all 12.
    expect(await mirror.countObservations(FIXTURE_DOMAIN, oneArea, 4)).toBe(5);
    // The read paths' filters, aggregate exclusion included: 400 countries minus
    // the six curated roll-ups among codes 1–400 (261, 265, 266, 268, 269, 351).
    expect(
      await mirror.countObservations(
        FIXTURE_DOMAIN,
        { elementCodes: [5510], includeAggregates: false },
        10_000,
      ),
    ).toBe(394 * YEARS);
    expect(
      await mirror.countObservations(
        FIXTURE_DOMAIN,
        { elementCodes: [5510], includeAggregates: true },
        10_000,
      ),
    ).toBe(420 * YEARS);
    expect(
      await mirror.countObservations(
        FIXTURE_DOMAIN,
        { yearStart: 1900, yearEnd: 1901, includeAggregates: true },
        10,
      ),
    ).toBe(0);
  });
});

describe('FaostatMirror query-planner statistics (#3, #24)', () => {
  const TABLE = `obs_${FIXTURE_DOMAIN}`;
  let dir: string;
  let mirror: FaostatMirror;
  /** Statistics-build outcomes the current mirror logged, oldest first. */
  let outcomes: ('built' | 'failed')[];
  /** Every `warning` record the current mirror logged, oldest first. */
  let warnings: string[];

  /** A mirror on `dir` whose log records each statistics-build outcome and every warning. */
  function openMirror(queryCeilingMs?: number): FaostatMirror {
    outcomes = [];
    warnings = [];
    return new FaostatMirror({
      dir,
      domains: [FIXTURE_DOMAIN],
      ...(queryCeilingMs !== undefined ? { queryCeilingMs } : {}),
      log: {
        info: (message) => {
          if (message.startsWith('Query-planner statistics updated')) outcomes.push('built');
        },
        warning: (message) => {
          warnings.push(message);
          if (message.startsWith('Could not ANALYZE')) outcomes.push('failed');
        },
      },
    });
  }

  /** Sync the fixture domain into `target`: `init`, or a `refresh` against `dateUpdate`. */
  function syncInto(target: FaostatMirror, dateUpdate?: string): Promise<SyncResult> {
    return target.runDomainSync(FIXTURE_DOMAIN, dateUpdate ? 'refresh' : 'init', {
      signal: new AbortController().signal,
      dataset: dateUpdate ? { ...fixtureDataset(), DateUpdate: dateUpdate } : fixtureDataset(),
    });
  }

  /** The fixture's own `DateUpdate` — a refresh against it applies nothing. */
  const UNCHANGED = fixtureDataset().DateUpdate;
  /** A later `DateUpdate` — a refresh against it rebuilds the domain. */
  const REBUILT = '2026-06-01T00:00:00';

  /** The `sqlite_stat1` rows SQLite holds for the cube table — empty when never analyzed. */
  async function statRows(target: FaostatMirror): Promise<{ idx: string | null; stat: string }[]> {
    const m = target.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const present = handle
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'`)
      .get();
    if (!present) return [];
    return handle
      .prepare<{ idx: string | null; stat: string }>(
        `SELECT idx, stat FROM sqlite_stat1 WHERE tbl = ?`,
      )
      .all(TABLE);
  }

  /**
   * Drop the statistics table outright — the state of a mirror synced before any
   * ANALYZE existed. (Dropping rather than emptying it: that is what an inherited
   * `.db` actually looks like, and it is the state the guard reads.)
   */
  async function clearStatistics(target: FaostatMirror): Promise<void> {
    const m = target.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    const handle = await m.raw();
    const present = handle
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'`)
      .get();
    if (present) handle.exec('DROP TABLE sqlite_stat1');
  }

  /**
   * The state an inherited mirror is in: rows synced, statistics dropped, and a
   * fresh instance so the in-process memo starts empty. Replaces the suite's
   * `mirror` binding so `afterEach` still closes the live one.
   */
  async function reopenWithoutStatistics(queryCeilingMs?: number): Promise<FaostatMirror> {
    await clearStatistics(mirror);
    await mirror.close();
    mirror = openMirror(queryCeilingMs);
    return mirror;
  }

  /**
   * Wait for a background build to settle as built — its statistics commit on the
   * worker before the reply reaches the main thread — then confirm them on disk.
   */
  async function statisticsLand(target: FaostatMirror): Promise<void> {
    await vi.waitFor(() => expect(outcomes).toContain('built'), { timeout: 10_000, interval: 20 });
    expect((await statRows(target)).length).toBeGreaterThan(0);
  }

  /** A filtering read — the shape the statistics serve, so it opens through the gate. */
  function readCube(target: FaostatMirror, signal?: AbortSignal) {
    return target.queryObservations(
      FIXTURE_DOMAIN,
      { itemCodes: [15], elementCodes: [5510], includeAggregates: false, limit: 10, offset: 0 },
      signal,
    );
  }

  /**
   * Take the domain file's write lock from a separate connection, as a concurrent
   * writer would. `ANALYZE` needs that lock for its whole run, so a build that starts
   * meanwhile waits in its busy handler — up to the handle's 5 s `busy_timeout` —
   * while WAL readers carry on. Returns the release.
   */
  async function holdWriteLock(): Promise<() => void> {
    const holder = await openSqliteHandle(join(dir, `domain-${FIXTURE_DOMAIN}.db`));
    holder.exec('BEGIN IMMEDIATE');
    return () => {
      holder.exec('ROLLBACK');
      holder.close();
    };
  }

  /** Track the longest main-thread stall between 5 ms ticks; `stop()` returns it. */
  function heartbeat(): { stop: () => number } {
    let last = performance.now();
    let maxGap = 0;
    const beat = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    return {
      stop: () => {
        clearInterval(beat);
        return Math.max(maxGap, performance.now() - last);
      },
    };
  }

  /** Let a settled build's bookkeeping run — its promise chain is microtasks only. */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  /**
   * Make each statistics build fail with `error` until `clear()` — by default the
   * driver's lock error, standing in for a writer that holds the lock past
   * `busy_timeout`. Wraps the pool's `analyze` rather than replacing it, so a build
   * after `clear()` runs the real worker `ANALYZE`.
   */
  function obstructBuilds(
    target: FaostatMirror,
    error: Error = new Error('database is locked'),
  ): { attempts: () => number; clear: () => void } {
    const analyze = target.reads.analyze.bind(target.reads);
    let attempts = 0;
    let obstructed = true;
    vi.spyOn(target.reads, 'analyze').mockImplementation((file, table, areaYearIndex) => {
      attempts += 1;
      return obstructed ? Promise.reject(error) : analyze(file, table, areaYearIndex);
    });
    return {
      attempts: () => attempts,
      clear: () => {
        obstructed = false;
      },
    };
  }

  /** Record, in `events`, when the domain's framework sync starts and ends. */
  function traceSync(target: FaostatMirror, events: string[]): void {
    const domain = target.getMirror(FIXTURE_DOMAIN);
    if (!domain) throw new Error('mirror not found');
    const runSync = domain.runSync.bind(domain);
    vi.spyOn(domain, 'runSync').mockImplementation(async (options) => {
      events.push('sync start');
      const result = await runSync(options);
      events.push('sync end');
      return result;
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-stats-'));
    const { zip } = buildMidSizeDomainZip({ countryCount: 60, aggregateCount: 4, years: 2 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = openMirror();
    await syncInto(mirror);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records statistics for the cube table once a sync has applied rows', async () => {
    const rows = await statRows(mirror);
    expect(rows.length).toBeGreaterThan(0);
    // The composite index whose selection the planner gets wrong without stats.
    expect(rows.map((r) => r.idx)).toContain(`${TABLE}_item_code_element_code_year_idx`);
    // Full indexes cover 128 rows. Nullable identity/source partial indexes cover
    // none in this numeric, source-less fixture (SQLite records `0 0` for them).
    const emptyIndexes = new Set([
      `${TABLE}_item_code_text_idx`,
      `${TABLE}_item_code_text_element_code_year_idx`,
      `${TABLE}_source_code_idx`,
    ]);
    for (const row of rows)
      expect(row.stat.split(' ')[0]).toBe(
        row.idx !== null && emptyIndexes.has(row.idx) ? '0' : '128',
      );
  });

  it('upgrades an existing analyzed mirror in the background without re-sync (#34)', async () => {
    const handle = await mirror.getMirror(FIXTURE_DOMAIN)!.raw();
    handle.exec(`DROP INDEX IF EXISTS ${TABLE}_area_code_year_idx`);
    expect((await statRows(mirror)).length).toBeGreaterThan(0);
    await mirror.close();
    mirror = openMirror();
    const reopenedHandle = await mirror.getMirror(FIXTURE_DOMAIN)!.raw();
    expect(
      reopenedHandle
        .prepare(`SELECT name FROM sqlite_master WHERE name = ?`)
        .all(`${TABLE}_area_code_year_idx`),
    ).toEqual([]);
    const analyze = vi.spyOn(mirror.reads, 'analyze');
    const invalidate = vi.spyOn(mirror.reads, 'invalidate');
    const release = await holdWriteLock();
    const beat = heartbeat();
    try {
      expect((await readCube(mirror)).rows.length).toBeGreaterThan(0);
      expect(outcomes).toEqual([]);
      expect(analyze).toHaveBeenCalledWith(join(dir, `domain-${FIXTURE_DOMAIN}.db`), TABLE, true);
      expect(mirror.reads.stats().building).toBe(1);
      expect(beat.stop()).toBeLessThan(500);
    } finally {
      beat.stop();
      release();
    }
    await statisticsLand(mirror);
    expect((await statRows(mirror)).map((row) => row.idx)).toContain(`${TABLE}_area_code_year_idx`);
    expect(invalidate).toHaveBeenCalledWith(join(dir, `domain-${FIXTURE_DOMAIN}.db`));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('answers the first data read of a domain without statistics without waiting for the build (#24)', async () => {
    // An already-synced .db from a deployment that predates statistics, or whose
    // last build failed: indexes present, `sqlite_stat1` absent. The first data read
    // must not wait out the build — seconds on QCL, minutes on TCL — and the main
    // thread must keep serving (/healthz, other calls) while it runs. A held write
    // lock keeps the build waiting in its busy handler for the whole measurement.
    const reopened = await reopenWithoutStatistics(2_000);
    const invalidate = vi.spyOn(reopened.reads, 'invalidate');
    // Opens the mirror's own handle (its store DDL needs the write lock) first.
    expect(await statRows(reopened)).toHaveLength(0);
    const release = await holdWriteLock();
    let maxGap: number;
    let rows: number;
    try {
      const beat = heartbeat();
      rows = (await readCube(reopened, reopened.readSignal())).rows.length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      maxGap = beat.stop();
      // The read has answered; the build it scheduled is still waiting on the lock.
      expect(await statRows(reopened)).toHaveLength(0);
      expect(outcomes).toEqual([]);
    } finally {
      release();
    }
    expect(rows).toBeGreaterThan(0);
    expect(maxGap).toBeLessThan(1_000);

    await statisticsLand(reopened);
    expect(outcomes).toEqual(['built']);
    // Workers reopen their handles, so later reads plan from the new statistics.
    expect(invalidate).toHaveBeenCalledWith(join(dir, `domain-${FIXTURE_DOMAIN}.db`));
  }, 30_000);

  it('builds once for a domain however many reads arrive while the build runs (#24)', async () => {
    const reopened = await reopenWithoutStatistics();
    expect(await statRows(reopened)).toHaveLength(0);
    const release = await holdWriteLock();
    try {
      const answered = await Promise.all(Array.from({ length: 8 }, () => readCube(reopened)));
      expect(answered.every((res) => res.rows.length > 0)).toBe(true);
    } finally {
      release();
    }
    await statisticsLand(reopened);
    for (let i = 0; i < 4; i++) await readCube(reopened);
    await flush();
    expect(outcomes).toEqual(['built']);
  }, 60_000);

  it('retries a failed build on a later data read, memoizing only success (#21)', async () => {
    // The failure the memo used to swallow: an attempt that never ran to completion
    // was remembered as success, so the domain kept the uninformed plan for the rest
    // of the process even after the contention that caused it had gone.
    const reopened = await reopenWithoutStatistics();
    const builds = obstructBuilds(reopened);

    await readCube(reopened);
    await flush();
    expect(builds.attempts()).toBe(1);
    expect(outcomes).toEqual(['failed']);
    expect(await statRows(reopened)).toHaveLength(0);

    builds.clear();
    await readCube(reopened);
    await statisticsLand(reopened);
    expect(builds.attempts()).toBe(2);
    expect(outcomes).toEqual(['failed', 'built']);

    // Success settles the domain: later reads schedule nothing.
    await readCube(reopened);
    await flush();
    expect(builds.attempts()).toBe(2);
  });

  it('stops scheduling builds once the retry budget is spent (#21)', async () => {
    // The other half: an obstruction that never clears (a read-only volume) must not
    // buy an ANALYZE — seconds to a minute on a real domain — on every single query.
    const reopened = await reopenWithoutStatistics();
    const builds = obstructBuilds(reopened);

    for (let i = 0; i < 8; i++) {
      await readCube(reopened);
      await flush();
    }
    // Pinned, not bounded: a loose range still passes if the budget regresses to 2
    // or 5, and the budget is the whole point of this test.
    expect(builds.attempts()).toBe(3);

    for (let i = 0; i < 4; i++) {
      await readCube(reopened);
      await flush();
    }
    expect(builds.attempts()).toBe(3);
    expect(outcomes).toEqual(['failed', 'failed', 'failed']);
    expect(await statRows(reopened)).toHaveLength(0);
    // The cap is recorded once, so the degraded plan does not persist silently (#46).
    expect(warnings.filter((message) => message.startsWith('ANALYZE failed'))).toEqual([
      `ANALYZE failed 3 times for ${FIXTURE_DOMAIN} — reads stop retrying it this process (a sync will try again); its queries keep the planner's uninformed index choice`,
    ]);
  });

  it('counts a build whose worker died toward the budget, as it does a driver error (#46)', async () => {
    // Shutdown is told apart by the pool's own reason, never by the ServiceUnavailable
    // code a worker that died mid-build also rejects with.
    const reopened = await reopenWithoutStatistics();
    const builds = obstructBuilds(
      reopened,
      serviceUnavailable('The mirror read worker exited (code 1) before the job returned.', {
        retryable: true,
      }),
    );
    for (let i = 0; i < 4; i++) {
      await readCube(reopened);
      await flush();
    }
    expect(builds.attempts()).toBe(3);
    expect(outcomes).toEqual(['failed', 'failed', 'failed']);
    expect(warnings.filter((message) => message.startsWith('ANALYZE failed'))).toHaveLength(1);
  });

  /**
   * Spend two of the domain's three ANALYZE attempts on driver failures, then let
   * builds through to the real worker — so a shutdown-ended third build that were
   * counted would reach the cap and log the budget warning. Returns the attempt count.
   */
  async function twoFailedBuilds(target: FaostatMirror): Promise<() => number> {
    const builds = obstructBuilds(target);
    for (let i = 0; i < 2; i++) {
      await readCube(target);
      await flush();
    }
    builds.clear();
    expect(outcomes).toEqual(['failed', 'failed']);
    return builds.attempts;
  }

  /** Wait out the worker a close retired mid-build, once the lock it waits on is released. */
  async function retiredWorkersExit(target: FaostatMirror): Promise<void> {
    await vi.waitFor(() => expect(target.reads.stats().retired).toBe(0), {
      timeout: 20_000,
      interval: 50,
    });
  }

  it.each([
    {
      state: 'queued behind another build',
      /**
       * A build of the same file started on the pool directly takes the one build
       * slot and waits on the lock, so the mirror's own build queues behind it.
       */
      start: async (target: FaostatMirror) => {
        const blocker = target.reads
          .analyze(join(dir, `domain-${FIXTURE_DOMAIN}.db`), TABLE)
          .catch((error: unknown) => error);
        await readCube(target);
        expect(target.reads.stats()).toMatchObject({ building: 1, queued: 1 });
        return [blocker];
      },
    },
    {
      state: 'running',
      start: async (target: FaostatMirror) => {
        await readCube(target);
        expect(target.reads.stats()).toMatchObject({ building: 1, queued: 0 });
        return [];
      },
    },
  ])(
    'ends a build $state when the mirror closes without a warning or a failed attempt (#46)',
    async ({ start }) => {
      const reopened = await reopenWithoutStatistics();
      await twoFailedBuilds(reopened);
      const before = [...warnings];
      const release = await holdWriteLock();
      let others: Promise<unknown>[];
      try {
        others = await start(reopened);
        await reopened.close();
      } finally {
        release();
      }
      await Promise.all(others);
      await flush();
      expect(warnings).toEqual(before);
      expect(outcomes).toEqual(['failed', 'failed']);
      await retiredWorkersExit(reopened);
    },
    30_000,
  );

  it('ends a build requested after the mirror closed without a warning or a failed attempt (#46)', async () => {
    const reopened = await reopenWithoutStatistics();
    const attempts = await twoFailedBuilds(reopened);
    const before = [...warnings];
    await reopened.close();
    // The read reopens the domain handle, finds no statistics, and requests a build
    // of the closed pool; the read itself is refused by that pool.
    await expect(readCube(reopened)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    await flush();
    expect(attempts()).toBe(3);
    expect(warnings).toEqual(before);
    expect(outcomes).toEqual(['failed', 'failed']);
  });

  it('never schedules a build for a dimension-code discovery read, only for a data read (#22)', async () => {
    // resolve_codes reads distinct dimension codes off the single-column index — a
    // shape the statistics do nothing for — and is the call an agent makes first.
    const reopened = await reopenWithoutStatistics();
    const analyze = vi.spyOn(reopened.reads, 'analyze');

    const resolved = await reopened.resolve(FIXTURE_DOMAIN, 'item', { limit: 10 });
    expect(resolved.matches.length).toBeGreaterThan(0);
    await flush();
    expect(analyze).not.toHaveBeenCalled();
    expect(await statRows(reopened)).toHaveLength(0);

    await readCube(reopened);
    expect(analyze).toHaveBeenCalledTimes(1);
    await statisticsLand(reopened);
  });

  it('builds statistics on a sync that applied no rows when the domain has none (#24)', async () => {
    // A legacy mirror unchanged upstream: the ingester short-circuits on the
    // checkpoint, so only a pass keyed on the missing statistics catches it up —
    // `mirror:refresh` is the out-of-band way to warm such a domain.
    await clearStatistics(mirror);
    outcomes.length = 0;

    const unchanged = await syncInto(mirror, UNCHANGED);
    expect(unchanged.recordsApplied).toBe(0);
    expect((await statRows(mirror)).length).toBeGreaterThan(0);
    expect(outcomes).toEqual(['built']);
  }, 30_000);

  it('skips the pass on a sync that applied no rows when statistics exist, and rebuilds after one that did', async () => {
    outcomes.length = 0;
    // The nightly no-op refresh stays a no-op.
    const unchanged = await syncInto(mirror, UNCHANGED);
    expect(unchanged.recordsApplied).toBe(0);
    expect(outcomes).toEqual([]);

    // A rebuilt domain replaces the rows the old statistics described, so they are
    // recomputed rather than left describing a vintage that no longer exists.
    const rebuilt = await syncInto(mirror, REBUILT);
    expect(rebuilt.recordsApplied).toBeGreaterThan(0);
    expect(outcomes).toEqual(['built']);
    expect((await statRows(mirror)).length).toBeGreaterThan(0);
  }, 30_000);

  it('holds a sync of a domain until its in-flight build has finished (#24)', async () => {
    // ANALYZE holds the file's write lock for its whole run, so a sync page write
    // behind a build longer than busy_timeout would fail with `database is locked`.
    const reopened = await reopenWithoutStatistics();
    const events: string[] = [];
    const analyze = reopened.reads.analyze.bind(reopened.reads);
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    vi.spyOn(reopened.reads, 'analyze').mockImplementation(async (file, table, areaYearIndex) => {
      events.push('build start');
      await gate;
      const durationMs = await analyze(file, table, areaYearIndex);
      events.push('build end');
      return durationMs;
    });
    traceSync(reopened, events);

    await readCube(reopened);
    const sync = syncInto(reopened, REBUILT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual(['build start']);

    open();
    expect((await sync).recordsApplied).toBeGreaterThan(0);
    expect(events).toEqual([
      'build start',
      'build end',
      'sync start',
      'sync end',
      'build start',
      'build end',
    ]);
  }, 30_000);

  it('schedules no build from a data read while a sync of the domain runs; the sync builds after (#24)', async () => {
    const reopened = await reopenWithoutStatistics();
    const analyze = vi.spyOn(reopened.reads, 'analyze');
    const domain = reopened.getMirror(FIXTURE_DOMAIN);
    if (!domain) throw new Error('mirror not found');
    const runSync = domain.runSync.bind(domain);
    let buildsDuringSync: number | undefined;
    vi.spyOn(domain, 'runSync').mockImplementation(async (options) => {
      const result = await runSync(options);
      // Still inside the sync, against a domain without statistics.
      expect((await readCube(reopened)).rows.length).toBeGreaterThan(0);
      await flush();
      buildsDuringSync = analyze.mock.calls.length;
      return result;
    });

    const unchanged = await syncInto(reopened, UNCHANGED);
    expect(unchanged.recordsApplied).toBe(0);
    expect(buildsDuringSync).toBe(0);
    // The post-sync pass, since the domain still has no statistics.
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((await statRows(reopened)).length).toBeGreaterThan(0);
  }, 30_000);

  it('refuses a second in-process sync of a domain while one runs', async () => {
    // Two overlapping syncs would share the ingester slot and the sync marker that
    // holds builds off, so the second fails at once and the first is untouched.
    const events: string[] = [];
    traceSync(mirror, events);
    const first = syncInto(mirror, REBUILT);
    await expect(syncInto(mirror, REBUILT)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
    });
    expect((await first).recordsApplied).toBeGreaterThan(0);
    expect(events).toEqual(['sync start', 'sync end']);
  }, 30_000);

  const UNIT_ELEMENT_INDEX = `${TABLE}_unit_element_idx`;
  /** The partial indexes, empty in this numeric, source-less fixture. */
  const PARTIAL_INDEXES = [
    `${TABLE}_item_code_text_idx`,
    `${TABLE}_item_code_text_element_code_year_idx`,
    `${TABLE}_source_code_idx`,
  ];

  /** Delete the cube's `sqlite_stat1` rows for `indexes`, then reopen with an empty memo. */
  async function reopenWithoutRowsFor(indexes: string[]): Promise<FaostatMirror> {
    const handle = await mirror.getMirror(FIXTURE_DOMAIN)!.raw();
    const remove = handle.prepare('DELETE FROM sqlite_stat1 WHERE tbl = ? AND idx = ?');
    for (const index of indexes) remove.run(TABLE, index);
    await mirror.close();
    mirror = openMirror();
    return mirror;
  }

  it('ends a refresh that adds indexes to an unchanged upstream with statistics covering them', async () => {
    // A store from before those indexes, as the first data read's build left it:
    // revision 1, every other index analyzed. The upstream is unchanged, so the
    // refresh applies no rows and only an incomplete-statistics check can build.
    const handle = await mirror.getMirror(FIXTURE_DOMAIN)!.raw();
    for (const index of [UNIT_ELEMENT_INDEX, ...PARTIAL_INDEXES])
      handle.exec(`DROP INDEX ${index}`);
    handle.exec('UPDATE ingest_revision SET revision = 1');
    await mirror.close();
    mirror = openMirror();
    expect((await statRows(mirror)).map((r) => r.idx)).not.toContain(UNIT_ELEMENT_INDEX);

    const refreshed = await syncInto(mirror, UNCHANGED);
    expect(refreshed.recordsApplied).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['built']);
    expect(await statRows(mirror)).toContainEqual({
      idx: UNIT_ELEMENT_INDEX,
      stat: expect.stringMatching(/^128 /),
    });
  }, 30_000);

  it('builds statistics on the first data read when an index has none', async () => {
    const reopened = await reopenWithoutRowsFor([UNIT_ELEMENT_INDEX]);
    const analyze = vi.spyOn(reopened.reads, 'analyze');

    expect((await readCube(reopened)).rows.length).toBeGreaterThan(0);
    expect(analyze).toHaveBeenCalledTimes(1);
    await statisticsLand(reopened);
    expect((await statRows(reopened)).map((r) => r.idx)).toContain(UNIT_ELEMENT_INDEX);

    // Settled: later reads schedule nothing.
    await readCube(reopened);
    await flush();
    expect(analyze).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.each([
    ['every index analyzed', []],
    // SQLite records `0 0` for an empty partial index on the builds measured, but
    // nothing rests on it: a partial index fills only through a sync that applies
    // rows, and that sync builds.
    ['no row for its empty partial indexes', PARTIAL_INDEXES],
  ])(
    'schedules no build on a read or an unchanged refresh with %s',
    async (_state, indexes) => {
      const reopened = await reopenWithoutRowsFor(indexes);
      const analyze = vi.spyOn(reopened.reads, 'analyze');

      for (let i = 0; i < 3; i++) await readCube(reopened);
      expect((await syncInto(reopened, UNCHANGED)).recordsApplied).toBe(0);
      await flush();
      expect(analyze).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('builds once, not on every read, for an empty cube whose indexes can never get statistics', async () => {
    // ANALYZE records nothing for a full index over an empty table, so the
    // statistics stay incomplete after a build that succeeded; the success memo is
    // what keeps the next read from building again.
    const handle = await mirror.getMirror(FIXTURE_DOMAIN)!.raw();
    handle.exec(`DELETE FROM ${TABLE}`);
    const reopened = await reopenWithoutStatistics();
    const analyze = vi.spyOn(reopened.reads, 'analyze');

    await readCube(reopened);
    await vi.waitFor(() => expect(outcomes).toEqual(['built']), { timeout: 10_000, interval: 20 });
    expect((await statRows(reopened)).map((r) => r.idx)).not.toContain(`${TABLE}_item_code_idx`);
    for (let i = 0; i < 4; i++) {
      await readCube(reopened);
      await flush();
    }
    expect(analyze).toHaveBeenCalledTimes(1);
  }, 30_000);

  /** A rebuilding `refresh` of the fixture domain under `signal`. */
  function rebuildUnder(target: FaostatMirror, signal: AbortSignal): Promise<SyncResult> {
    return target.runDomainSync(FIXTURE_DOMAIN, 'refresh', {
      signal,
      dataset: { ...fixtureDataset(), DateUpdate: REBUILT },
    });
  }

  /**
   * Stand a deferred in for every statistics build `target` requests: `started`
   * resolves once one is, and the build settles only when the test settles it.
   */
  function deferBuilds(target: FaostatMirror) {
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolve: (durationMs: number) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const build = new Promise<number>((settleOk, settleFailed) => {
      resolve = settleOk;
      reject = settleFailed;
    });
    vi.spyOn(target.reads, 'analyze').mockImplementation(() => {
      markStarted();
      return build;
    });
    return { started, resolve, reject };
  }

  /** Tracks whether `promise` has settled; read it after {@link flush}. */
  function settledState(promise: Promise<unknown>): { settled: boolean } {
    const state = { settled: false };
    const mark = () => {
      state.settled = true;
    };
    promise.then(mark, mark);
    return state;
  }

  it('awaits the post-sync build of a run that is not stopped, and reports a failed build as a warning', async () => {
    outcomes.length = 0;
    const build = deferBuilds(mirror);
    const sync = syncInto(mirror, REBUILT);
    const state = settledState(sync);
    await build.started;
    await flush();
    expect(state.settled).toBe(false);

    build.reject(new Error('database is locked'));
    expect((await sync).recordsApplied).toBeGreaterThan(0);
    expect(outcomes).toEqual(['failed']);
    expect(warnings).toContain(
      `Could not ANALYZE ${TABLE} — queries fall back to the planner's uninformed index choice`,
    );
  }, 30_000);

  it('stops waiting for the post-sync build once the run is stopped, and leaves the build running', async () => {
    outcomes.length = 0;
    const build = deferBuilds(mirror);
    const controller = new AbortController();
    const sync = rebuildUnder(mirror, controller.signal);
    const state = settledState(sync);
    await build.started;

    const stopped = new Error('Stopped for shutdown');
    controller.abort(stopped);
    await flush();
    expect(state.settled).toBe(true);
    await expect(sync).rejects.toBe(stopped);
    // The sync committed before the stop; only the wait for its build was cut short.
    expect(await mirror.status(FIXTURE_DOMAIN)).toMatchObject({ status: 'complete', ready: true });
    expect(outcomes).toEqual([]);

    build.resolve(1);
    await flush();
    expect(outcomes).toEqual(['built']);
  }, 30_000);

  it('starts no post-sync build once the run is stopped, and the next process builds on its first data read', async () => {
    await clearStatistics(mirror);
    const analyze = vi.spyOn(mirror.reads, 'analyze');
    const controller = new AbortController();
    const stopped = new Error('Stopped for shutdown');
    const domain = mirror.getMirror(FIXTURE_DOMAIN);
    if (!domain) throw new Error('mirror not found');
    const runSync = domain.runSync.bind(domain);
    // The stop lands after the sync has committed, before its build would start.
    vi.spyOn(domain, 'runSync').mockImplementation(async (options) => {
      const result = await runSync(options);
      controller.abort(stopped);
      return result;
    });

    await expect(rebuildUnder(mirror, controller.signal)).rejects.toBe(stopped);
    expect(analyze).not.toHaveBeenCalled();
    expect(await statRows(mirror)).toHaveLength(0);
    expect(await mirror.status(FIXTURE_DOMAIN)).toMatchObject({ status: 'complete', ready: true });

    await mirror.close();
    mirror = openMirror();
    const next = vi.spyOn(mirror.reads, 'analyze');
    expect((await readCube(mirror)).rows.length).toBeGreaterThan(0);
    expect(next).toHaveBeenCalledTimes(1);
    await statisticsLand(mirror);
  }, 30_000);

  it('stops waiting for an in-flight build before it syncs once the run is stopped, and never starts the sync', async () => {
    const reopened = await reopenWithoutStatistics();
    const build = deferBuilds(reopened);
    const events: string[] = [];
    traceSync(reopened, events);
    await readCube(reopened);
    await build.started;
    const controller = new AbortController();
    const sync = rebuildUnder(reopened, controller.signal);
    const state = settledState(sync);
    await flush();
    expect(state.settled).toBe(false);

    const stopped = new Error('Stopped for shutdown');
    controller.abort(stopped);
    await flush();
    expect(state.settled).toBe(true);
    await expect(sync).rejects.toBe(stopped);
    expect(events).toEqual([]);

    build.resolve(1);
    await flush();
    expect(outcomes).toEqual(['built']);
  }, 30_000);
});

/**
 * Multi-item reads (#33). With several item codes plus an element filter, a plain
 * `ORDER BY year` lets the planner satisfy the sort from `(element_code, year)` and
 * walk the whole element slice testing `item_code` per row — on the real `QCL`
 * mirror, 1.6M rows walked to return 27,893 for the "sugar" item set. The fixture
 * is small, so the planner's choice comes from statistics seeded to that mirror's
 * `sqlite_stat1` and reloaded with `ANALYZE sqlite_schema`. `sqlite_stat4` is
 * cleared so a STAT4 build (better-sqlite3, which the Node test lane loads) plans
 * from the same stat1 figures as `bun:sqlite` (no STAT4, the Docker runtime).
 *
 * Plans are read off the statement {@link buildObservationSql} builds — the one
 * both read paths prepare — with its LIMIT (and a page's OFFSET) written as
 * literals, so the pin does not depend on how a driver binds and plans a LIMIT
 * parameter: with a literal LIMIT above roughly 2,000 rows both drivers pick the
 * element index for `ORDER BY year`, and the spill stream's 50,001 is always past
 * that point.
 */
describe('FaostatMirror multi-item read plan (#33)', () => {
  const TABLE = `obs_${FIXTURE_DOMAIN}`;
  /** The item codes "sugar" resolves to on the real mirror. */
  const SUGAR_ITEMS = [156, 157, 1723, 161, 162];
  const PRODUCTION = 5510;
  const YEARS = [2021, 2018, 2020, 2019];
  /** `sqlite_stat1` for `obs_QCL`, as ANALYZE left it on the real 4.2M-row mirror. */
  const QCL_STAT1: [string, string][] = [
    ['obs_QCL_area_code_idx', '4209110 17251'],
    ['obs_QCL_element_code_idx', '4209110 300651'],
    ['obs_QCL_element_code_year_idx', '4209110 300651 4698'],
    ['obs_QCL_item_code_element_code_year_idx', '4209110 13984 5798 92'],
    ['obs_QCL_item_code_idx', '4209110 13984'],
    ['obs_QCL_year_idx', '4209110 65768'],
    ['sqlite_autoindex_obs_QCL_1', '4209110 1'],
  ];

  const SUGAR: ObservationFilters = {
    itemCodes: SUGAR_ITEMS,
    elementCodes: [PRODUCTION],
    includeAggregates: false,
  };
  const ELEMENT_ONLY: ObservationFilters = { elementCodes: [PRODUCTION], includeAggregates: false };
  /** The bounds each read path runs at: the spill stream's cap + 1, a large probe. */
  const READS: [string, ObservationRead][] = [
    ['spill stream', { kind: 'stream', limit: 50_001 }],
    ['overflow probe', { kind: 'page', limit: 5_001, offset: 0 }],
  ];

  let dir: string;
  let mirror: FaostatMirror;
  let handle: SqliteHandle;

  /** The builder's statement for `read`, its LIMIT/OFFSET written as literals. */
  function withLiteralBounds(
    filters: ObservationFilters,
    read: ObservationRead,
  ): { sql: string; params: SqlValue[] } {
    const { sql, params } = buildObservationSql(FIXTURE_DOMAIN, filters, read);
    const [placeholders, literals, bound] =
      read.kind === 'page'
        ? ['LIMIT ? OFFSET ?', `LIMIT ${read.limit} OFFSET ${read.offset}`, 2]
        : ['LIMIT ?', `LIMIT ${read.limit}`, 1];
    expect(sql.endsWith(placeholders)).toBe(true);
    return {
      sql: `${sql.slice(0, -placeholders.length)}${literals}`,
      params: params.slice(0, -bound),
    };
  }

  function literalPlan(filters: ObservationFilters, read: ObservationRead): string {
    const { sql, params } = withLiteralBounds(filters, read);
    return queryPlan(handle, sql, params);
  }

  function expectYearOrder(rows: { year?: unknown }[]) {
    const years = rows.map((r) => Number(r.year));
    expect(years).toEqual([...years].sort((a, b) => a - b));
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-plan-'));
    // Every sugar item plus an unrelated one, under production and a second
    // element, for three countries and one aggregate, years out of order.
    const observations = [15, ...SUGAR_ITEMS].flatMap((itemCode) =>
      [PRODUCTION, 5312].flatMap((elementCode) =>
        [1, 2, 3, 5000].flatMap((areaCode) =>
          YEARS.map((year) => ({
            areaCode,
            area: `Area ${areaCode}`,
            itemCode,
            item: `Item ${itemCode}`,
            elementCode,
            element: elementCode === PRODUCTION ? 'Production' : 'Area harvested',
            year,
            value: itemCode * 10 + areaCode + (year - 2000) / 100,
          })),
        ),
      ),
    );
    const zip = buildExplicitDomainZip(observations);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });

    const m = mirror.getMirror(FIXTURE_DOMAIN);
    if (!m) throw new Error('mirror not found');
    handle = await m.raw();
    // The sync's own ANALYZE created the statistics tables; replace their rows.
    handle.exec(`DELETE FROM sqlite_stat1 WHERE tbl = '${TABLE}'`);
    const stat4 = handle
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='sqlite_stat4'`)
      .get();
    if (stat4) handle.exec(`DELETE FROM sqlite_stat4 WHERE tbl = '${TABLE}'`);
    const insert = handle.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)');
    for (const [idx, stat] of QCL_STAT1) insert.run(TABLE, idx, stat);
    handle.exec('ANALYZE sqlite_schema');
  }, 30_000);

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(READS)(
    'reproduces the element-index walk when the %s sorts by plain year (fixture guard)',
    (_name, read) => {
      // Without this, a green plan below could mean the seeded statistics never
      // steered the planner wrong in the first place. The same statement with a
      // plain `ORDER BY year` is what the read paths ran before the fix.
      const { sql, params } = withLiteralBounds(SUGAR, read);
      const plainYear = sql.replace('ORDER BY +year', 'ORDER BY year');
      expect(queryPlan(handle, plainYear, params)).toMatch(
        /USING INDEX obs_QCL_element_code_year_idx \(element_code=\?\)/,
      );
    },
  );

  it.each(
    READS.flatMap(([name, read]): [string, ObservationFilters, ObservationRead][] => [
      [`multi-item ${name}`, SUGAR, read],
      [`single-item ${name}`, { ...SUGAR, itemCodes: [156] }, read],
    ]),
  )('seeks the item composite for a %s', (_name, filters, read) => {
    const detail = literalPlan(filters, read);
    expect(detail).toMatch(
      /USING INDEX obs_QCL_item_code_element_code_year_idx \(item_code=\? AND element_code=\?\)/,
    );
    expect(detail).not.toMatch(/obs_QCL_element_code_year_idx/);
    // Only the item-bounded match is sorted.
    expect(detail).toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it.each([
    ...READS,
    ['inline page', { kind: 'page', limit: 51, offset: 0 }] satisfies [string, ObservationRead],
  ])('keeps the index-ordered plan for a %s with no item filter', (_name, read) => {
    // An element-only read has no item bound on its match, so its sort must still
    // come from index order — that is what lets the LIMIT stop the scan early.
    const detail = literalPlan(ELEMENT_ONLY, read);
    expect(detail).toMatch(/USING INDEX obs_QCL_element_code_year_idx \(element_code=\?\)/);
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it('streams the multi-item match whole, ordered by year', async () => {
    const rows: Record<string, unknown>[] = [];
    for await (const row of mirror.streamObservations(FIXTURE_DOMAIN, SUGAR, 50_001)) {
      rows.push(row);
    }

    // 5 items × 3 countries × 4 years; the aggregate and the other element excluded.
    expect(rows).toHaveLength(60);
    expect(new Set(rows.map((r) => r.item_code))).toEqual(new Set(SUGAR_ITEMS));
    expect(rows.every((r) => r.element_code === PRODUCTION && Number(r.area_code) < 5000)).toBe(
      true,
    );
    expectYearOrder(rows);
  });

  it('returns the multi-item match whole from the overflow probe, ordered by year', async () => {
    const res = await mirror.queryObservations(FIXTURE_DOMAIN, {
      ...SUGAR,
      limit: 5_000,
      offset: 0,
    });

    expect(res.totalIsExact).toBe(true);
    expect(res.rows).toHaveLength(60);
    expectYearOrder(res.rows);
  });

  it('pages the probe from the earliest year when the match overflows the limit', async () => {
    const res = await mirror.queryObservations(FIXTURE_DOMAIN, { ...SUGAR, limit: 20, offset: 0 });

    // 15 matching rows per year, so a 20-row page is all of 2018 and 5 rows of 2019.
    expect(res.totalIsExact).toBe(false);
    expect(res.rows).toHaveLength(20);
    expect(res.rows.slice(0, 15).every((r) => r.year === 2018)).toBe(true);
    expect(res.rows.slice(15).every((r) => r.year === 2019)).toBe(true);
  });

  it('pages across same-year rows without repeating or skipping one', async () => {
    // A page boundary inside a year: rows tied on year must come back in the same
    // relative order whatever the LIMIT/OFFSET, or a row lands on two pages.
    const whole = await mirror.queryObservations(FIXTURE_DOMAIN, {
      ...SUGAR,
      limit: 5_000,
      offset: 0,
    });
    const paged: string[] = [];
    for (let offset = 0; offset < 60; offset += 7) {
      const page = await mirror.queryObservations(FIXTURE_DOMAIN, { ...SUGAR, limit: 7, offset });
      paged.push(...page.rows.map((r) => r.id));
    }

    expect(paged).toHaveLength(60);
    expect(new Set(paged).size).toBe(60);
    expect(paged).toEqual(whole.rows.map((r) => r.id));
  });

  /**
   * Statistics rebuilt mid-walk can change the plan between two pages (#52). Each
   * index below is one the planner can pick for its filter; forcing them in turn,
   * ties within a year must come back in one order, or a walk that switches plans
   * at a page boundary repeats some rows and skips others.
   */
  it.each([
    [
      'two-element',
      { elementCodes: [PRODUCTION, 5312], includeAggregates: false },
      ['obs_QCL_element_code_idx', 'obs_QCL_element_code_year_idx', 'obs_QCL_year_idx'],
      6 * 2 * 3 * YEARS.length,
    ],
    [
      'multi-item',
      SUGAR,
      [
        'obs_QCL_item_code_element_code_year_idx',
        'obs_QCL_item_code_idx',
        'obs_QCL_element_code_year_idx',
      ],
      5 * 3 * YEARS.length,
    ],
  ] satisfies [string, ObservationFilters, string[], number][])(
    'returns %s ties within a year in one order under every index the planner can pick (#52)',
    (_name, filters, indexes, matched) => {
      const { sql, params } = withLiteralBounds(filters, { kind: 'page', limit: 5_000, offset: 0 });
      const orders = indexes.map((index) =>
        handle
          .prepare<{ id: string; year: number }>(
            sql.replace(`FROM ${TABLE} `, `FROM ${TABLE} INDEXED BY ${index} `),
          )
          .all(...params),
      );
      for (const rows of orders) {
        expect(rows).toHaveLength(matched);
        expectYearOrder(rows);
      }
      const [first, ...rest] = orders.map((rows) => rows.map((r) => r.id));
      for (const order of rest) expect(order).toEqual(first);
    },
  );
});

/**
 * Ranking read plan (#59). A ranking needs each country's latest year, and the
 * statement that found it by joining the item-bounded match to its own per-group
 * maximum read the cube twice — the joined side through whatever access path the
 * store's statistics favored. With every index analyzed except `unit_element_idx`,
 * the state a refresh leaves when it adds that index to an unchanged upstream, the
 * joined side sought `(unit, element_code)`; with only the legacy indexes analyzed
 * it sought `(area_code, year)`. The single-pass statement reads the match once, so
 * its access path is the only plan choice left.
 *
 * The fixture is small, so the planner's choices come from `sqlite_stat1` seeded to
 * the real mirror's figures in each statistics state and reloaded with `ANALYZE
 * sqlite_schema`; `sqlite_stat4` is cleared so the STAT4 build (better-sqlite3)
 * plans from the same figures as `bun:sqlite`. The plan is read off the statement
 * `rankAreaTotals` hands the read pool, and the pool's statistics build is stubbed
 * so the read cannot replace the seeded rows.
 */
describe('FaostatMirror ranking read plan (#59)', () => {
  type Domain = 'QCL' | 'TCL';
  const DOMAINS: Domain[] = ['QCL', 'TCL'];
  const WHEAT = 15;
  /** The element each domain's ranking reads: production, export quantity. */
  const ELEMENT: Record<Domain, number> = { QCL: 5510, TCL: 5910 };
  /** `sqlite_stat1` as ANALYZE left it on the real mirror, keyed by index suffix. */
  const STAT1: Record<Domain, Record<string, string>> = {
    QCL: {
      area_code_idx: '4209110 17251',
      area_code_year_idx: '4209110 17251 297',
      element_code_idx: '4209110 300651',
      element_code_year_idx: '4209110 300651 4698',
      item_code_element_code_year_idx: '4209110 13984 5798 92',
      item_code_idx: '4209110 13984',
      unit_element_idx: '4209110 420911 300651',
      year_idx: '4209110 65768',
    },
    TCL: {
      area_code_idx: '17143873 60580',
      area_code_year_idx: '17143873 60580 1118',
      element_code_idx: '17143873 1714388',
      element_code_year_idx: '17143873 1714388 26788',
      item_code_element_code_year_idx: '17143873 27831 7038 126',
      item_code_idx: '17143873 27831',
      unit_element_idx: '17143873 3428775 1714388',
      year_idx: '17143873 267874',
    },
  };
  /** Each statistics state, as the index suffixes left unanalyzed; `null` holds none at all. */
  const STATES: [string, string[] | null][] = [
    ['no', null],
    ['legacy-only', ['area_code_year_idx', 'unit_element_idx']],
    ['all-but-unit/element', ['unit_element_idx']],
    ['full', []],
  ];

  let dir: string;
  let mirror: FaostatMirror;

  async function handleOf(domain: Domain): Promise<SqliteHandle> {
    const m = mirror.getMirror(domain);
    if (!m) throw new Error('mirror not found');
    return m.raw();
  }

  /** Replace a domain's planner statistics with the real figures, minus `unanalyzed`. */
  async function seedStatistics(domain: Domain, unanalyzed: string[] | null): Promise<void> {
    const handle = await handleOf(domain);
    const table = `obs_${domain}`;
    handle.exec(`DELETE FROM sqlite_stat1 WHERE tbl = '${table}'`);
    const stat4 = handle
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='sqlite_stat4'`)
      .get();
    if (stat4) handle.exec(`DELETE FROM sqlite_stat4 WHERE tbl = '${table}'`);
    if (unanalyzed) {
      const insert = handle.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)');
      for (const [suffix, stat] of Object.entries(STAT1[domain])) {
        if (!unanalyzed.includes(suffix)) insert.run(table, `${table}_${suffix}`, stat);
      }
      const rows = STAT1[domain].item_code_idx?.split(' ')[0];
      insert.run(table, `sqlite_autoindex_${table}_1`, `${rows} 1`);
    }
    handle.exec('ANALYZE sqlite_schema');
  }

  /** The wheat ranking statement `rankAreaTotals` hands the read pool for `domain`. */
  async function rankingStatement(domain: Domain): Promise<{ sql: string; params: SqlValue[] }> {
    const all = vi.spyOn(mirror.reads, 'all').mockResolvedValue([]);
    await mirror.rankAreaTotals(
      domain,
      { itemCodes: [WHEAT], elementCodes: [ELEMENT[domain]], includeAggregates: false },
      10,
    );
    const job = all.mock.calls[0]?.[0];
    all.mockRestore();
    if (!job) throw new Error('rankAreaTotals issued no read');
    return job;
  }

  /** The cube accesses in a plan — one per time the statement reads `obs_<domain>`. */
  function cubeReads(detail: string, domain: Domain): string[] {
    const reads = detail.match(new RegExp(`\\b(?:SCAN|SEARCH) obs_${domain}\\b[^|]*`, 'g')) ?? [];
    return reads.map((read) => read.trim());
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-rank-plan-'));
    mirror = new FaostatMirror({ dir, domains: DOMAINS });
    for (const domain of DOMAINS) {
      // Wheat and one other item, under the ranked element and one other, for three
      // countries and one aggregate over three years.
      const observations = [WHEAT, 56].flatMap((itemCode) =>
        [ELEMENT[domain], 5312].flatMap((elementCode) =>
          [1, 2, 3, 5000].flatMap((areaCode) =>
            [2019, 2020, 2021].map((year) => ({
              areaCode,
              area: `Area ${areaCode}`,
              itemCode,
              item: `Item ${itemCode}`,
              elementCode,
              element: `Element ${elementCode}`,
              year,
              value: itemCode + areaCode + year / 10_000,
            })),
          ),
        ),
      );
      const zip = buildExplicitDomainZip(observations, domain);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => chunkedResponse(zip, 1 << 16)),
      );
      await mirror.runDomainSync(domain, 'init', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(domain),
      });
    }
    vi.spyOn(mirror.reads, 'analyze').mockResolvedValue(0);
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The self-join the single-pass statement replaced, over the same item-bounded match. */
  function replacedSelfJoin(sql: string, domain: Domain): string {
    const table = `obs_${domain}`;
    const where = new RegExp(`FROM ${table} (WHERE .*?value IS NOT NULL)`, 's').exec(sql)?.[1];
    if (!where) throw new Error('no item-bounded WHERE in the ranking statement');
    return `WITH matched AS (SELECT area_code, area, unit, year, value, flag FROM ${table} ${where}), latest AS (SELECT area_code, unit, MAX(year) AS year FROM matched GROUP BY area_code, unit) SELECT m.area_code AS area_code, MAX(m.area) AS area, m.unit AS unit, m.year AS year, SUM(m.value) AS value, COUNT(*) AS observations, group_concat(DISTINCT m.flag) AS flags FROM matched m JOIN latest l ON l.area_code = m.area_code AND l.year = m.year AND l.unit IS m.unit GROUP BY m.area_code, m.unit, m.year ORDER BY value DESC LIMIT ?`;
  }

  it.each(
    (
      [
        ['legacy-only', 'area_code_year_idx'],
        ['all-but-unit/element', 'unit_element_idx'],
      ] as const
    ).flatMap(([state, index]) => DOMAINS.map((domain) => [state, domain, index] as const)),
  )(
    'reproduces the self-join reading the cube twice with %s statistics on %s (fixture guard)',
    async (state, domain, index) => {
      // Without this, a green plan below could mean the seeded statistics never
      // steered the planner wrong in the first place.
      await seedStatistics(domain, STATES.find(([name]) => name === state)?.[1] ?? null);
      const { sql, params } = await rankingStatement(domain);
      const reads = cubeReads(
        queryPlan(await handleOf(domain), replacedSelfJoin(sql, domain), params),
        domain,
      );
      expect(reads).toHaveLength(2);
      expect(reads.join(' | ')).toContain(`USING INDEX obs_${domain}_${index}`);
    },
  );

  it.each(
    STATES.flatMap(([state, unanalyzed]) =>
      DOMAINS.map((domain) => [state, domain, unanalyzed] as const),
    ),
  )(
    'reads the cube once, through the item composite, with %s statistics on %s',
    async (_state, domain, unanalyzed) => {
      await seedStatistics(domain, unanalyzed);
      const { sql, params } = await rankingStatement(domain);
      const detail = queryPlan(await handleOf(domain), sql, params);
      expect(cubeReads(detail, domain)).toEqual([
        `SEARCH obs_${domain} USING INDEX obs_${domain}_item_code_element_code_year_idx (item_code=? AND element_code=?)`,
      ]);
      expect(detail).not.toMatch(/area_code_year_idx|unit_element_idx/);
    },
  );

  /** The statement `read` hands the read pool, captured without running it. */
  async function statementOf(
    read: () => Promise<unknown>,
  ): Promise<{ sql: string; params: SqlValue[] }> {
    const all = vi.spyOn(mirror.reads, 'all').mockResolvedValue([]);
    await read();
    const job = all.mock.calls[0]?.[0];
    all.mockRestore();
    if (!job) throw new Error('the read issued no statement');
    return job;
  }

  /*
   * The profile's element reads (#51) run on every profile, so each must stay an
   * item-bounded search in every statistics state: the selection read inside the
   * item composite alone, the units read beside the ranking it names.
   */
  it.each(
    STATES.flatMap(([state, unanalyzed]) =>
      DOMAINS.map((domain) => [state, domain, unanalyzed] as const),
    ),
  )(
    "reads an item's element codes from the item composite alone, with %s statistics on %s (#51)",
    async (_state, domain, unanalyzed) => {
      await seedStatistics(domain, unanalyzed);
      const { sql, params } = await statementOf(() => mirror.itemElements(domain, [WHEAT]));
      expect(cubeReads(queryPlan(await handleOf(domain), sql, params), domain)).toEqual([
        `SEARCH obs_${domain} USING COVERING INDEX obs_${domain}_item_code_element_code_year_idx (item_code=?)`,
      ]);
    },
  );

  it.each(
    STATES.flatMap(([state, unanalyzed]) =>
      DOMAINS.map((domain) => [state, domain, unanalyzed] as const),
    ),
  )(
    "reads a ranking's units once, through the item composite, with %s statistics on %s (#51)",
    async (_state, domain, unanalyzed) => {
      await seedStatistics(domain, unanalyzed);
      const { sql, params } = await statementOf(() =>
        mirror.elementUnits(domain, {
          itemCodes: [WHEAT],
          elementCodes: [ELEMENT[domain]],
          includeAggregates: false,
        }),
      );
      const detail = queryPlan(await handleOf(domain), sql, params);
      expect(cubeReads(detail, domain)).toEqual([
        `SEARCH obs_${domain} USING INDEX obs_${domain}_item_code_element_code_year_idx (item_code=? AND element_code=?)`,
      ]);
      expect(detail).not.toMatch(/area_code_year_idx|unit_element_idx/);
    },
  );
});
