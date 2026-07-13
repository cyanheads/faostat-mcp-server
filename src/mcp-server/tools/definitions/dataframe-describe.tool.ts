/**
 * @fileoverview `faostat_dataframe_describe` — lists the canvas tables staged by
 * faostat_query_observations and faostat_commodity_profile, with row count,
 * column schema, source tool, and TTL. Call before faostat_dataframe_query to
 * discover table and column names for the SQL.
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { canvasEnabled, describeStaged } from '@/services/canvas-staging.js';

export const dataframeDescribeTool = tool('faostat_dataframe_describe', {
  title: 'faostat-mcp-server: dataframe describe',
  description:
    'List the canvas tables (faostat_xxxxxxxx) staged by faostat_query_observations and faostat_commodity_profile, each with its source tool, the query parameters that produced it, creation/expiry timestamps, row count, and column schema. Call this before faostat_dataframe_query to discover the exact table and column names to reference in SQL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable staged tables.',
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
      when: 'A name filter was supplied but no staged table on the resolved canvas matches it.',
      recovery:
        'Call faostat_dataframe_describe without name to list all staged tables, or re-run the query that staged the data.',
    },
  ],

  input: z.object({
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional canvas ID from a prior faostat_query_observations / faostat_commodity_profile call. Omit to list the tables staged in this session (the common case).',
      ),
    name: z
      .string()
      .optional()
      .describe(
        'Optional table name (faostat_xxxxxxxx) to describe a single staged table. Omit to list all.',
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
      .describe('Active staged tables for this session, newest first. Empty when none are staged.'),
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
    return {
      tables: entries.map((meta) => ({
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
