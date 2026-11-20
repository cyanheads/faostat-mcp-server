/**
 * @fileoverview Exact-label and full-text dimension lookup on a SQLite handle.
 * Type-only imports let the read worker load this from source and compiled output.
 */
import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import type { DimensionKind } from './types.js';

/** A configured table's column/FTS metadata for the generic resolve query. */
interface DimensionConfig {
  codeColumn: string;
  ftsTable: string;
  labelColumn: string;
  table: string;
}

/** Table, code and label metadata for each dimension. */
export const DIMENSION_CONFIG: Record<DimensionKind, DimensionConfig> = {
  area: { table: 'areas', ftsTable: 'areas_fts', codeColumn: 'area_code', labelColumn: 'area' },
  item: { table: 'items', ftsTable: 'items_fts', codeColumn: 'item_code', labelColumn: 'item' },
  element: {
    table: 'elements',
    ftsTable: 'elements_fts',
    codeColumn: 'element_code',
    labelColumn: 'element',
  },
};

/** Input for a text lookup against the shared dimensions database. */
export interface DimensionSearchOptions {
  domainCodes?: (number | string)[];
  limit: number;
  offset?: number;
  preferExact?: boolean;
  query: string;
}

/** Search page and exact total before pagination. */
export interface DimensionSearchResult {
  rows: Record<string, unknown>[];
  total: number;
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

/**
 * The rowids of `ftsTable` that match every MATCH group, ordered by rank, then
 * rowid. A single group runs as one statement. Otherwise each group runs as its
 * own statement, keeping only the rows every group so far matched and stopping at
 * the first group that leaves none; a kept row's rank is the sum of its group
 * ranks. FTS5's bm25 sums per-phrase scores, so that is the rank one statement over
 * every term would give it, up to floating-point rounding. Search time is linear in
 * the query's length. No groups → no rows.
 */
function ftsRowids(h: SqliteHandle, ftsTable: string, groups: string[]): number[] {
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

/** Resolve a text query against a read-only dimension connection. */
export function searchDimension(
  h: SqliteHandle,
  dimension: DimensionKind,
  opts: DimensionSearchOptions,
): DimensionSearchResult {
  const cfg = DIMENSION_CONFIG[dimension];
  const codeColumn = dimension === 'item' ? 'COALESCE(item_code, item_code_text)' : cfg.codeColumn;
  const { domainCodes, offset = 0 } = opts;
  const scope = domainCodes && new Set(domainCodes);
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
        rows: exact.slice(offset, offset + opts.limit),
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
  const byRowid = h.prepare<Record<string, unknown>>(
    `SELECT * FROM ${cfg.table} WHERE ${dimension === 'item' ? 'id' : cfg.codeColumn} = ?`,
  );
  const ids = ftsRowids(h, cfg.ftsTable, toFtsMatchGroups(opts.query))
    .map((rowid) => byRowid.get(rowid))
    .filter((r): r is Record<string, unknown> => r !== undefined)
    .filter((r) => !scope || scope.has((r[cfg.codeColumn] ?? r.item_code_text) as number | string));
  const total = ids.length;
  return { rows: ids.slice(offset, offset + opts.limit), total };
}
