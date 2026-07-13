/**
 * @fileoverview `FaostatMirror` — owns one framework `Mirror` per selected
 * domain (each a standard-cube SQLite table + FTS5 index) plus the shared
 * `DimensionsStore`. Lazily constructs a domain's `Mirror` from the manifest on
 * first access. Exposes the read helpers the tools query: observation lookup
 * with code/year filters and aggregate exclusion, per-domain readiness/status,
 * and code resolution. The init/refresh runners drive the bulk-ZIP ingesters.
 * @module services/faostat-mirror/faostat-mirror
 */

import { join } from 'node:path';
import {
  defineMirror,
  type Mirror,
  type MirrorLogger,
  type SyncGenerator,
  type SyncMode,
  type SyncProgress,
  type SyncResult,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { DimensionsStore } from './dimensions-store.js';
import { makeDomainSync } from './ingester.js';
import { fetchManifest, findDataset } from './manifest.js';
import type { DimensionKind, ManifestDataset, ObservationRow, ResolvedCode } from './types.js';
import { AGGREGATE_AREA_CODE_THRESHOLD } from './types.js';

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

export interface FaostatMirrorOptions {
  /** Directory holding the per-domain SQLite databases + the dimension DB. */
  dir: string;
  /** Domain codes selected for indexing (already normalized/upper-cased). */
  domains: string[];
  /** Logger for sync runs. */
  log?: MirrorLogger;
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
 * Holds the per-domain mirrors and the shared dimension store. Construction is
 * cheap and side-effect-free; a domain's `Mirror` opens its SQLite file on first
 * query or sync.
 */
export class FaostatMirror {
  readonly dimensions: DimensionsStore;
  private readonly mirrors = new Map<string, Mirror>();
  /**
   * Per-domain ingester slot. The read-path `sync` delegates to it; it is
   * undefined until `runDomainSync` binds a manifest-bound ingester for the run,
   * then cleared after. This keeps construction manifest-free (queries need no
   * `sync`) while letting one `Mirror` instance own both the read and sync paths.
   */
  private readonly ingesters = new Map<string, SyncGenerator | undefined>();
  private readonly log: MirrorLogger | undefined;
  private readonly dir: string;
  readonly domains: string[];

  constructor(opts: FaostatMirrorOptions) {
    this.dir = opts.dir;
    this.domains = opts.domains.map((d) => d.toUpperCase());
    this.log = opts.log;
    this.dimensions = new DimensionsStore(opts.dir);
    for (const code of this.domains) this.mirrors.set(code, this.buildMirror(code));
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
        path: join(this.dir, domainDbFile(upper)),
        table: `obs_${upper}`,
        primaryKey: 'id',
        columns: CUBE_COLUMNS,
        indexes: [
          { columns: ['area_code'] },
          { columns: ['item_code'] },
          { columns: ['element_code'] },
          { columns: ['year'] },
          // Composite indexes matching the common filter-column + `ORDER BY year`
          // shapes, so a filtered range+sort seeks and reads in index order instead
          // of materializing + sorting the whole matched set. `CREATE INDEX IF NOT
          // EXISTS` runs on every open(), so these apply to already-synced .db files
          // on the next startup — no re-sync. (issue #3)
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
   * Query observations from a domain's mirror with structured filters, year
   * range, and aggregate exclusion. Rather than a per-call unbounded `COUNT(*)`,
   * it fetches one row past `limit` — an overflow probe — so the caller can decide
   * inline-vs-spill without scanning the whole cube. `totalIsExact` is true when
   * the probe drained under `limit` (then `total` is the exact match count) and
   * false when it overflowed (then `total` is `limit`, a floor: more rows exist,
   * and the caller either spills — where the stream yields the exact count when it
   * drains under the staging cap — or discloses the figure as a lower bound).
   * Assumes the domain is selected and ready (callers gate first).
   */
  async queryObservations(
    code: string,
    q: ObservationQuery,
  ): Promise<{ rows: ObservationRow[]; total: number; totalIsExact: boolean }> {
    const mirror = this.getMirror(code);
    if (!mirror) return { rows: [], total: 0, totalIsExact: true };
    const handle = await mirror.raw();
    const table = `obs_${code.toUpperCase()}`;
    const { whereSql, params } = this.buildObservationWhere(q);
    // Fetch limit+1 to detect "more rows matched than were returned" without a
    // COUNT(*). `ORDER BY year` is backed by the composite / `year` indexes, so the
    // LIMIT bounds the scan instead of forcing a full sort of the matched set.
    const probe = handle
      .prepare<ObservationRow>(
        `SELECT * FROM ${table} ${whereSql} ORDER BY year ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit + 1, q.offset);
    const totalIsExact = probe.length <= q.limit;
    const rows = totalIsExact ? probe : probe.slice(0, q.limit);
    return { rows, total: rows.length, totalIsExact };
  }

  /**
   * Build the `WHERE` clause + bound params shared by the observation query and
   * stream paths. Aggregate exclusion (`area_code < THRESHOLD`) applies only when
   * the caller neither opted into aggregates nor named explicit area codes — with
   * explicit area codes the agent already chose them, so they are honored verbatim.
   */
  private buildObservationWhere(q: Omit<ObservationQuery, 'limit' | 'offset'>): {
    whereSql: string;
    params: (string | number)[];
  } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!q.includeAggregates && !q.areaCodes?.length) {
      where.push(`area_code < ${AGGREGATE_AREA_CODE_THRESHOLD}`);
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

  /**
   * Stream matching observation rows (no paging) for canvas spillover. Honors the
   * same filters as {@link queryObservations}. Bounded by `limit` (a SQL `LIMIT`):
   * the underlying SqliteHandle exposes no row iterator (its API is the
   * `bun:sqlite` ∩ `better-sqlite3` intersection — `all`/`get`/`run` only), so an
   * unbounded query would materialize the whole result set into one JS array.
   * The caller passes the staging cap + 1 so the spillover helper still observes
   * an overflow row and discloses truncation honestly. Sorts by `year` (not the
   * TEXT label columns) so the composite / `year` indexes satisfy the `ORDER BY`
   * and the LIMIT bounds the scan, rather than materializing + sorting every match.
   */
  async *streamObservations(
    code: string,
    q: Omit<ObservationQuery, 'limit' | 'offset'>,
    limit: number,
  ): AsyncGenerator<Record<string, unknown>> {
    const mirror = this.getMirror(code);
    if (!mirror) return;
    const handle = await mirror.raw();
    const table = `obs_${code.toUpperCase()}`;
    const { whereSql, params } = this.buildObservationWhere(q);
    const rows = handle
      .prepare<Record<string, unknown>>(
        `SELECT area_code, area, item_code, item, element_code, element, year, unit, value, flag FROM ${table} ${whereSql} ORDER BY year ASC LIMIT ?`,
      )
      .all(...params, limit);
    for (const row of rows) yield row;
  }

  /** Resolve codes in a dimension (delegates to the shared store). */
  resolve(
    dimension: DimensionKind,
    opts: { code?: number; query?: string; nameContains?: string; limit: number },
  ): Promise<{ matches: ResolvedCode[]; total: number }> {
    return this.dimensions.resolve(dimension, opts);
  }

  /**
   * Run a sync (init/refresh) for one domain. Rebinds the manifest-bound ingester
   * onto a fresh `Mirror` sharing the same store, since the read-path `Mirror`
   * carries a throwing `sync` placeholder. Fetches the manifest to discover the
   * domain's ZIP URL + DateUpdate.
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
    try {
      return await mirror.runSync({
        mode,
        signal: args.signal,
        ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      });
    } finally {
      this.ingesters.delete(upper);
    }
  }

  /** Look up a single dataset record from the live manifest. */
  private async resolveDataset(code: string, signal: AbortSignal): Promise<ManifestDataset> {
    const datasets = await fetchManifest(this.baseUrlFromDir(), signal);
    const dataset = findDataset(datasets, code);
    if (!dataset) {
      throw new Error(`Domain ${code} not found in the FAOSTAT manifest.`);
    }
    return dataset;
  }

  /** The bulk base URL — sync passes the dataset directly, so this is the manifest fallback only. */
  private baseUrlFromDir(): string {
    return process.env.FAOSTAT_BULK_BASE_URL ?? 'https://bulks-faostat.fao.org/production';
  }

  async close(): Promise<void> {
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
