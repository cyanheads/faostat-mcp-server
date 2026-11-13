/**
 * @fileoverview `faostat_dataframe_query` — runs a single-statement read-only
 * SELECT against the canvas tables staged by faostat_query_observations and
 * faostat_commodity_profile. The framework SQL gate enforces read-only
 * (single SELECT, no DDL/DML/file functions); system catalogs are denied so a
 * caller can't enumerate every staged handle. `row_limit` is capped at the canvas's
 * configured row limit, so the tool is built per deployment by
 * {@link dataframeQueryRegistration}.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { ConfigSchema } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { countInput } from '@/mcp-server/tools/count-input.js';
import { markdownCell } from '@/mcp-server/tools/markdown-cell.js';
import { canvasEnabled, OBSERVATION_TABLE_SCHEMA, queryStaged } from '@/services/canvas-staging.js';

/**
 * The tool registered with `row_limit` capped at `rowLimitCap`, the canvas's
 * configured row limit (`CANVAS_DEFAULT_ROW_LIMIT`): the canvas refuses a larger
 * limit, so a `row_limit` above it is served at it. `src/index.ts` reads that limit
 * once `.env` has loaded and registers the tool through this.
 */
export function dataframeQueryRegistration(rowLimitCap: number) {
  const ROW_LIMIT = countInput({
    tool: 'faostat_dataframe_query',
    name: 'row_limit',
    default: Math.min(1000, rowLimitCap),
    cap: rowLimitCap,
    description: (cap) => `Hard cap on rows in the response, at most ${cap} per call.`,
  });

  return tool('faostat_dataframe_query', {
    title: 'faostat-mcp-server: dataframe query',
    description:
      'Run a single-statement SELECT against canvas tables staged by faostat_query_observations and faostat_commodity_profile (faostat_xxxxxxxx). Use DuckDB joins, aggregates, window functions, and CTEs for rankings and time-series analysis. Item groups can overlap their members even with matching units; do not sum them together, and resolver kind=null does not establish safe-to-sum. Separate source methodologies and respect bounded values and multi-year periods. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file functions are rejected; system catalogs are denied. List tables and columns with faostat_dataframe_describe. Preserve data-quality flags in projections: commonly A=Official, B=time-series break, E=Estimated, I=Imputed, M=Missing, T=Unofficial, X=international organization; unrecognized flags never establish official status.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

    enrichment: {
      ...ROW_LIMIT.enrichment,
      notice: z
        .string()
        .optional()
        .describe(
          'Guidance when row_limit was above its cap, the query returned no rows, or results were capped.',
        ),
    },

    errors: [
      {
        reason: 'canvas_disabled',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'The DataCanvas service is not configured for this deployment.',
        recovery:
          'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable SQL on staged results.',
      },
      // The four reasons below are raised by the staging layer (queryStaged) and the
      // framework canvas beneath it, never by a ctx.fail in this handler — marked
      // thrownBy so error-contract-unthrown scans the handler for canvas_disabled alone.
      {
        reason: 'canvas_not_found',
        code: JsonRpcErrorCode.NotFound,
        thrownBy: 'service',
        when: 'An explicit canvas_id does not resolve to a live canvas — unknown, expired, or owned by another tenant.',
        recovery:
          'Verify the canvas_id was returned by a prior faostat_query_observations / faostat_commodity_profile call, or omit canvas_id to fall back to the shared session canvas.',
      },
      {
        reason: 'missing_table',
        code: JsonRpcErrorCode.NotFound,
        thrownBy: 'service',
        when: 'The SQL references a faostat_<id> table that has expired or was never staged.',
        recovery:
          'Call faostat_dataframe_describe to list staged tables, or re-run the query that staged the data.',
      },
      {
        reason: 'system_catalog_access',
        code: JsonRpcErrorCode.ValidationError,
        thrownBy: 'service',
        when: 'The SQL uses a system catalog or a name spelled like a DuckDB internal metadata view (such as duckdb_tables or pg_tables) anywhere as an identifier: a table reference, a column alias (bare, double-quoted, or upper-case), a CTE name, or a table alias. The same spelling inside a string literal is allowed.',
        recovery:
          'Query only faostat_<id> tables, listed by faostat_dataframe_describe, and rename any column alias, CTE, or table alias spelled like a system catalog or metadata view, such as duckdb_tables or pg_tables.',
      },
      {
        reason: 'invalid_sql',
        code: JsonRpcErrorCode.ValidationError,
        thrownBy: 'service',
        when: 'The SQL has a syntax or execution error, or is not a single read-only SELECT.',
        recovery:
          'Use one read-only SELECT and verify column/table names against faostat_dataframe_describe.',
      },
    ],

    input: z.object({
      canvas_id: CanvasIdSchema.optional().describe(
        'Optional canvas ID as returned by a prior faostat_query_observations / faostat_commodity_profile call — exactly 10 characters of letters, digits, hyphens, and underscores. Omit to query the tables staged in this session (the common case).',
      ),
      sql: z
        .string()
        .min(1)
        .describe(
          `Single-statement read-only SELECT against staged faostat_<id> tables. Columns: ${OBSERVATION_TABLE_SCHEMA.map((column) => column.name).join(', ')} — plus domain (QCL or TCL) on tables staged by faostat_commodity_profile.`,
        ),
      row_limit: ROW_LIMIT.schema,
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
          `True when row_limit capped the result and more rows exist than were returned. To reach them: page with ORDER BY + SQL LIMIT/OFFSET, raise row_limit (at most ${rowLimitCap} per call), or aggregate with GROUP BY.`,
        ),
    }),

    async handler(input, ctx) {
      // canvas_id selects a specific canvas from a prior call; omitted, queries run
      // against the session's shared canvas (resolved from ctx.state by the staging
      // layer). An unknown/other-tenant canvas_id throws canvas_not_found.
      if (!canvasEnabled()) {
        throw ctx.fail('canvas_disabled', 'DataCanvas is not configured on this server.');
      }

      const rowLimit = ROW_LIMIT.clamp(ctx, input.row_limit);
      const { result } = await queryStaged(ctx, input.sql, {
        rowLimit: rowLimit.effective,
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

      // A clamped row_limit leads. The sentence after it names what SQL reaches the
      // rest, never a fixed OFFSET: the caller's query may have no stable order.
      const notices: string[] = rowLimit.clamped ? [rowLimit.notice] : [];
      if (result.rows.length === 0) {
        notices.push(
          'Query returned 0 rows. Verify table names with faostat_dataframe_describe and check the WHERE conditions.',
        );
      } else if (truncated) {
        const raise =
          rowLimit.effective < rowLimitCap
            ? `, raise row_limit (at most ${rowLimitCap} per call)`
            : '';
        notices.push(
          `Returned ${result.rows.length} rows — capped at row_limit, more rows exist (no exact total on this path). To reach the rest: page deterministically with ORDER BY plus SQL LIMIT/OFFSET${raise}, or aggregate with GROUP BY.`,
        );
      }
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

      return {
        columns: result.columns,
        row_count: result.rows.length,
        rows: result.rows,
        truncated,
      };
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
      // Column names are the caller's SQL projection — a quoted alias can carry a pipe
      // or a backslash just as a value can, so the header row is escaped the same way.
      lines.push(`| ${result.columns.map(markdownCell).join(' | ')} |`);
      lines.push(`| ${result.columns.map(() => '---').join(' | ')} |`);
      for (const row of result.rows) {
        const cells = result.columns.map((c) => markdownCell(row[c]));
        lines.push(`| ${cells.join(' | ')} |`);
      }
      // Whether raising row_limit would help depends on the limit served, which the
      // notice carries; this line names only the SQL routes.
      if (result.truncated) {
        lines.push(
          '\n_Result truncated — capped at row_limit, more rows exist. Page deterministically with ORDER BY plus SQL LIMIT/OFFSET, or aggregate with GROUP BY._',
        );
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  });
}

/**
 * The tool as a deployment that leaves `CANVAS_DEFAULT_ROW_LIMIT` unset registers it
 * (`row_limit` capped at the framework's default canvas row limit), for definition
 * linting and tests. `src/index.ts` registers {@link dataframeQueryRegistration}.
 */
export const dataframeQueryTool = dataframeQueryRegistration(
  ConfigSchema.shape.canvas.shape.defaultRowLimit.parse(undefined),
);
