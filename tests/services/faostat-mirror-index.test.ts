/**
 * @fileoverview Index + overflow-probe regression for the event-loop-blocking
 * query path (#3). Syncs a mid-size synthetic domain, then asserts (a) the
 * element/year-filtered `ORDER BY year` shapes are served by a composite index
 * rather than a full materialize-and-sort — confirmed via `EXPLAIN QUERY PLAN` on
 * the statement `buildObservationSql` builds (no "USE TEMP B-TREE FOR ORDER BY"),
 * and (b) a broad query stays bounded and correct through the LIMIT-probe path
 * that replaced the per-call `COUNT(*)`. The third suite pins the item-filtered
 * shape (#33): it seeks the item composite and sorts only its match.
 *
 * Declaring those indexes is not enough on its own: without `sqlite_stat1` the
 * cost-based optimizer cannot compare them and picks the less selective one for
 * the item+element filter shape the aggregation paths use — measured on the real
 * mirror as seconds per query instead of milliseconds. The second suite here
 * covers the statistics lifecycle that fixes it. A data read that finds none
 * schedules one background build on the read pool and answers without waiting
 * for it (#24), a failed build is retried by a later read within a fixed budget
 * (#21), the dimension-code discovery read never schedules one (#22), a sync
 * rebuilds them when it applied rows or finds none, and a build and a sync of the
 * same domain never overlap.
 * @module tests/services/faostat-mirror-index
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
});

describe('FaostatMirror query-planner statistics (#3, #24)', () => {
  const TABLE = `obs_${FIXTURE_DOMAIN}`;
  let dir: string;
  let mirror: FaostatMirror;
  /** Statistics-build outcomes the current mirror logged, oldest first. */
  let outcomes: ('built' | 'failed')[];

  /** A mirror on `dir` whose log records each statistics-build outcome. */
  function openMirror(queryCeilingMs?: number): FaostatMirror {
    outcomes = [];
    return new FaostatMirror({
      dir,
      domains: [FIXTURE_DOMAIN],
      ...(queryCeilingMs !== undefined ? { queryCeilingMs } : {}),
      log: {
        info: (message) => {
          if (message.startsWith('Query-planner statistics updated')) outcomes.push('built');
        },
        warning: (message) => {
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
   * Make each statistics build fail until `clear()`, standing in for a writer that
   * holds the lock past `busy_timeout`. Wraps the pool's `analyze` rather than
   * replacing it, so a build after `clear()` runs the real worker `ANALYZE`.
   */
  function obstructBuilds(target: FaostatMirror): { attempts: () => number; clear: () => void } {
    const analyze = target.reads.analyze.bind(target.reads);
    let attempts = 0;
    let obstructed = true;
    vi.spyOn(target.reads, 'analyze').mockImplementation((file, table) => {
      attempts += 1;
      return obstructed ? Promise.reject(new Error('database is locked')) : analyze(file, table);
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
    // Every stat string opens with the table's row count — the cardinality the
    // optimizer lacked (60 countries + 4 aggregates, 2 years each).
    for (const row of rows) expect(row.stat.split(' ')[0]).toBe('128');
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
    vi.spyOn(reopened.reads, 'analyze').mockImplementation(async (file, table) => {
      events.push('build start');
      await gate;
      const durationMs = await analyze(file, table);
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
 * literals. A bound LIMIT is where the two drivers part: better-sqlite3 binds a JS
 * number as REAL, which the planner does not take as a known row limit, so under it
 * `bun:sqlite` still picks the element index and better-sqlite3 does not, while with
 * a literal LIMIT above roughly 2,000 rows both pick it for `ORDER BY year`. The
 * literal makes the pin driver-independent; the spill stream's 50,001 is always past
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
});
