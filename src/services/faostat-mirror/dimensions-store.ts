/**
 * @fileoverview Shared dimension store — `areas`, `items`, `elements`, `flags`
 * tables populated from each domain ZIP's bundled code-list CSVs (items also
 * from the data rows, for identities a list omits), plus FTS5 indexes over the
 * labels that drive `faostat_resolve_codes`. Owned directly via
 * the framework's runtime-agnostic SQLite handle (not a per-table MirrorService,
 * which is one-table-per-store): dimensions are reference vocabularies shared
 * across every domain, upserted opportunistically during each domain sync.
 * @module services/faostat-mirror/dimensions-store
 */

import { join } from 'node:path';
import { openSqliteHandle, type SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import {
  type AreaKind,
  type AreaRecord,
  type DimensionKind,
  type ElementRecord,
  type FlagRecord,
  type ItemRecord,
  isAggregateAreaCode,
  type ResolvedCode,
} from './types.js';

/** Filename for the shared dimension database inside the mirror directory. */
export const DIMENSIONS_DB_FILE = 'dimensions.db';

/** FTS5 tokenizer: Unicode-aware, diacritic-stripping (matches the framework default). */
const FTS_TOKENIZER = 'unicode61 remove_diacritics 2';

/** Idempotent DDL for the dimension tables + FTS indexes. Safe to run on every open. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS areas (
  area_code INTEGER PRIMARY KEY NOT NULL,
  area_m49  TEXT,
  area      TEXT NOT NULL,
  kind      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  item_code INTEGER UNIQUE,
  item_code_text TEXT UNIQUE,
  cpc_code  TEXT,
  item      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS elements (
  element_code INTEGER PRIMARY KEY NOT NULL,
  element      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flags (
  flag        TEXT PRIMARY KEY NOT NULL,
  description TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS areas_fts USING fts5(
  area, content='areas', content_rowid='area_code', tokenize='${FTS_TOKENIZER}'
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item, content='items', content_rowid='id', tokenize='${FTS_TOKENIZER}'
);
CREATE VIRTUAL TABLE IF NOT EXISTS elements_fts USING fts5(
  element, content='elements', content_rowid='element_code', tokenize='${FTS_TOKENIZER}'
);
`;

/** Classify an area code as an individual country or an aggregate region. */
export function classifyArea(areaCode: number): AreaKind {
  return isAggregateAreaCode(areaCode) ? 'aggregate' : 'country';
}

/**
 * The distinct search tokens of a query, in first-seen order: FTS5's quote,
 * grouping, and prefix characters and every control character become separators,
 * then the rest splits on whitespace. A control character must never reach FTS5 —
 * a NUL ends its query string mid-phrase. A repeated token adds nothing to an AND
 * of prefix terms, so each is searched once.
 */
function searchTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/["()*\p{Cc}]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean),
    ),
  ];
}

/** Search terms per FTS5 statement; keeps search time linear in the query's length. */
const FTS_GROUP_TERMS = 64;

/**
 * Escape a query for FTS5 MATCH: each search token wrapped in double quotes (so
 * punctuation in the term is treated literally) with `*` appended for prefix
 * matching, in groups of at most {@link FTS_GROUP_TERMS} terms, each group one MATCH
 * string. A row matches the query when it matches every group. Empty when no token
 * survives: such a search matches nothing.
 */
function toFtsMatchGroups(query: string): string[] {
  const terms = searchTokens(query).map((t) => `"${t}"*`);
  const groups: string[] = [];
  for (let i = 0; i < terms.length; i += FTS_GROUP_TERMS)
    groups.push(terms.slice(i, i + FTS_GROUP_TERMS).join(' '));
  return groups;
}

/** How a search tool reads its full-text query once no exact selector wins. */
export type SearchQuery =
  /** Absent, blank, whitespace-only, or exactly `*` after trimming: read as omitted. */
  | { kind: 'omitted' }
  /** Every other character is a quote, parenthesis, or asterisk: no search term was given. */
  | { kind: 'invalid'; query: string }
  /** Searched as given, with control characters read as separators. */
  | { kind: 'search'; query: string };

/**
 * The one rule `faostat_resolve_codes` reads `query` by, and
 * `faostat_commodity_profile` reads `item_query` by, whenever no exact selector
 * wins (#67). A value made only of FTS5's quote, grouping, and prefix characters
 * and whitespace is invalid rather than read as omitted, so the caller learns its
 * query was never run. Anything else searches: a value that leaves no word the index
 * holds (`?`, `-`, a lone control character) matches nothing.
 */
export function classifySearchQuery(query: string | undefined): SearchQuery {
  if (query === undefined) return { kind: 'omitted' };
  const trimmed = query.trim();
  if (trimmed === '' || trimmed === '*') return { kind: 'omitted' };
  if (/^[\s"()*]*$/u.test(trimmed)) return { kind: 'invalid', query };
  return { kind: 'search', query };
}

/**
 * A caller's text as notices and error messages name it: JSON-quoted, with DEL and
 * the C1 controls escaped as well, so no control character reaches the response
 * text. A plain word reads as itself in double quotes (`"wheat"`).
 */
export function quoteSearchText(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** A configured table's column/FTS metadata for the generic resolve query. */
interface DimensionConfig {
  codeColumn: string;
  ftsTable: string;
  labelColumn: string;
  table: string;
}

const DIMENSION_CONFIG: Record<DimensionKind, DimensionConfig> = {
  area: { table: 'areas', ftsTable: 'areas_fts', codeColumn: 'area_code', labelColumn: 'area' },
  item: { table: 'items', ftsTable: 'items_fts', codeColumn: 'item_code', labelColumn: 'item' },
  element: {
    table: 'elements',
    ftsTable: 'elements_fts',
    codeColumn: 'element_code',
    labelColumn: 'element',
  },
};

/**
 * The shared dimension store. Lazy-opens the SQLite handle on first use. Owns
 * upserts (called from the ingester) and the resolve queries (called from the
 * tool). FTS5 external-content tables are kept in sync by explicit delete+insert
 * in {@link DimensionsStore.upsertAreas} et al. — simpler than triggers for a
 * small, infrequently-rewritten reference set.
 */
export class DimensionsStore {
  private handle: SqliteHandle | undefined;

  constructor(private readonly dir: string) {}

  private async open(): Promise<SqliteHandle> {
    if (!this.handle) {
      const handle = await openSqliteHandle(join(this.dir, DIMENSIONS_DB_FILE));
      try {
        const oldItems = handle.prepare<{ name: string }>('PRAGMA table_info(items)').all();
        if (oldItems.length && !oldItems.some((c) => c.name === 'id')) {
          handle.transaction(() => {
            handle.exec(`DROP TABLE IF EXISTS items_fts;
            ALTER TABLE items RENAME TO items_legacy;
            CREATE TABLE items (id INTEGER PRIMARY KEY, item_code INTEGER UNIQUE, item_code_text TEXT UNIQUE, cpc_code TEXT, item TEXT NOT NULL);
            INSERT INTO items (id, item_code, cpc_code, item) SELECT item_code, item_code, cpc_code, item FROM items_legacy;
            DROP TABLE items_legacy;`);
            handle.exec(SCHEMA_SQL);
            handle.exec("INSERT INTO items_fts(items_fts) VALUES ('rebuild')");
          });
        }
        handle.exec(SCHEMA_SQL);
        this.handle = handle;
      } catch (error) {
        handle.close();
        throw error;
      }
    }
    return this.handle;
  }

  /** Upsert area records and refresh their FTS rows. */
  async upsertAreas(records: AreaRecord[]): Promise<void> {
    if (records.length === 0) return;
    const h = await this.open();
    h.transaction(() => {
      const upsert = h.prepare(
        `INSERT INTO areas (area_code, area_m49, area, kind) VALUES (?, ?, ?, ?)
         ON CONFLICT(area_code) DO UPDATE SET area_m49=excluded.area_m49, area=excluded.area, kind=excluded.kind`,
      );
      const ftsDel = h.prepare(
        `INSERT INTO areas_fts(areas_fts, rowid, area) VALUES('delete', ?, ?)`,
      );
      const ftsIns = h.prepare(`INSERT INTO areas_fts(rowid, area) VALUES (?, ?)`);
      for (const r of records) {
        const existing = h
          .prepare<{ area: string }>(`SELECT area FROM areas WHERE area_code = ?`)
          .get(r.area_code);
        if (existing) ftsDel.run(r.area_code, existing.area);
        upsert.run(r.area_code, r.area_m49, r.area, r.kind);
        ftsIns.run(r.area_code, r.area);
      }
    });
  }

  /** Upsert item records and refresh their FTS rows. */
  async upsertItems(records: ItemRecord[]): Promise<void> {
    if (records.length === 0) return;
    const h = await this.open();
    h.transaction(() => {
      const upsert = h.prepare(
        `INSERT INTO items (item_code, item_code_text, cpc_code, item) VALUES (?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET cpc_code=excluded.cpc_code, item=excluded.item`,
      );
      const ftsDel = h.prepare(
        `INSERT INTO items_fts(items_fts, rowid, item) VALUES('delete', ?, ?)`,
      );
      const ftsIns = h.prepare(`INSERT INTO items_fts(rowid, item) VALUES (?, ?)`);
      for (const r of records) {
        const existing = h
          .prepare<{ id: number; item: string }>(
            `SELECT id, item FROM items WHERE item_code = ? OR item_code_text = ?`,
          )
          .get(r.item_code, r.item_code_text);
        if (existing) ftsDel.run(existing.id, existing.item);
        upsert.run(r.item_code, r.item_code_text, r.cpc_code, r.item);
        const inserted = h
          .prepare<{ id: number }>('SELECT id FROM items WHERE item_code = ? OR item_code_text = ?')
          .get(r.item_code, r.item_code_text);
        if (!inserted) throw new Error('Item upsert did not persist its exact identity.');
        ftsIns.run(inserted.id, r.item);
      }
    });
  }

  /**
   * Add item records only where no row holds their identity — the items a domain's
   * data rows name that its item list lacks (#64). A row already present keeps its
   * label and CPC code, whichever domain's list or rows supplied it, so a list entry
   * ({@link upsertItems}) always wins over a data-derived one. Each added row gets its
   * FTS row in the same transaction. Returns how many rows it added.
   */
  async addMissingItems(records: ItemRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const h = await this.open();
    return h.transaction(() => {
      const insert = h.prepare(
        `INSERT INTO items (item_code, item_code_text, cpc_code, item) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      );
      const ftsIns = h.prepare(`INSERT INTO items_fts(rowid, item) VALUES (?, ?)`);
      let added = 0;
      for (const r of records) {
        const { changes, lastInsertRowid } = insert.run(
          r.item_code,
          r.item_code_text,
          r.cpc_code,
          r.item,
        );
        if (changes === 0) continue;
        ftsIns.run(Number(lastInsertRowid), r.item);
        added++;
      }
      return added;
    });
  }

  /**
   * The item identities in `codes` that no item row holds. A number is an
   * `item_code`, a string an `item_code_text`, as {@link resolve}'s `domainCodes`
   * carries them.
   */
  async missingItemIdentities(codes: (number | string)[]): Promise<(number | string)[]> {
    if (codes.length === 0) return [];
    const h = await this.open();
    const held = new Set<number | string>();
    for (const row of h
      .prepare<{ item_code: number | null; item_code_text: string | null }>(
        'SELECT item_code, item_code_text FROM items',
      )
      .all()) {
      if (row.item_code !== null) held.add(row.item_code);
      if (row.item_code_text !== null) held.add(row.item_code_text);
    }
    return codes.filter((code) => !held.has(code));
  }

  /** Upsert element records and refresh their FTS rows. */
  async upsertElements(records: ElementRecord[]): Promise<void> {
    if (records.length === 0) return;
    const h = await this.open();
    h.transaction(() => {
      const upsert = h.prepare(
        `INSERT INTO elements (element_code, element) VALUES (?, ?)
         ON CONFLICT(element_code) DO UPDATE SET element=excluded.element`,
      );
      const ftsDel = h.prepare(
        `INSERT INTO elements_fts(elements_fts, rowid, element) VALUES('delete', ?, ?)`,
      );
      const ftsIns = h.prepare(`INSERT INTO elements_fts(rowid, element) VALUES (?, ?)`);
      for (const r of records) {
        const existing = h
          .prepare<{ element: string }>(`SELECT element FROM elements WHERE element_code = ?`)
          .get(r.element_code);
        if (existing) ftsDel.run(r.element_code, existing.element);
        upsert.run(r.element_code, r.element);
        ftsIns.run(r.element_code, r.element);
      }
    });
  }

  /** Upsert flag definitions (no FTS — looked up by key). */
  async upsertFlags(records: FlagRecord[]): Promise<void> {
    if (records.length === 0) return;
    const h = await this.open();
    h.transaction(() => {
      const upsert = h.prepare(
        `INSERT INTO flags (flag, description) VALUES (?, ?)
         ON CONFLICT(flag) DO UPDATE SET description=excluded.description`,
      );
      for (const r of records) upsert.run(r.flag, r.description);
    });
  }

  /** True once any area rows exist — the dimension tables are populated. */
  async isPopulated(): Promise<boolean> {
    const h = await this.open();
    const row = h.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM areas`).get();
    return (row?.n ?? 0) > 0;
  }

  /** Look up a flag description by code. */
  async getFlagDescription(flag: string): Promise<string | undefined> {
    const h = await this.open();
    const row = h
      .prepare<{ description: string }>(`SELECT description FROM flags WHERE flag = ?`)
      .get(flag);
    return row?.description;
  }

  /** All flag definitions. */
  async listFlags(): Promise<FlagRecord[]> {
    const h = await this.open();
    return h.prepare<FlagRecord>(`SELECT flag, description FROM flags ORDER BY flag`).all();
  }

  /**
   * The areas whose stored M49 code equals `m49Code` exactly — no padding and no
   * prefix match — in area-code order. Every one is returned: nothing in the schema
   * keeps a code to one area, so a shared code yields each area carrying it.
   */
  async areasByM49(m49Code: string): Promise<ResolvedCode[]> {
    const h = await this.open();
    return h
      .prepare<Record<string, unknown>>('SELECT * FROM areas WHERE area_m49 = ? ORDER BY area_code')
      .all(m49Code)
      .map((row) => this.toResolved('area', row));
  }

  /**
   * Resolve codes within a dimension. Precedence: an exact `code` lookup wins;
   * otherwise a normalized exact label when `preferExact` is set and one or more
   * labels match; otherwise an FTS `query` match (relevance-ranked; no matches when the
   * query leaves no search term); otherwise a `name_contains`
   * substring filter; otherwise list the whole dimension. Returns up to `limit`
   * rows starting at `offset` plus the true total of matches (for truncation
   * disclosure and pagination).
   *
   * `domainCodes` scopes item/element resolution to the codes actually present in
   * a domain's cube (issue #8): the dimension vocabulary is a union across every
   * indexed domain, so an unscoped resolve can surface a code absent from the
   * requested domain. When set, the scope is applied INSIDE each branch — before
   * any LIMIT/offset windowing — so `total` and the paged slice reflect the
   * domain-scoped set, not the global one (this composes with the `offset`/`limit`
   * window layered on top; issue #7). The LIKE and list-all branches scope with a
   * SQL predicate; the FTS branch filters its ranked matches (#36). Undefined means no
   * scoping (areas, whose vocabularies legitimately overlap domains); an empty
   * array is a real scope (the domain has no codes in this dimension) and matches
   * nothing.
   */
  async resolve(
    dimension: DimensionKind,
    opts: {
      code?: number;
      codeText?: string;
      query?: string;
      /** Prefer normalized exact labels across the complete scoped vocabulary. */
      preferExact?: boolean;
      nameContains?: string;
      limit: number;
      offset?: number;
      domainCodes?: (number | string)[];
    },
  ): Promise<{ matches: ResolvedCode[]; total: number }> {
    const h = await this.open();
    const cfg = DIMENSION_CONFIG[dimension];
    const codeColumn =
      dimension === 'item' ? 'COALESCE(item_code, item_code_text)' : cfg.codeColumn;
    const offset = opts.offset ?? 0;
    const { domainCodes } = opts;

    // A domain scope of no codes matches nothing — short-circuit before emitting an
    // invalid empty `IN ()` predicate.
    if (domainCodes && domainCodes.length === 0) return { matches: [], total: 0 };

    // The domain-membership predicate the LIKE and list-all branches filter the code
    // column with. `domainParams` is empty (no-op spread) when unscoped.
    const domainPlaceholders = domainCodes?.map(() => '?').join(', ');
    const domainParams = domainCodes ?? [];

    // Exact code lookup — single row, domain-scoped, never paged.
    const exactCode = opts.codeText ?? opts.code;
    if (exactCode !== undefined) {
      const inDomain = !domainCodes || domainCodes.includes(exactCode);
      const row = inDomain ? this.selectByCode(h, dimension, exactCode) : undefined;
      return { matches: row ? [row] : [], total: row ? 1 : 0 };
    }

    if (opts.preferExact && opts.query) {
      // FAO code lists write `;` where observation rows and most callers write `,`
      // (`Peas; dry` beside `Peas, dry`), so the comparison folds one into the other.
      // A control character separates words, as in the search (#67).
      const normalize = (name: string) =>
        name
          .replace(/\p{Cc}/gu, ' ')
          .trim()
          .split(/\s+/u)
          .join(' ')
          .toLowerCase()
          .replaceAll(';', ',');
      const query = normalize(opts.query);
      const scope = domainCodes && new Set(domainCodes);
      const exact = h
        .prepare<Record<string, unknown>>(`SELECT * FROM ${cfg.table} ORDER BY ${codeColumn}`)
        .all()
        .filter(
          (row) =>
            (!scope || scope.has((row[cfg.codeColumn] ?? row.item_code_text) as number | string)) &&
            normalize(String(row[cfg.labelColumn])) === query,
        );
      if (exact.length > 0) {
        return {
          matches: exact
            .slice(offset, offset + opts.limit)
            .map((row) => this.toResolved(dimension, row)),
          total: exact.length,
        };
      }
    }

    /*
     * FTS relevance match. Every matching rowid is fetched — no SQL LIMIT — and the
     * domain scope filters that list, so `total` is the exact scoped count and the
     * offset/limit window is a JS slice. Rank alone has no tiebreaker, so rowid
     * stabilizes the order across paged calls.
     *
     * The scope never reaches FTS5 as a `rowid` constraint beside MATCH (#36). FTS5
     * claims `rowid = ?` so the core never re-checks it, then honors the bound value
     * only when it is INTEGER. better-sqlite3 binds every JS number as REAL, and a
     * one-code `rowid IN (?)` is rewritten to `rowid = ?`, so under Node the scope
     * was silently dropped and every match came back.
     *
     * A query that leaves no search term matches nothing (#67): it never falls
     * through to the substring filter or the listing.
     */
    if (opts.query !== undefined) {
      const scope = domainCodes && new Set(domainCodes);
      const byRowid = h.prepare<Record<string, unknown>>(
        `SELECT * FROM ${cfg.table} WHERE ${dimension === 'item' ? 'id' : cfg.codeColumn} = ?`,
      );
      const ids = this.ftsRowids(h, cfg.ftsTable, toFtsMatchGroups(opts.query))
        .map((rowid) => byRowid.get(rowid))
        .filter((r): r is Record<string, unknown> => r !== undefined)
        .filter(
          (r) => !scope || scope.has((r[cfg.codeColumn] ?? r.item_code_text) as number | string),
        );
      const total = ids.length;
      const matches = ids
        .slice(offset, offset + opts.limit)
        .map((row) => this.toResolved(dimension, row));
      return { matches, total };
    }

    // Substring filter (LIKE).
    if (opts.nameContains) {
      const like = `%${opts.nameContains.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const filter = `${cfg.labelColumn} LIKE ? ESCAPE '\\'${
        domainPlaceholders ? ` AND ${codeColumn} IN (${domainPlaceholders})` : ''
      }`;
      const total =
        h
          .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${cfg.table} WHERE ${filter}`)
          .get(like, ...domainParams)?.n ?? 0;
      const rows = h
        .prepare<Record<string, unknown>>(
          `SELECT * FROM ${cfg.table} WHERE ${filter} ORDER BY ${codeColumn} LIMIT ? OFFSET ?`,
        )
        .all(like, ...domainParams, opts.limit, offset);
      return { matches: rows.map((r) => this.toResolved(dimension, r)), total };
    }

    // List all.
    const whereSql = domainPlaceholders ? ` WHERE ${codeColumn} IN (${domainPlaceholders})` : '';
    const total =
      h
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${cfg.table}${whereSql}`)
        .get(...domainParams)?.n ?? 0;
    const rows = h
      .prepare<Record<string, unknown>>(
        `SELECT * FROM ${cfg.table}${whereSql} ORDER BY ${codeColumn} LIMIT ? OFFSET ?`,
      )
      .all(...domainParams, opts.limit, offset);
    return { matches: rows.map((r) => this.toResolved(dimension, r)), total };
  }

  /**
   * The rowids of `ftsTable` that match every MATCH group, ordered by rank, then
   * rowid. A single group runs as one statement. Otherwise each group runs as its
   * own statement, keeping only the rows every group so far matched and stopping at
   * the first group that leaves none; a kept row's rank is the sum of its group
   * ranks. FTS5's bm25 sums per-phrase scores, so that is the rank one statement over
   * every term would give it, up to floating-point rounding. Search time is linear in
   * the query's length. No groups → no rows.
   */
  private ftsRowids(h: SqliteHandle, ftsTable: string, groups: string[]): number[] {
    const [first, ...rest] = groups;
    if (first === undefined) return [];
    if (rest.length === 0) {
      return h
        .prepare<{ rowid: number }>(
          `SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ? ORDER BY rank, rowid`,
        )
        .all(first)
        .map((r) => r.rowid);
    }
    const ranked = h.prepare<{ rowid: number; rank: number }>(
      `SELECT rowid, rank FROM ${ftsTable} WHERE ${ftsTable} MATCH ?`,
    );
    let ranks = new Map(ranked.all(first).map((r) => [r.rowid, r.rank]));
    for (const group of rest) {
      if (ranks.size === 0) break;
      const kept = new Map<number, number>();
      for (const r of ranked.all(group)) {
        const rank = ranks.get(r.rowid);
        if (rank !== undefined) kept.set(r.rowid, rank + r.rank);
      }
      ranks = kept;
    }
    return [...ranks]
      .sort(([rowidA, rankA], [rowidB, rankB]) => rankA - rankB || rowidA - rowidB)
      .map(([rowid]) => rowid);
  }

  private selectByCode(
    h: SqliteHandle,
    dimension: DimensionKind,
    code: number | string,
  ): ResolvedCode | undefined {
    const cfg = DIMENSION_CONFIG[dimension];
    const row = h
      .prepare<Record<string, unknown>>(
        `SELECT * FROM ${cfg.table} WHERE ${dimension === 'item' && typeof code === 'string' ? 'item_code_text' : cfg.codeColumn} = ?`,
      )
      .get(code);
    return row ? this.toResolved(dimension, row) : undefined;
  }

  private toResolved(dimension: DimensionKind, row: Record<string, unknown>): ResolvedCode {
    if (dimension === 'area') {
      const code = Number(row.area_code);
      return {
        code,
        code_text: null,
        name: String(row.area),
        // Derive kind at read time from the code, not the stored `kind` column:
        // mirrors ingested before the deny-set fix persisted the old classification,
        // so recomputing here corrects them with no re-sync (issue #4).
        kind: isAggregateAreaCode(code) ? 'aggregate' : 'country',
        ...(row.area_m49 == null ? {} : { m49_code: String(row.area_m49) }),
      };
    }
    if (dimension === 'item') {
      const cpc = row.cpc_code == null ? undefined : String(row.cpc_code);
      return {
        code: row.item_code === null ? null : Number(row.item_code),
        code_text: row.item_code_text == null ? null : String(row.item_code_text),
        name: String(row.item),
        kind: null,
        ...(cpc !== undefined ? { cpc_code: cpc } : {}),
      };
    }
    return {
      code: Number(row.element_code),
      code_text: null,
      name: String(row.element),
      kind: null,
    };
  }

  close(): Promise<void> {
    this.handle?.close();
    this.handle = undefined;
    return Promise.resolve();
  }
}
