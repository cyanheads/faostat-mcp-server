/**
 * @fileoverview `faostat_dataframe_describe` — lists the canvas tables staged by
 * faostat_query_observations and faostat_commodity_profile, with row count,
 * column schema, source tool, and TTL. Call before faostat_dataframe_query to
 * discover table and column names for the SQL. Listings are paged: a session
 * that spills repeatedly accumulates a table per spill until the 2h TTL sweeps
 * them, and each entry carries a full column schema.
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { canvasEnabled, describeStaged } from '@/services/canvas-staging.js';

/** Cap on staged tables returned in one page. */
const MAX_TABLES = 100;

export const dataframeDescribeTool = tool('faostat_dataframe_describe', {
  title: 'faostat-mcp-server: dataframe describe',
  description:
    'List the canvas tables (faostat_xxxxxxxx) staged by faostat_query_observations and faostat_commodity_profile, each with its source tool, the query parameters that produced it, creation/expiry timestamps, row count, and column schema. Call this before faostat_dataframe_query to discover the exact table and column names to reference in SQL. Tables are listed newest-first and paged: pass `name` to describe one table outright, or page with `offset` + `limit` — when the response reports `truncated`, pass the returned `nextOffset` to fetch the rest.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  enrichment: {
    totalMatches: z
      .number()
      .describe('Staged tables on the resolved canvas, before the page limit is applied.'),
    truncated: z
      .boolean()
      .describe(
        'True when more staged tables remain beyond the returned page — fetch them with nextOffset. Always false for a single-table `name` lookup, which is never paged.',
      ),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe(
        'Offset to pass on the next call to fetch the following page. Present only when truncated is true; absent on the last page and for `name` lookups.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing is staged yet or more pages remain.'),
  },

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable staged tables.',
    },
    {
      // Raised by the framework canvas inside describeStaged, not by a ctx.fail here.
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
      when: 'A name filter was supplied but no staged table on the resolved canvas matches it.',
      recovery:
        'Call faostat_dataframe_describe without name to list all staged tables, or re-run the query that staged the data.',
    },
  ],

  input: z.object({
    canvas_id: CanvasIdSchema.optional().describe(
      'Optional canvas ID as returned by a prior faostat_query_observations / faostat_commodity_profile call — exactly 10 characters of letters, digits, hyphens, and underscores. Omit to list the tables staged in this session (the common case).',
    ),
    name: z
      .string()
      .optional()
      .describe(
        'Optional table name (faostat_xxxxxxxx) to describe a single staged table. Takes precedence over `offset` / `limit`, which are ignored for a name lookup (always single-page).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TABLES)
      .default(20)
      .describe(
        'Maximum staged tables to return on this page (max 100). Each entry carries a full column schema, so the default keeps a discovery call small.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based pagination offset into the staged tables (newest first). When the response reports truncated, pass the returned nextOffset here to fetch the next page. Ignored for `name` lookups.',
      ),
  }),

  output: z.object({
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Canvas table name (faostat_xxxxxxxx).'),
            source_tool: z.string().describe('Tool that staged this table.'),
            query_params: z
              .record(z.string(), z.unknown())
              .describe('Input parameters the source tool was called with.'),
            created_at: z.string().describe('ISO 8601 creation timestamp.'),
            expires_at: z
              .string()
              .describe('ISO 8601 expiry timestamp. Sliding TTL touched on every staged-table op.'),
            row_count: z.number().describe('Rows staged in the table.'),
            truncated: z
              .boolean()
              .describe(
                'True when the staging cap was hit and the table holds fewer rows than the full result.',
              ),
            column_schema: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('Canvas column type (VARCHAR, BIGINT, DOUBLE, …).'),
                  })
                  .describe('One column declaration.'),
              )
              .describe('Resolved column schema for the staged table.'),
          })
          .describe('Provenance and schema for one staged table.'),
      )
      .describe(
        'Active staged tables for this session, newest first — one page of them. Empty when none are staged.',
      ),
  }),

  async handler(input, ctx) {
    if (!canvasEnabled()) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not configured on this server.',
        ctx.recoveryFor('canvas_disabled'),
      );
    }
    const entries = await describeStaged(ctx, {
      ...(input.name ? { tableName: input.name } : {}),
      ...(input.canvas_id ? { canvasId: input.canvas_id } : {}),
    });
    // A name filter that matched nothing is a missing-table miss, not an empty
    // canvas — surface it as a typed NotFound instead of "No active staged tables".
    if (input.name && entries.length === 0) {
      throw ctx.fail(
        'missing_table',
        `No staged table named "${input.name}" on this canvas.`,
        ctx.recoveryFor('missing_table'),
      );
    }

    // A `name` lookup resolves at most one table and is never paged, so `limit`
    // cannot bind there — `truncated` must stay false rather than describe a
    // ceiling that did not apply.
    const total = entries.length;
    const page = input.name ? entries : entries.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + page.length;
    const truncated = !input.name && nextOffset < total;
    ctx.enrich({ totalMatches: total, truncated, ...(truncated ? { nextOffset } : {}) });

    if (page.length === 0) {
      ctx.enrich.notice(
        total > 0
          ? `Offset ${input.offset} is past the ${total} staged table(s). Lower offset (0-based) to page back through the listing.`
          : 'No tables are staged on this canvas. Run faostat_query_observations or faostat_commodity_profile first — a result larger than the inline budget stages one.',
      );
    } else if (truncated) {
      ctx.enrich.notice(
        `Showing staged tables ${input.offset + 1}–${nextOffset} of ${total}. Call again with offset ${nextOffset} to fetch the next page.`,
      );
    }

    return {
      tables: page.map((meta) => ({
        name: meta.tableName,
        source_tool: meta.sourceTool,
        query_params: meta.queryParams,
        created_at: meta.createdAt,
        expires_at: meta.expiresAt,
        row_count: meta.rowCount,
        truncated: meta.truncated,
        column_schema: meta.columnSchema.map((c) => ({ name: c.name, type: c.type })),
      })),
    };
  },

  format: (result) => {
    if (result.tables.length === 0) {
      return [{ type: 'text', text: 'No active staged tables.' }];
    }
    const lines: string[] = [`**${result.tables.length} staged table(s):**\n`];
    for (const t of result.tables) {
      lines.push(`### ${t.name}`);
      lines.push(`- Source: ${t.source_tool}`);
      lines.push(`- Rows: ${t.row_count}${t.truncated ? ' (truncated)' : ''}`);
      lines.push(`- Created: ${t.created_at} — Expires: ${t.expires_at}`);
      const params = Object.entries(t.query_params)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      if (params) lines.push(`- Params: ${params}`);
      const cols = t.column_schema.map((c) => `${c.name}:${c.type}`).join(', ');
      lines.push(`- Columns: ${cols}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
