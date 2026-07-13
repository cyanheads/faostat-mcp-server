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
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An explicit canvas_id does not resolve to a live canvas — unknown, expired, or owned by another tenant.',
      recovery:
        'Verify the canvas_id was returned by a prior faostat_query_observations / faostat_commodity_profile call, or omit canvas_id to fall back to the shared session canvas.',
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
      .describe(
        'Rows returned in this response — the materialized count, equal to rows.length. When truncated is true this is NOT the full result total (this path computes no exact total); page or aggregate to reach the rest.',
      ),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Materialized result rows, bounded by row_limit.'),
    truncated: z
      .boolean()
      .describe(
        'True when row_limit capped the result and more rows exist than were returned. To reach them: page with ORDER BY + SQL LIMIT/OFFSET, raise row_limit (max 10000), or aggregate with GROUP BY.',
      ),
  }),

  async handler(input, ctx) {
    // canvas_id selects a specific canvas from a prior call; omitted, queries run
    // against the session's shared canvas (resolved from ctx.state by the staging
    // layer). An unknown/other-tenant canvas_id throws canvas_not_found.
    if (!canvasEnabled()) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not configured on this server.',
        ctx.recoveryFor('canvas_disabled'),
      );
    }

    const { result } = await queryStaged(ctx, input.sql, {
      rowLimit: input.row_limit,
      ...(input.canvas_id ? { canvasId: input.canvas_id } : {}),
    });
    // Read the framework's truncation flag, not a rowCount>rows.length comparison:
    // on this non-registerAs path rowCount always equals rows.length (both capped
    // at row_limit), so the old comparison was dead and capped results looked
    // complete. row_count is the materialized/returned count; truncated is the
    // "there is more" signal (no exact total is computed here).
    const truncated = result.truncated ?? false;
    ctx.log.info('Dataframe query executed', {
      rowCount: result.rows.length,
      truncated,
    });

    if (result.rows.length === 0) {
      ctx.enrich.notice(
        'Query returned 0 rows. Verify table names with faostat_dataframe_describe and check the WHERE conditions.',
      );
    } else if (truncated) {
      ctx.enrich.notice(
        `Returned ${result.rows.length} rows — capped at row_limit, more rows exist (no exact total on this path). To reach the rest: page deterministically with ORDER BY plus SQL LIMIT/OFFSET, raise row_limit (max 10000), or aggregate with GROUP BY.`,
      );
    }

    return { columns: result.columns, row_count: result.rows.length, rows: result.rows, truncated };
  },

  format: (result) => {
    const header = result.truncated
      ? `**${result.row_count} rows** (truncated — capped at row_limit, more rows exist)`
      : `**${result.row_count} rows**`;
    const lines: string[] = [`${header}\n`];
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
    if (result.truncated) {
      lines.push(
        '\n_Result truncated — capped at row_limit, more rows exist. Page deterministically with ORDER BY plus SQL LIMIT/OFFSET, raise row_limit (max 10000), or aggregate with GROUP BY._',
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
