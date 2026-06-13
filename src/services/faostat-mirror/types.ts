/**
 * @fileoverview Domain types for the FAOSTAT bulk-download mirror — manifest
 * shapes, the normalized per-domain observation row, dimension code records, and
 * the aggregate-code boundary constant.
 * @module services/faostat-mirror/types
 */

/**
 * Aggregate area-code boundary. FAOSTAT mixes individual countries (codes 2–351)
 * and aggregate regions (World, continents, economic groupings) in the same
 * `area` dimension; aggregate codes are exactly `>= 5000` (no country code
 * reaches 5000 — largest confirmed is China=351). Used to classify country vs
 * aggregate and to exclude aggregates from naive sums by default.
 */
export const AGGREGATE_AREA_CODE_THRESHOLD = 5000;

/** One dataset entry in the bulk manifest (`datasets_E.json`). */
export interface ManifestDataset {
  CompressionFormat?: string;
  Contact?: string;
  DatasetCode: string;
  DatasetDescription?: string;
  DatasetName: string;
  DateUpdate: string;
  Email?: string;
  /** Canonical ZIP URL for the domain. */
  FileLocation: string;
  /** Row count — a JSON number in the live manifest (e.g. `413211`), though some
   * historical dumps quote it; parse defensively for both. */
  FileRows?: number | string;
  /** Size string with units, e.g. `"33127KB"` — not a number. */
  FileSize?: number | string;
  FileType?: string;
  Topic?: string;
}

/**
 * The manifest JSON shape. `Datasets` carries an XML-to-JSON artifact sibling key
 * (`"-xmlns:xsi"`) alongside `Dataset`; access `Datasets.Dataset` directly.
 */
export interface ManifestResponse {
  Datasets: {
    Dataset: ManifestDataset[];
  };
}

/**
 * One normalized observation row, as stored in a per-domain mirror table. Mirror
 * columns are `string | number | null` only (the SqliteHandle value domain).
 */
export interface ObservationRow {
  area: string;
  area_code: number;
  /** M49 numeric code with the leading apostrophe stripped, or null. */
  area_m49: string | null;
  element: string;
  element_code: number;
  flag: string | null;
  /** Synthetic primary key: `area|item|element|year`. */
  id: string;
  item: string;
  item_code: number;
  note: string | null;
  unit: string | null;
  value: number | null;
  year: number;
}

/** Dimension kinds resolvable via `faostat_resolve_codes`. */
export type DimensionKind = 'area' | 'item' | 'element';

/** Country-vs-aggregate classification for an area code. */
export type AreaKind = 'country' | 'aggregate';

/** One area code record in the shared `areas` dimension table. */
export interface AreaRecord {
  area: string;
  area_code: number;
  area_m49: string | null;
  kind: AreaKind;
}

/** One item code record in the shared `items` dimension table. */
export interface ItemRecord {
  /** CPC crosswalk code with the leading apostrophe stripped, or null. */
  cpc_code: string | null;
  item: string;
  item_code: number;
}

/** One element code record in the shared `elements` dimension table. */
export interface ElementRecord {
  element: string;
  element_code: number;
}

/** One flag definition in the shared `flags` dimension table. */
export interface FlagRecord {
  description: string;
  flag: string;
}

/** The dimension a resolve query targets, plus the SQLite column it filters. */
export interface ResolvedCode {
  /** The opaque integer code. */
  code: number;
  /** CPC crosswalk code for items; absent otherwise. */
  cpc_code?: string;
  /** Country vs aggregate for areas; null for items/elements. */
  kind: AreaKind | null;
  /** The human-readable label. */
  name: string;
}
