/**
 * @fileoverview Fetches and normalizes the FAOSTAT bulk manifest
 * (`datasets_E.json`) — the machine-readable catalog of all ~68 domains with
 * codes, descriptions, update dates, row counts, and ZIP URLs. Backs
 * `faostat_list_domains` and the ingester's per-domain ZIP discovery.
 * @module services/faostat-mirror/manifest
 */

import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { FAOSTAT_BULK_SERVICE, FAOSTAT_USER_AGENT } from './http.js';
import type { ManifestDataset, ManifestResponse } from './types.js';

/** Canonical manifest filename (lowercase — the capitalized variant 403s). */
const MANIFEST_FILE = 'datasets_E.json';

/**
 * Recovery for a manifest status that retrying cannot change. The base URL is
 * operator configuration, so the hint names the setting rather than echoing its
 * value onto a client-visible error.
 */
const BASE_URL_HINT =
  'Retrying will not help. Check that FAOSTAT_BULK_BASE_URL points at the FAOSTAT bulk-download base that serves datasets_E.json (default https://bulks-faostat.fao.org/production); the FAO bulk host answers a wrong path with HTTP 403.';

/**
 * Map a non-2xx manifest response to its status-classified error. Only a status
 * `withRetry` treats as transient (408, 425, 429, 5xx other than 501) re-enters
 * the backoff; anything else fails on this request with {@link BASE_URL_HINT}.
 */
async function manifestStatusError(response: Response): Promise<McpError> {
  const error = await httpErrorFromResponse(response, { service: FAOSTAT_BULK_SERVICE });
  if (defaultIsTransient(error)) return error;
  return new McpError(error.code, error.message, {
    ...error.data,
    recovery: { hint: BASE_URL_HINT },
  });
}

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
 * backoff (the service is occasionally slow/degraded); a permanent status fails on
 * the first request. Returns the full dataset array, unmodified. `signal` cancels
 * the fetch and the retry loop.
 */
export function fetchManifest(baseUrl: string, signal: AbortSignal): Promise<ManifestDataset[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/${MANIFEST_FILE}`;
  return withRetry(
    async () => {
      const response = await fetch(url, {
        signal,
        headers: { 'User-Agent': FAOSTAT_USER_AGENT },
      });
      if (!response.ok) throw await manifestStatusError(response);
      const json = (await response.json()) as ManifestResponse;
      const datasets = json?.Datasets?.Dataset;
      if (!Array.isArray(datasets)) {
        throw serviceUnavailable(
          'FAOSTAT manifest missing Datasets.Dataset array — upstream format changed.',
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
