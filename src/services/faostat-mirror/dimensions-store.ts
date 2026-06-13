/**
 * @fileoverview Shared dimension store — `areas`, `items`, `elements`, `flags`
 * tables populated from each domain ZIP's bundled code-list CSVs, plus FTS5
 * indexes over the labels that drive `faostat_resolve_codes`. Owned directly via
 * the framework's runtime-agnostic SQLite handle (not a per-table MirrorService,
 * which is one-table-per-store): dimensions are reference vocabularies shared
 * across every domain, upserted opportunistically during each domain sync.
 * @module services/faostat-mirror/dimensions-store
 */

import { join } from 'node:path';
import { openSqliteHandle, type SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import {
  AGGREGATE_AREA_CODE_THRESHOLD,
  type AreaKind,
  type AreaRecord,
  type DimensionKind,
  type ElementRecord,
  type FlagRecord,
  type ItemRecord,
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
  item_code INTEGER PRIMARY KEY NOT NULL,
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
  item, content='items', content_rowid='item_code', tokenize='${FTS_TOKENIZER}'
);
CREATE VIRTUAL TABLE IF NOT EXISTS elements_fts USING fts5(
  element, content='elements', content_rowid='element_code', tokenize='${FTS_TOKENIZER}'
);
`;

/** Classify an area code as an individual country or an aggregate region. */
export function classifyArea(areaCode: number): AreaKind {
  return areaCode >= AGGREGATE_AREA_CODE_THRESHOLD ? 'aggregate' : 'country';
}

/**
 * Escape an FTS5 MATCH query: wrap each whitespace-separated token in double
 * quotes (so punctuation in the term is treated literally) and append `*` for
 * prefix matching. Empty after normalization → undefined (caller lists instead).
 */
export function toFtsMatch(query: string): string | undefined {
  const tokens = query
    .toLowerCase()
    .replace(/["()*]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return;
  return tokens.map((t) => `"${t}"*`).join(' ');
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
      this.handle = await openSqliteHandle(join(this.dir, DIMENSIONS_DB_FILE));
      this.handle.exec(SCHEMA_SQL);
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
        `INSERT INTO items (item_code, cpc_code, item) VALUES (?, ?, ?)
         ON CONFLICT(item_code) DO UPDATE SET cpc_code=excluded.cpc_code, item=excluded.item`,
      );
      const ftsDel = h.prepare(
        `INSERT INTO items_fts(items_fts, rowid, item) VALUES('delete', ?, ?)`,
      );
      const ftsIns = h.prepare(`INSERT INTO items_fts(rowid, item) VALUES (?, ?)`);
      for (const r of records) {
        const existing = h
          .prepare<{ item: string }>(`SELECT item FROM items WHERE item_code = ?`)
          .get(r.item_code);
        if (existing) ftsDel.run(r.item_code, existing.item);
        upsert.run(r.item_code, r.cpc_code, r.item);
        ftsIns.run(r.item_code, r.item);
      }
    });
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
   * Resolve codes within a dimension. Precedence: an exact `code` lookup wins;
   * otherwise an FTS `query` match (relevance-ranked); otherwise a `name_contains`
   * substring filter; otherwise list the whole dimension. Returns up to `limit`
   * rows plus the true total of matches (for truncation disclosure).
   */
  async resolve(
    dimension: DimensionKind,
    opts: { code?: number; query?: string; nameContains?: string; limit: number },
  ): Promise<{ matches: ResolvedCode[]; total: number }> {
    const h = await this.open();
    const cfg = DIMENSION_CONFIG[dimension];

    // Exact code lookup.
    if (opts.code !== undefined) {
      const row = this.selectByCode(h, dimension, opts.code);
      return { matches: row ? [row] : [], total: row ? 1 : 0 };
    }

    // FTS relevance match.
    const ftsMatch = opts.query ? toFtsMatch(opts.query) : undefined;
    if (ftsMatch) {
      const ids = h
        .prepare<{ rowid: number }>(
          `SELECT rowid FROM ${cfg.ftsTable} WHERE ${cfg.ftsTable} MATCH ? ORDER BY rank`,
        )
        .all(ftsMatch)
        .map((r) => r.rowid);
      const total = ids.length;
      const matches = ids
        .slice(0, opts.limit)
        .map((id) => this.selectByCode(h, dimension, id))
        .filter((r): r is ResolvedCode => r !== undefined);
      return { matches, total };
    }

    // Substring filter (LIKE).
    if (opts.nameContains) {
      const like = `%${opts.nameContains.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const total =
        h
          .prepare<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${cfg.table} WHERE ${cfg.labelColumn} LIKE ? ESCAPE '\\'`,
          )
          .get(like)?.n ?? 0;
      const rows = h
        .prepare<Record<string, unknown>>(
          `SELECT * FROM ${cfg.table} WHERE ${cfg.labelColumn} LIKE ? ESCAPE '\\' ORDER BY ${cfg.codeColumn} LIMIT ?`,
        )
        .all(like, opts.limit);
      return { matches: rows.map((r) => this.toResolved(dimension, r)), total };
    }

    // List all.
    const total = h.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${cfg.table}`).get()?.n ?? 0;
    const rows = h
      .prepare<Record<string, unknown>>(
        `SELECT * FROM ${cfg.table} ORDER BY ${cfg.codeColumn} LIMIT ?`,
      )
      .all(opts.limit);
    return { matches: rows.map((r) => this.toResolved(dimension, r)), total };
  }

  private selectByCode(
    h: SqliteHandle,
    dimension: DimensionKind,
    code: number,
  ): ResolvedCode | undefined {
    const cfg = DIMENSION_CONFIG[dimension];
    const row = h
      .prepare<Record<string, unknown>>(`SELECT * FROM ${cfg.table} WHERE ${cfg.codeColumn} = ?`)
      .get(code);
    return row ? this.toResolved(dimension, row) : undefined;
  }

  private toResolved(dimension: DimensionKind, row: Record<string, unknown>): ResolvedCode {
    if (dimension === 'area') {
      return {
        code: Number(row.area_code),
        name: String(row.area),
        kind: (row.kind as AreaKind) ?? null,
      };
    }
    if (dimension === 'item') {
      const cpc = row.cpc_code == null ? undefined : String(row.cpc_code);
      return {
        code: Number(row.item_code),
        name: String(row.item),
        kind: null,
        ...(cpc !== undefined ? { cpc_code: cpc } : {}),
      };
    }
    return { code: Number(row.element_code), name: String(row.element), kind: null };
  }

  close(): Promise<void> {
    this.handle?.close();
    this.handle = undefined;
    return Promise.resolve();
  }
}
