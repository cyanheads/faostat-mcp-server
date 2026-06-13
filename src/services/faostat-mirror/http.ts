/**
 * @fileoverview Shared HTTP constants for the FAOSTAT bulk-download fetches.
 * The FAO bulk host (`bulks-faostat.fao.org`) sits behind a WAF that rejects
 * requests with an absent/empty `User-Agent` (HTTP 403). Node's default fetch UA
 * happens to pass today, but an identifying UA is both correct etiquette for a
 * public bulk service and insurance against the WAF tightening to block generic
 * runtime UAs. Sent on the manifest fetch and every per-domain ZIP download.
 * @module services/faostat-mirror/http
 */

/** Identifying User-Agent for FAOSTAT bulk-service requests. */
export const FAOSTAT_USER_AGENT =
  'faostat-mcp-server (+https://github.com/cyanheads/faostat-mcp-server)';
