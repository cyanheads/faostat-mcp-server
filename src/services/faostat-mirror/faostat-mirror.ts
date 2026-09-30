/**
 * @fileoverview `FaostatMirror` — owns one framework `Mirror` per selected
 * domain (each a standard-cube SQLite table + FTS5 index) plus the shared
 * `DimensionsStore`. Lazily constructs a domain's `Mirror` from the manifest on
 * first access. Exposes the read helpers the tools query: observation lookup
 * with code/year filters and aggregate exclusion, per-domain readiness/status,
 * and code resolution. The cube reads build their SQL here and run it on the
 * {@link ReadPool} worker threads (#3), under the signal a tool call takes from
 * {@link FaostatMirror.readSignal}. Owns each cube's query-planner statistics,
 * built on the same pool (#24): in the background when a data read finds none,
 * and after a sync that applied rows or finds none. The init/refresh runners drive
 * the bulk-ZIP ingesters.
 * @module services/faostat-mirror/faostat-mirror
 */

import { join } from 'node:path';
import { conflict } from '@cyanheads/mcp-ts-core/errors';
import {
  defineMirror,
  type Mirror,
  type MirrorLogger,
  type SqliteHandle,
  type SqlValue,
  type SyncGenerator,
  type SyncMode,
  type SyncProgress,
  type SyncResult,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { DimensionsStore } from './dimensions-store.js';
import { makeDomainSync } from './ingester.js';
import { fetchManifest, findDataset } from './manifest.js';
import { QUERY_CEILING_MS, ReadPool, withQueryCeiling } from './read-pool.js';
import type {
  AreaAggregateRow,
  DimensionKind,
  ManifestDataset,
  ObservationRow,
  ResolvedCode,
  YearAggregateRow,
} from './types.js';
import { AGGREGATE_AREA_CODE_THRESHOLD, AGGREGATE_AREA_CODES } from './types.js';

/** The standard normalized-cube columns for every domain mirror table. */
const CUBE_COLUMNS: Record<string, string> = {
  id: 'TEXT',
  area_code: 'INTEGER',
  area_m49: 'TEXT',
  area: 'TEXT',
  item_code: 'INTEGER',
  item: 'TEXT',
  element_code: 'INTEGER',
  element: 'TEXT',
  year: 'INTEGER',
  unit: 'TEXT',
  value: 'REAL',
  flag: 'TEXT',
  note: 'TEXT',
};

/** SQLite filename for a domain mirror table. */
function domainDbFile(code: string): string {
  return `domain-${code.toUpperCase()}.db`;
}

/** Cube table name for a domain — the single derivation every SQL path shares. */
function cubeTable(code: string): string {
  return `obs_${code.toUpperCase()}`;
}

/**
 * ANALYZE attempts a domain gets per process before the read path stops retrying
 * it. A failure is not memoized as success (#21), so contention that clears is
 * picked up by a later query; this bounds the other case, where the obstruction
 * is permanent (a read-only volume) and an unbounded retry would re-run an
 * expensive ANALYZE on every single query.
 */
const ANALYZE_MAX_ATTEMPTS = 3;

/**
 * Normalize a `group_concat(DISTINCT flag)` result into a sorted, comma-space
 * separated set. SQLite guarantees neither ordering nor de-duplication of blanks
 * across grouping strategies, so the raw string is not stable enough to hand a
 * client. Null (no observation in the group carried a flag) stays null — an
 * absent flag is never filled with a placeholder.
 */
function normalizeFlagSet(raw: string | null): string | null {
  if (raw === null) return null;
  const flags = [...new Set(raw.split(',').map((f) => f.trim()))]
    .filter((f) => f.length > 0)
    .sort();
  return flags.length > 0 ? flags.join(', ') : null;
}

export interface FaostatMirrorOptions {
  /** Directory holding the per-domain SQLite databases + the dimension DB. */
  dir: string;
  /** Domain codes selected for indexing (already normalized/upper-cased). */
  domains: string[];
  /** Logger for sync runs. */
  log?: MirrorLogger;
  /** Per-tool-call read ceiling behind {@link FaostatMirror.readSignal}. Default 45 s. */
  queryCeilingMs?: number;
}

/** Filters + range for an observation query. */
export interface ObservationQuery {
  areaCodes?: number[];
  elementCodes?: number[];
  includeAggregates: boolean;
  itemCodes?: number[];
  limit: number;
  offset: number;
  yearEnd?: number;
  yearStart?: number;
}

/**
 * Build the `WHERE` clause + bound params shared by the observation read and
 * aggregation paths. Aggregate exclusion applies only when the caller neither opted
 * into aggregates nor named explicit area codes — with explicit area codes the
 * agent already chose them, so they are honored verbatim. Aggregates are codes
 * `>= THRESHOLD` plus the curated sub-threshold roll-ups in AGGREGATE_AREA_CODES
 * (issue #4), the SQL mirror of isAggregateAreaCode() so the exclusion and the
 * resolve_codes `kind` label stay in lockstep.
 */
function buildObservationWhere(q: Omit<ObservationQuery, 'limit' | 'offset'>): {
  whereSql: string;
  params: SqlValue[];
} {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (!q.includeAggregates && !q.areaCodes?.length) {
    where.push(`area_code < ${AGGREGATE_AREA_CODE_THRESHOLD}`);
    // Also drop the curated sub-threshold roll-ups (China=351, …) the numeric
    // bound misses. Trusted integer constants — safe to inline like the threshold.
    if (AGGREGATE_AREA_CODES.size > 0) {
      where.push(`area_code NOT IN (${[...AGGREGATE_AREA_CODES].join(', ')})`);
    }
  }
  if (q.areaCodes?.length) {
    where.push(`area_code IN (${q.areaCodes.map(() => '?').join(',')})`);
    params.push(...q.areaCodes);
  }
  if (q.itemCodes?.length) {
    where.push(`item_code IN (${q.itemCodes.map(() => '?').join(',')})`);
    params.push(...q.itemCodes);
  }
  if (q.elementCodes?.length) {
    where.push(`element_code IN (${q.elementCodes.map(() => '?').join(',')})`);
    params.push(...q.elementCodes);
  }
  if (q.yearStart !== undefined) {
    where.push('year >= ?');
    params.push(q.yearStart);
  }
  if (q.yearEnd !== undefined) {
    where.push('year <= ?');
    params.push(q.yearEnd);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** The ten columns a staged observation table carries, in `OBSERVATION_TABLE_SCHEMA` order. */
const STREAM_COLUMNS =
  'area_code, area, item_code, item, element_code, element, year, unit, value, flag';

/**
 * How a row read is bounded: a `page` of every cube column (the overflow probe
 * behind {@link FaostatMirror.queryObservations}) or the `stream` of the staged
 * columns (behind {@link FaostatMirror.streamObservations}).
 */
export type ObservationRead =
  | { kind: 'page'; limit: number; offset: number }
  | { kind: 'stream'; limit: number };

/**
 * Build the row-read SQL both observation read paths prepare, with its bound
 * params in placeholder order: the filters', then `LIMIT`, then `OFFSET` for a
 * page. Pure, so the statement can be planned wherever it runs.
 *
 * Rows come back in year order either way; how the sort is written picks the
 * plan (#33):
 * - No item filter: `ORDER BY year`. `(element_code, year)` or `(year)` serves the
 *   filter and the sort at once, so the `LIMIT` stops the scan early.
 * - Item filter: `ORDER BY +year`. The unary plus keeps the planner from choosing
 *   an index to avoid the sort, so it seeks `(item_code, element_code, year)` and
 *   sorts only the matched rows, which the item codes already bound. Under a plain
 *   `year` and a large `LIMIT` it walked the whole element slice in year order
 *   instead, testing `item_code` per row — 1.6M rows for 27,893 on QCL.
 */
export function buildObservationSql(
  code: string,
  filters: Omit<ObservationQuery, 'limit' | 'offset'>,
  read: ObservationRead,
): { sql: string; params: SqlValue[] } {
  const { whereSql, params } = buildObservationWhere(filters);
  const columns = read.kind === 'stream' ? STREAM_COLUMNS : '*';
  const orderBy = filters.itemCodes?.length ? '+year' : 'year';
  const sql = `SELECT ${columns} FROM ${cubeTable(code)} ${whereSql} ORDER BY ${orderBy} ASC LIMIT ?`;
  return read.kind === 'page'
    ? { sql: `${sql} OFFSET ?`, params: [...params, read.limit, read.offset] }
    : { sql, params: [...params, read.limit] };
}

/**
 * Holds the per-domain mirrors and the shared dimension store. Construction is
 * cheap and side-effect-free; a domain's `Mirror` opens its SQLite file on first
 * query or sync.
 */
export class FaostatMirror {
  readonly dimensions: DimensionsStore;
  /** Worker threads the cube reads run on; closed by {@link close}. */
  readonly reads = new ReadPool();
  private readonly mirrors = new Map<string, Mirror>();
  /**
   * Per-domain ingester slot. The read-path `sync` delegates to it; it is
   * undefined until `runDomainSync` binds a manifest-bound ingester for the run,
   * then cleared after. This keeps construction manifest-free (queries need no
   * `sync`) while letting one `Mirror` instance own both the read and sync paths.
   */
  private readonly ingesters = new Map<string, SyncGenerator | undefined>();
  /**
   * Domains whose query-planner statistics are in place in this process — found
   * already present, or built successfully — see {@link ensureQueryStatistics}.
   */
  private readonly analyzed = new Set<string>();
  /** The statistics build in flight per domain — at most one, see {@link buildStatistics}. */
  private readonly builds = new Map<string, Promise<void>>();
  /** Domains with an in-process sync running; a read schedules no build for them meanwhile. */
  private readonly syncing = new Set<string>();
  /**
   * Failed ANALYZE attempts per domain. Only the outcome is memoized, so a
   * failure leaves the domain eligible for a retry on the next read rather than
   * being remembered as success; the count bounds that retry at
   * {@link ANALYZE_MAX_ATTEMPTS}.
   */
  private readonly analyzeFailures = new Map<string, number>();
  private readonly log: MirrorLogger | undefined;
  private readonly dir: string;
  private readonly queryCeilingMs: number;
  readonly domains: string[];

  constructor(opts: FaostatMirrorOptions) {
    this.dir = opts.dir;
    this.domains = opts.domains.map((d) => d.toUpperCase());
    this.log = opts.log;
    this.queryCeilingMs = opts.queryCeilingMs ?? QUERY_CEILING_MS;
    this.dimensions = new DimensionsStore(opts.dir);
    for (const code of this.domains) this.mirrors.set(code, this.buildMirror(code));
  }

  /**
   * The signal a tool call passes to every cube read it makes: the call's own
   * signal plus the per-call ceiling, past which a read — queued or running —
   * fails with a retryable `query_timeout`. Create it once per call, before the
   * first read, so the ceiling bounds the call rather than each read.
   */
  readSignal(callSignal?: AbortSignal): AbortSignal {
    return withQueryCeiling(callSignal, this.queryCeilingMs);
  }

  /** True when `code` is in the selected (indexed) domain set. */
  isSelected(code: string): boolean {
    return this.mirrors.has(code.toUpperCase());
  }

  /** The selected domain codes. */
  selectedDomains(): string[] {
    return [...this.mirrors.keys()];
  }

  private buildMirror(code: string): Mirror {
    const upper = code.toUpperCase();
    const ingesters = this.ingesters;
    return defineMirror({
      name: `faostat-${upper}`,
      store: sqliteMirrorStore({
        path: this.domainFile(upper),
        table: cubeTable(upper),
        primaryKey: 'id',
        columns: CUBE_COLUMNS,
        indexes: [
          { columns: ['area_code'] },
          { columns: ['item_code'] },
          { columns: ['element_code'] },
          { columns: ['year'] },
          // Composite indexes matching the common filter shapes: `(element_code,
          // year)` serves an element/year-filtered read in year order, so its LIMIT
          // bounds the scan; `(item_code, element_code, year)` is the seek for an
          // item-filtered read, which sorts its bounded match (see
          // buildObservationSql, #33). `CREATE INDEX IF NOT EXISTS` runs on every
          // open(), so these apply to already-synced .db files on the next startup —
          // no re-sync. (issue #3)
          { columns: ['element_code', 'year'] },
          { columns: ['item_code', 'element_code', 'year'] },
        ],
      }),
      // Delegates to the per-domain ingester slot bound by runDomainSync. The
      // read path never calls sync, so the slot is empty then — guard loudly.
      async *sync(ctx) {
        const ingester = ingesters.get(upper);
        if (!ingester) {
          throw new Error(
            `faostat-${upper} sync invoked without a manifest-bound ingester — call runDomainSync.`,
          );
        }
        yield* ingester(ctx);
      },
      ...(this.log ? { logger: this.log } : {}),
    });
  }

  /**
   * Path of a domain's SQLite file — the store's own, and what a read worker opens
   * its handle on and the pool keys a statistics invalidation by.
   */
  private domainFile(code: string): string {
    return join(this.dir, domainDbFile(code));
  }

  /** The `Mirror` for a selected domain, or undefined when not selected. */
  getMirror(code: string): Mirror | undefined {
    return this.mirrors.get(code.toUpperCase());
  }

  /** True once a domain's mirror has ever completed a sync (queryable mid-refresh). */
  ready(code: string): Promise<boolean> {
    const mirror = this.getMirror(code);
    return mirror ? mirror.ready() : Promise.resolve(false);
  }

  /** Public status for a selected domain. */
  status(code: string) {
    const mirror = this.getMirror(code);
    return mirror ? mirror.status() : Promise.resolve(undefined);
  }

  /**
   * Open a selected domain's SQLite handle on the main thread — which runs the
   * store DDL, so the file and its cube table exist before a read worker opens
   * its own handle on it — and resolve the table name and file path. Undefined
   * when the domain is not selected. Carries no statistics gate — the filtering
   * and aggregating paths open through {@link openAnalyzedDomain} instead.
   */
  private async openDomain(
    code: string,
  ): Promise<{ file: string; handle: SqliteHandle; table: string } | undefined> {
    const upper = code.toUpperCase();
    const mirror = this.mirrors.get(upper);
    if (!mirror) return;
    return { file: this.domainFile(upper), handle: await mirror.raw(), table: cubeTable(upper) };
  }

  /**
   * {@link openDomain} with query-planner statistics seen to first — a domain
   * without them gets a background build, and this read does not wait for it
   * (#24). Every path that filters or aggregates the cube goes through here, so a
   * domain whose planner is flying blind is caught by its first data read. The gate
   * is deliberately not on `openDomain` itself: the statistics serve the `item_code
   * + element_code + year` filter shape, and a whole-column scan that shape does not
   * describe — the distinct-code read behind {@link domainDimensionCodes} — would
   * otherwise schedule an optimization it cannot use (#22).
   */
  private async openAnalyzedDomain(
    code: string,
  ): Promise<{ file: string; handle: SqliteHandle; table: string } | undefined> {
    const opened = await this.openDomain(code);
    if (!opened) return;
    this.ensureQueryStatistics(code.toUpperCase(), opened.handle, opened.table);
    return opened;
  }

  /**
   * See that a domain table has SQLite's cardinality statistics (`sqlite_stat1`),
   * without making the caller wait for them. Without statistics the cost-based
   * optimizer cannot compare the composite indexes and falls back to a poor default
   * — measured on the real mirror, it seeks `(element_code, year)` for an
   * item+element filter and scans that entire element slice, so an aggregate over 5
   * items of one commodity takes ~5s on TCL and ~6s on QCL instead of ~60ms and
   * ~5ms. ANALYZE is what makes the composite indexes declared above actually get
   * chosen (#3).
   *
   * The `sqlite_stat1` probe is the guard: statistics persist inside the `.db`
   * file, so an already-analyzed mirror (the steady state, since a sync builds them)
   * pays one sub-millisecond lookup per domain per process. A domain without them —
   * synced before statistics shipped and unchanged upstream since, or whose last
   * build failed — gets one background build on the read pool
   * ({@link buildStatistics}), and this read goes ahead on the plan it has (#24).
   * The build costs seconds on QCL (4.2M rows) and over a minute on TCL (17.1M), so
   * waiting for it would stall the caller past its `query_timeout`. A sampled
   * ANALYZE (`PRAGMA analysis_limit`) was measured and rejected: at every limit
   * tried it produced uniform per-key estimates that left the wrong index selected.
   *
   * Statistics are an optimization, so a failed build (read-only volume, a writer
   * holding the lock past `busy_timeout`) leaves the domain on the old plan. Only
   * success is memoized: a failure is retried by a later read, so contention
   * lasting milliseconds costs one more build rather than the uninformed plan for
   * the life of the process, while {@link ANALYZE_MAX_ATTEMPTS} caps what an
   * obstruction that never clears can cost (#21).
   */
  private ensureQueryStatistics(code: string, handle: SqliteHandle, table: string): void {
    // A running sync ends with its own pass (see runDomainSync).
    if (this.analyzed.has(code) || this.builds.has(code) || this.syncing.has(code)) return;
    if ((this.analyzeFailures.get(code) ?? 0) >= ANALYZE_MAX_ATTEMPTS) return;
    if (this.hasStatistics(handle, table)) {
      this.analyzed.add(code);
      return;
    }
    void this.buildStatistics(code);
  }

  /**
   * Memoize an ANALYZE outcome. Success settles the domain for the process and
   * has the read workers reopen their handle on it — one that already loaded its
   * schema would keep planning from the statistics it read then. Failure buys a
   * retry, and logs once when the budget runs out — otherwise the degraded plan
   * persists with nothing in the record saying so.
   */
  private recordAnalyzeOutcome(code: string, succeeded: boolean): void {
    if (succeeded) {
      this.analyzed.add(code);
      this.analyzeFailures.delete(code);
      this.reads.invalidate(this.domainFile(code));
      return;
    }
    this.analyzed.delete(code);
    const failures = (this.analyzeFailures.get(code) ?? 0) + 1;
    this.analyzeFailures.set(code, failures);
    if (failures === ANALYZE_MAX_ATTEMPTS) {
      this.log?.warning?.(
        `ANALYZE failed ${failures} times for ${code} — reads stop retrying it this process (a sync will try again); its queries keep the planner's uninformed index choice`,
      );
    }
  }

  /** True when `sqlite_stat1` exists and carries a row for `table`. */
  private hasStatistics(handle: SqliteHandle, table: string): boolean {
    const statTable = handle
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`)
      .get();
    if (!statTable) return false;
    const stat = handle
      .prepare(`SELECT 1 AS ok FROM sqlite_stat1 WHERE tbl = ? LIMIT 1`)
      .get(table);
    return stat !== undefined;
  }

  /**
   * Build a domain's planner statistics on the read pool — `ANALYZE` on a worker's
   * read-write handle, so the main thread keeps serving for the whole run — then
   * log and memoize the outcome ({@link recordAnalyzeOutcome}). Single flight: while
   * a build of the domain is in flight, a second call joins it. The returned promise
   * never rejects, since a failure is recorded, not thrown. It bypasses the read-path
   * memo and budget, which {@link ensureQueryStatistics} applies before calling.
   */
  private buildStatistics(code: string): Promise<void> {
    const inFlight = this.builds.get(code);
    if (inFlight) return inFlight;
    const table = cubeTable(code);
    const build = this.reads.analyze(this.domainFile(code), table).then(
      (durationMs) => {
        this.builds.delete(code);
        this.log?.info?.(`Query-planner statistics updated for ${table}`, { durationMs });
        this.recordAnalyzeOutcome(code, true);
      },
      (err: unknown) => {
        this.builds.delete(code);
        this.log?.warning?.(
          `Could not ANALYZE ${table} — queries fall back to the planner's uninformed index choice`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        this.recordAnalyzeOutcome(code, false);
      },
    );
    this.builds.set(code, build);
    return build;
  }

  /**
   * Query observations from a domain's mirror with structured filters, year
   * range, and aggregate exclusion. Rather than a per-call unbounded `COUNT(*)`,
   * it fetches one row past `limit` — an overflow probe — so the caller can decide
   * inline-vs-spill without scanning the whole cube. `totalIsExact` is true when
   * the probe drained under `limit` (then `total` is the exact match count) and
   * false when it overflowed (then `total` is `limit`, a floor: more rows exist,
   * and the caller either spills — where the stream yields the exact count when it
   * drains under the staging cap — or discloses the figure as a lower bound).
   * Assumes the domain is selected and ready (callers gate first).
   *
   * Every cube read runs on {@link reads} and takes the call's
   * {@link readSignal}: once it aborts, the read rejects — queued or running.
   */
  async queryObservations(
    code: string,
    q: ObservationQuery,
    signal?: AbortSignal,
  ): Promise<{ rows: ObservationRow[]; total: number; totalIsExact: boolean }> {
    const opened = await this.openAnalyzedDomain(code);
    if (!opened) return { rows: [], total: 0, totalIsExact: true };
    // Fetch limit+1 to detect "more rows matched than were returned" without a
    // COUNT(*).
    const { sql, params } = buildObservationSql(code, q, {
      kind: 'page',
      limit: q.limit + 1,
      offset: q.offset,
    });
    const probe = await this.reads.all<ObservationRow>({ file: opened.file, sql, params }, signal);
    const totalIsExact = probe.length <= q.limit;
    const rows = totalIsExact ? probe : probe.slice(0, q.limit);
    return { rows, total: rows.length, totalIsExact };
  }

  /**
   * Stream matching observation rows (no paging) for canvas spillover. Honors the
   * same filters as {@link queryObservations}. Bounded by `limit` (a SQL `LIMIT`):
   * the underlying SqliteHandle exposes no row iterator (its API is the
   * `bun:sqlite` ∩ `better-sqlite3` intersection — `all`/`get`/`run` only), so an
   * unbounded query would materialize the whole result set into one JS array.
   * The caller passes the staging cap + 1 so the spillover helper still observes
   * an overflow row and discloses truncation honestly. Sorts by `year`, never the
   * TEXT label columns; {@link buildObservationSql} decides whether an index or a
   * sort of the item-bounded match supplies that order.
   */
  async *streamObservations(
    code: string,
    q: Omit<ObservationQuery, 'limit' | 'offset'>,
    limit: number,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    const opened = await this.openAnalyzedDomain(code);
    if (!opened) return;
    const { sql, params } = buildObservationSql(code, q, { kind: 'stream', limit });
    yield* await this.reads.all<Record<string, unknown>>(
      { file: opened.file, sql, params },
      signal,
    );
  }

  /**
   * Rank areas by the summed value across every matching item, each area taken at
   * its OWN latest year with data. Runs entirely in SQL over the full filtered
   * match, so it is bounded by neither a row cap nor the `ORDER BY year ASC` page
   * order the row-oriented read paths use — a country whose series ends early
   * still ranks, and a country never appears once per resolved item (issue #5).
   *
   * Grouping is `(area_code, unit)`: FAOSTAT reports different items of one
   * commodity family in different units (tonnes vs head), and summing across
   * units would be arithmetic on incomparable quantities. With a single unit —
   * the ordinary case — this is exactly one row per country.
   *
   * Assumes the domain is selected and ready (callers gate first).
   */
  async rankAreaTotals(
    code: string,
    q: Omit<ObservationQuery, 'limit' | 'offset'>,
    topN: number,
    signal?: AbortSignal,
  ): Promise<AreaAggregateRow[]> {
    const opened = await this.openAnalyzedDomain(code);
    if (!opened) return [];
    const { file, table } = opened;
    const { whereSql, params } = this.buildValuedWhere(q);
    /*
     * `latest` resolves each (area, unit) group's own newest year; the join then
     * sums only that year's rows. `l.unit IS m.unit` (not `=`) so the NULL-unit
     * group joins to itself. `MAX(m.area)` picks the label without widening the
     * GROUP BY — a label variant would otherwise split one area into two rows.
     */
    const rows = await this.reads.all<{
      area: string;
      area_code: number;
      flags: string | null;
      observations: number;
      unit: string | null;
      value: number;
      year: number;
    }>(
      {
        file,
        sql: `WITH matched AS (SELECT area_code, area, unit, year, value, flag FROM ${table} ${whereSql}),
              latest AS (SELECT area_code, unit, MAX(year) AS year FROM matched GROUP BY area_code, unit)
         SELECT m.area_code AS area_code,
                MAX(m.area) AS area,
                m.unit AS unit,
                m.year AS year,
                SUM(m.value) AS value,
                COUNT(*) AS observations,
                group_concat(DISTINCT m.flag) AS flags
           FROM matched m
           JOIN latest l ON l.area_code = m.area_code AND l.year = m.year AND l.unit IS m.unit
          GROUP BY m.area_code, m.unit, m.year
          ORDER BY value DESC
          LIMIT ?`,
        params: [...params, topN],
      },
      signal,
    );
    return rows.map((r) => ({ ...r, flags: normalizeFlagSet(r.flags) }));
  }

  /**
   * Sum matching observations per `(year, unit)` — the compact annual series
   * behind a commodity's production trend. Bounded by the domain's year span (a
   * few dozen rows), so it inlines rather than needing the canvas, and like
   * {@link rankAreaTotals} it aggregates in SQL over the full filtered match
   * rather than a capped page. Assumes the domain is selected and ready.
   */
  async sumByYear(
    code: string,
    q: Omit<ObservationQuery, 'limit' | 'offset'>,
    signal?: AbortSignal,
  ): Promise<YearAggregateRow[]> {
    const opened = await this.openAnalyzedDomain(code);
    if (!opened) return [];
    const { file, table } = opened;
    const { whereSql, params } = this.buildValuedWhere(q);
    const rows = await this.reads.all<{
      flags: string | null;
      observations: number;
      unit: string | null;
      value: number;
      year: number;
    }>(
      {
        file,
        sql: `SELECT year, unit, SUM(value) AS value, COUNT(*) AS observations,
                group_concat(DISTINCT flag) AS flags
           FROM ${table} ${whereSql}
          GROUP BY year, unit
          ORDER BY year ASC`,
        params,
      },
      signal,
    );
    return rows.map((r) => ({ ...r, flags: normalizeFlagSet(r.flags) }));
  }

  /**
   * {@link buildObservationWhere} narrowed to rows carrying a value. The
   * aggregation paths sum values, so a null-valued cell contributes nothing but
   * would inflate the observation count and pull a group's "latest year" forward
   * to a year that holds no measurement.
   */
  private buildValuedWhere(q: Omit<ObservationQuery, 'limit' | 'offset'>): {
    whereSql: string;
    params: SqlValue[];
  } {
    const { whereSql, params } = buildObservationWhere(q);
    return {
      whereSql: whereSql ? `${whereSql} AND value IS NOT NULL` : 'WHERE value IS NOT NULL',
      params,
    };
  }

  /**
   * Resolve codes in a dimension. Item and element resolution is scoped to the
   * codes actually present in `domain`'s observation cube (issue #8) — the shared
   * dimension vocabulary is a union across every indexed domain, so an unscoped
   * resolve can surface a code absent from the requested domain and then dead-loop
   * against an empty faostat_query_observations. Areas are never scoped: country
   * vocabularies legitimately overlap domains.
   */
  async resolve(
    domain: string,
    dimension: DimensionKind,
    opts: {
      code?: number;
      query?: string;
      nameContains?: string;
      limit: number;
      offset?: number;
      /** The call's {@link readSignal}, for the cube read that scopes items and elements. */
      signal?: AbortSignal;
    },
  ): Promise<{ matches: ResolvedCode[]; total: number }> {
    const { signal, ...lookup } = opts;
    const domainCodes =
      dimension === 'area' ? undefined : await this.domainDimensionCodes(domain, dimension, signal);
    return this.dimensions.resolve(dimension, {
      ...lookup,
      ...(domainCodes ? { domainCodes } : {}),
    });
  }

  /**
   * The distinct item/element codes present in a domain's observation cube — the
   * membership set that scopes {@link resolve} (issue #8). Index-backed: `SELECT
   * DISTINCT item_code|element_code` reads the existing per-column covering index,
   * so no schema change or re-sync is needed. `raw()` runs the store DDL on open,
   * so the table exists even for a selected-but-unsynced domain — then the cube is
   * empty, the set is `[]`, and resolve returns no matches (the honest answer for a
   * domain you cannot yet query).
   *
   * Opens ungated (#22). This is a discovery read — the single-column index already
   * serves it, and it is the call an agent makes first, so routing it through the
   * statistics gate charged the cheapest call for the slowest optimization and left
   * an HTTP caller waiting out a full ANALYZE for codes it could have had at once.
   */
  private async domainDimensionCodes(
    domain: string,
    dimension: Exclude<DimensionKind, 'area'>,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const opened = await this.openDomain(domain);
    if (!opened) return [];
    const { file, table } = opened;
    const column = dimension === 'item' ? 'item_code' : 'element_code';
    const rows = await this.reads.all<{ code: number | null }>(
      { file, sql: `SELECT DISTINCT ${column} AS code FROM ${table}`, params: [] },
      signal,
    );
    return rows.map((r) => r.code).filter((c): c is number => c != null);
  }

  /**
   * Run a sync (init/refresh) for one domain. Rebinds the manifest-bound ingester
   * onto a fresh `Mirror` sharing the same store, since the read-path `Mirror`
   * carries a throwing `sync` placeholder. Fetches the manifest to discover the
   * domain's ZIP URL + DateUpdate.
   *
   * Ends with a statistics build on the read pool whenever the sync applied rows —
   * a FAOSTAT domain ZIP is one atomic unit, so the previous statistics describe a
   * table that no longer exists — or the domain has none, which is how
   * `mirror:refresh` catches up a mirror synced before statistics shipped. A sync
   * that applied nothing to a domain with statistics skips the pass, so the nightly
   * no-op refresh stays a no-op. The sync is awaited through its build.
   *
   * `ANALYZE` holds the file's write lock for its whole run, so a sync and a build
   * of the same domain never overlap (#24): the sync waits out a build already in
   * flight, and reads schedule none while it runs. A second sync of a domain whose
   * sync is running fails at once with `Conflict` — it would share the ingester slot.
   */
  async runDomainSync(
    code: string,
    mode: SyncMode,
    args: { signal: AbortSignal; onProgress?: SyncProgress; dataset?: ManifestDataset },
  ): Promise<SyncResult> {
    const upper = code.toUpperCase();
    const mirror = this.mirrors.get(upper);
    if (!mirror) {
      throw new Error(`Domain ${upper} is not in the selected set (FAOSTAT_DOMAINS).`);
    }
    if (this.syncing.has(upper)) {
      throw conflict(`Domain ${upper} sync is already in progress.`, { domain: upper });
    }
    this.syncing.add(upper);
    try {
      await this.builds.get(upper);
      const dataset = args.dataset ?? (await this.resolveDataset(upper, args.signal));
      // Bind the manifest-bound ingester onto the per-domain slot the read-path
      // mirror's `sync` delegates to, run, then clear the slot. One Mirror instance
      // owns both paths against one open store handle.
      this.ingesters.set(
        upper,
        makeDomainSync({
          dataset,
          dimensions: this.dimensions,
          ...(this.log ? { log: this.log } : {}),
        }),
      );
      const result = await mirror.runSync({
        mode,
        signal: args.signal,
        ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      });
      const applied = result.recordsApplied > 0 || result.tombstonesApplied > 0;
      if (applied || !this.hasStatistics(await mirror.raw(), cubeTable(upper))) {
        await this.buildStatistics(upper);
      }
      return result;
    } finally {
      this.ingesters.delete(upper);
      this.syncing.delete(upper);
    }
  }

  /**
   * Look up a single dataset record from the live manifest, fetched from the
   * configured bulk base — the same parsed `FAOSTAT_BULK_BASE_URL` every other
   * manifest fetch uses, so an error naming that setting names the URL in use.
   * The CLI scripts pass the dataset directly; the in-process refresh lands here.
   */
  private async resolveDataset(code: string, signal: AbortSignal): Promise<ManifestDataset> {
    const datasets = await fetchManifest(getServerConfig().bulkBaseUrl, signal);
    const dataset = findDataset(datasets, code);
    if (!dataset) {
      throw new Error(`Domain ${code} not found in the FAOSTAT manifest.`);
    }
    return dataset;
  }

  /** Shut the read pool down first, then close the domain handles and the dimension store. */
  async close(): Promise<void> {
    await this.reads.close();
    for (const mirror of this.mirrors.values()) await mirror.close();
    await this.dimensions.close();
  }
}

// --- Init/accessor pattern ---

let _mirror: FaostatMirror | undefined;

/** Construct and register the server-side mirror singleton. */
export function initFaostatMirror(opts: FaostatMirrorOptions): FaostatMirror {
  _mirror = new FaostatMirror(opts);
  return _mirror;
}

/** The registered mirror singleton. Throws when not initialized. */
export function getFaostatMirror(): FaostatMirror {
  if (!_mirror) {
    throw new Error('FaostatMirror not initialized — call initFaostatMirror() in setup().');
  }
  return _mirror;
}
