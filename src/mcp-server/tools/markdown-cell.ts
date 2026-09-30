/**
 * @fileoverview Markdown table-cell escaping shared by every tool `format()` that
 * interpolates values into a table row — `faostat_dataframe_query`,
 * `faostat_query_observations`, and the production-trend table of
 * `faostat_commodity_profile`.
 * @module mcp-server/tools/markdown-cell
 */

/**
 * Render one result value as a Markdown table cell.
 *
 * Order is load-bearing: backslashes are doubled BEFORE pipes are escaped. Escaping
 * `|` alone turns a value's own `\` before a pipe into `\\|`, which a renderer reads
 * as a literal backslash plus an UNESCAPED cell separator — the row splits at a
 * value-controlled point and every later column shifts. Doubling first keeps the
 * separator escaped and the original backslash intact. CR and LF become their escape
 * sequences for the same reason: a raw newline ends the table row outright.
 *
 * Values reach here straight from DuckDB or the mirror, so their content is whatever
 * the source rows hold — FAOSTAT's own labels included, which change with each
 * refresh. `structuredContent` carries them unescaped; this is the `content[]` twin.
 */
export function markdownCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}
