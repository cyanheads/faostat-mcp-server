/**
 * @fileoverview `faostat_dataframe_query` — runs a single-statement read-only
 * SELECT against the canvas tables staged by faostat_query_observations and
 * faostat_commodity_profile. The framework SQL gate enforces read-only
 * (single SELECT, no DDL/DML/file functions); system catalogs are denied so a
 * caller can't enumerate every staged handle.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { canvasEnabled, queryStaged } from '@/services/canvas-staging.js';

export const dataframeQueryTool = tool('faostat_dataframe_query', {
  title: 'faostat-mcp-server: dataframe query',
  description:
    'Run a single-statement SELECT against the canvas tables staged by faostat_query_observations and faostat_commodity_profile (table names look like faostat_xxxxxxxx). Use this for cross-country and cross-item aggregation, GROUP BY rankings, joins, and time-series analysis over the full result set the inline preview only sampled. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all work. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected; system catalogs (information_schema, sqlite_master, duckdb_*) are denied — list staged tables via faostat_dataframe_describe. Every row carries its data-quality `flag` (A=Official, E=Estimated, I=Imputed, …) — keep it in projections and honor it in interpretation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the query returned no rows or when results were capped.'),
  },

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable SQL on staged results.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL references a faostat_<id> table that has expired or was never staged.',
      recovery:
        'Call faostat_dataframe_describe to list staged tables, or re-run the query that staged the data.',
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL references a denied system catalog (information_schema, sqlite_master, duckdb_*).',
      recovery: 'Query only faostat_<id> tables. Use faostat_dataframe_describe to list them.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL has a syntax or execution error, or is not a single read-only SELECT.',
      recovery:
        'Use one read-only SELECT and verify column/table names against faostat_dataframe_describe.',
    },
  ],

  input: z.object({
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional canvas ID from a prior faostat_query_observations / faostat_commodity_profile call. Omit to query the tables staged in this session (the common case).',
      ),
    sql: z
      .string()
      .min(1)
      .describe(
        'Single-statement read-only SELECT against staged faostat_<id> tables. Columns: area_code, area, item_code, item, element_code, element, year, unit, value, flag. CAST(value AS DOUBLE) for arithmetic.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000)
      .describe('Hard cap on rows in the response. Default 1000, max 10000.'),
  }),

  output: z.object({
    columns: z.array(z.string()).describe('Column names in projection order.'),
    row_count: z
      .number()
      .describe('Total rows the query produced (may exceed rows.length when capped).'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Materialized result rows, bounded by row_limit.'),
  }),

  async handler(input, ctx) {
    // Queries run against the session's shared canvas (resolved from ctx.state by
    // the staging layer). canvas_id is accepted for symmetry with the query/profile
    // tools' token model but is optional — the common path omits it.
    if (!canvasEnabled()) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not configured on this server.',
        ctx.recoveryFor('canvas_disabled'),
      );
    }

    const { result } = await queryStaged(ctx, input.sql, { rowLimit: input.row_limit });
    ctx.log.info('Dataframe query executed', {
      rowCount: result.rowCount,
      returned: result.rows.length,
    });

    if (result.rowCount === 0) {
      ctx.enrich.notice(
        'Query returned 0 rows. Verify table names with faostat_dataframe_describe and check the WHERE conditions.',
      );
    } else if (result.rowCount > result.rows.length) {
      ctx.enrich.notice(
        `Showing ${result.rows.length} of ${result.rowCount} rows (capped). Raise row_limit (max 10000) or add aggregation to the query.`,
      );
    }

    return { columns: result.columns, row_count: result.rowCount, rows: result.rows };
  },

  format: (result) => {
    const cappedNote =
      result.row_count > result.rows.length
        ? ` (showing ${result.rows.length} of ${result.row_count})`
        : '';
    const lines: string[] = [`**${result.row_count} rows**${cappedNote}\n`];
    if (result.rows.length === 0) {
      lines.push('_No rows._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push(`| ${result.columns.join(' | ')} |`);
    lines.push(`| ${result.columns.map(() => '---').join(' | ')} |`);
    for (const row of result.rows) {
      const cells = result.columns.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v.replace(/\|/g, '\\|');
        if (typeof v === 'object') return JSON.stringify(v).replace(/\|/g, '\\|');
        return String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
