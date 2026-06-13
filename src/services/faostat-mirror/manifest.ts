/**
 * @fileoverview Fetches and normalizes the FAOSTAT bulk manifest
 * (`datasets_E.json`) — the machine-readable catalog of all ~68 domains with
 * codes, descriptions, update dates, row counts, and ZIP URLs. Backs
 * `faostat_list_domains` and the ingester's per-domain ZIP discovery.
 * @module services/faostat-mirror/manifest
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { FAOSTAT_USER_AGENT } from './http.js';
import type { ManifestDataset, ManifestResponse } from './types.js';

/** Canonical manifest filename (lowercase — the capitalized variant 403s). */
const MANIFEST_FILE = 'datasets_E.json';

/**
 * Parse a `FileSize` value into bytes; null when absent/unparseable. The live
 * manifest emits a units string (`"33127KB"`, `"271MB"`); a bare number is taken
 * as bytes.
 */
export function parseFileSizeBytes(fileSize: number | string | undefined): number | null {
  if (fileSize == null) return null;
  if (typeof fileSize === 'number') return Number.isFinite(fileSize) ? Math.round(fileSize) : null;
  const match = /^([\d.]+)\s*(KB|MB|GB|B)?$/i.exec(fileSize.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (match[2] ?? 'B').toUpperCase();
  const mult = unit === 'GB' ? 1e9 : unit === 'MB' ? 1e6 : unit === 'KB' ? 1e3 : 1;
  return Math.round(n * mult);
}

/**
 * Parse a `FileRows` value into a number; null when absent/unparseable. The live
 * manifest emits a JSON number (`413211`); a quoted string is also accepted.
 */
export function parseFileRows(fileRows: number | string | undefined): number | null {
  if (fileRows == null) return null;
  const n = typeof fileRows === 'number' ? fileRows : Number(fileRows.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch and parse the bulk manifest. Retries transient failures with a calibrated
 * backoff (the service is occasionally slow/degraded). Returns the full dataset
 * array, unmodified. `signal` cancels the fetch and the retry loop.
 */
export function fetchManifest(baseUrl: string, signal: AbortSignal): Promise<ManifestDataset[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/${MANIFEST_FILE}`;
  return withRetry(
    async () => {
      const response = await fetch(url, {
        signal,
        headers: { 'User-Agent': FAOSTAT_USER_AGENT },
      });
      if (!response.ok) {
        throw serviceUnavailable(`FAOSTAT manifest fetch failed (HTTP ${response.status})`, {
          url,
          status: response.status,
        });
      }
      const json = (await response.json()) as ManifestResponse;
      const datasets = json?.Datasets?.Dataset;
      if (!Array.isArray(datasets)) {
        throw serviceUnavailable(
          'FAOSTAT manifest missing Datasets.Dataset array — upstream format changed.',
          { url },
        );
      }
      return datasets;
    },
    { operation: 'fetchFaostatManifest', baseDelayMs: 1500, signal },
  );
}

/** Find one dataset by code (case-insensitive). */
export function findDataset(
  datasets: ManifestDataset[],
  code: string,
): ManifestDataset | undefined {
  const upper = code.toUpperCase();
  return datasets.find((d) => d.DatasetCode.toUpperCase() === upper);
}
