/**
 * @fileoverview `faostat_dataframe_drop` — drops one canvas table staged by
 * faostat_query_observations or faostat_commodity_profile, with its provenance,
 * ahead of its 2h TTL. Idempotent: a name not staged on the resolved canvas
 * returns `dropped: false`. Opt-in — registered through `disabledTool()` unless
 * `FAOSTAT_DATAFRAME_DROP_ENABLED=true` (see {@link dataframeDropRegistration}).
 * @module mcp-server/tools/definitions/dataframe-drop
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { canvasEnabled, dropStaged } from '@/services/canvas-staging.js';

export const dataframeDropTool = tool('faostat_dataframe_drop', {
  title: 'faostat-mcp-server: dataframe drop',
  description:
    'Drop one canvas table (faostat_xxxxxxxx) staged by faostat_query_observations or faostat_commodity_profile, together with its provenance, before its 2-hour TTL removes it — once an analysis with it is finished. Idempotent: a name that is not staged on the resolved canvas returns dropped false and changes nothing. faostat_dataframe_describe lists the staged table names.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when no staged table by that name existed, so nothing was dropped.'),
  },

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment.',
      recovery:
        'Staged tables are off in this deployment, so nothing is staged to drop; set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable them.',
    },
    {
      // Raised by the framework canvas inside dropStaged, not by a ctx.fail here.
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'An explicit canvas_id does not resolve to a live canvas — unknown, expired, or owned by another tenant.',
      recovery:
        'Verify the canvas_id was returned by a prior faostat_query_observations / faostat_commodity_profile call, or omit canvas_id to fall back to the shared session canvas.',
    },
  ],

  input: z.object({
    name: z
      .string()
      .regex(
        /^faostat_[a-z0-9]{8}$/,
        'Expected a staged table name such as faostat_ab12cd34, exactly as faostat_dataframe_describe lists it.',
      )
      .describe(
        'Staged table to drop — "faostat_" plus 8 lowercase letters and digits, exactly as faostat_dataframe_describe lists it.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Optional canvas ID as returned by a prior faostat_query_observations / faostat_commodity_profile call — exactly 10 characters of letters, digits, hyphens, and underscores. Omit to drop from the tables staged in this session (the common case).',
    ),
  }),

  output: z.object({
    name: z.string().describe('The table name the request named.'),
    dropped: z
      .boolean()
      .describe(
        'True when the table was staged on the resolved canvas and is now gone; false when no table by that name was staged there.',
      ),
  }),

  async handler(input, ctx) {
    if (!canvasEnabled()) {
      throw ctx.fail('canvas_disabled', 'DataCanvas is not configured on this server.');
    }
    const dropped = await dropStaged(
      ctx,
      input.name,
      input.canvas_id ? { canvasId: input.canvas_id } : {},
    );
    ctx.log.info('Dataframe drop', { name: input.name, dropped });
    if (!dropped) {
      ctx.enrich.notice(
        `No staged table named "${input.name}" on this canvas, so nothing was dropped. It may have expired on its 2-hour TTL or been dropped already; faostat_dataframe_describe lists the tables staged now.`,
      );
    }
    return { name: input.name, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped
        ? `Dropped staged table ${result.name} (dropped: true).`
        : `${result.name} was not staged on this canvas; nothing dropped (dropped: false).`,
    },
  ],
});

/**
 * The definition `createApp()` registers: the live tool when
 * `FAOSTAT_DATAFRAME_DROP_ENABLED` is on, otherwise wrapped in `disabledTool()` —
 * shown on the landing page with the enable hint, absent from `tools/list`, and
 * uncallable.
 */
export function dataframeDropRegistration(enabled: boolean) {
  return enabled
    ? dataframeDropTool
    : disabledTool(dataframeDropTool, {
        reason:
          'Dropping staged tables is turned off in this deployment; staged tables expire on their own 2-hour TTL.',
        hint: 'FAOSTAT_DATAFRAME_DROP_ENABLED=true',
      });
}
