/**
 * @fileoverview `faostat_query_observations` — the core data tool. Queries a
 * domain's cube by area(s), item(s), element(s), and year range from the local
 * mirror, returning observations with their data-quality flag. Excludes
 * aggregate regions by default so a naive sum doesn't double-count World + its
 * members. Small results inline; large result sets spill to a DataCanvas table
 * for SQL aggregation via faostat_dataframe_query.
 * @module mcp-server/tools/definitions/query-observations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { canvasEnabled, STAGE_MAX_ROWS, stageObservations } from '@/services/canvas-staging.js';
import type { ObservationRow } from '@/services/faostat-mirror/index.js';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';

/** Inline-preview row cap — beyond this, results spill to the canvas. */
const INLINE_PREVIEW_ROWS = 50;

/** Build the agent-facing observation row from a mirror row (strips internal fields). */
function toObservation({
  area_code,
  area,
  item_code,
  item,
  element_code,
  element,
  year,
  value,
  unit,
  flag,
}: ObservationRow) {
  return { area_code, area, item_code, item, element_code, element, year, value, unit, flag };
}

export const queryObservationsTool = tool('faostat_query_observations', {
  title: 'faostat-mcp-server: query observations',
  description:
    "Query a FAOSTAT domain's data cube by area(s), item(s), element(s), and year range, returning observations (area, item, element, year, value, unit, and the data-quality flag). Resolve codes first with faostat_resolve_codes — the cube is unqueryable without them. Aggregate regions (World, continents, economic groupings) are EXCLUDED by default so a naive SUM does not double-count a region with its member countries; set include_aggregates=true to get the regional roll-ups, or pass explicit area_codes to query exactly what you name. Small result sets return inline; large ones spill to a DataCanvas table (returned canvas_id + table_name) for GROUP BY / ranking / time-series analysis via faostat_dataframe_query. Every row carries its flag (A=Official, E=Estimated, I=Imputed, B=break, X=external) — honor it; never treat estimated/imputed values as official.",
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },

  enrichment: {
    totalCount: z.number().describe('Total observations matched before any inline cap.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance on empty results, aggregate exclusion, or how to reach the spilled set.'),
  },

  errors: [
    {
      reason: 'domain_not_indexed',
      code: JsonRpcErrorCode.NotFound,
      when: 'The domain is not in the local mirror selection (FAOSTAT_DOMAINS) — whether a valid FAOSTAT code or not.',
      recovery:
        'Pick an indexed domain (faostat_list_domains shows the indexed flag) or add it to FAOSTAT_DOMAINS and re-sync.',
    },
    {
      reason: 'index_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The domain mirror is cold — its initial sync has never completed.',
      retryable: true,
      recovery:
        'Wait for the initial sync to finish, or run the mirror init script, then retry shortly.',
    },
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The result is too large to inline but DataCanvas is off, so it cannot be staged for SQL.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb to enable SQL on large result sets, or narrow the query.',
    },
  ],

  input: z.object({
    domain: z
      .string()
      .min(1)
      .describe('FAOSTAT domain code (e.g. "QCL"). Must be indexed locally.'),
    area_codes: z
      .array(z.number().int())
      .optional()
      .describe(
        'Area codes from faostat_resolve_codes. When set, aggregates are NOT auto-excluded — the codes are honored verbatim.',
      ),
    item_codes: z
      .array(z.number().int())
      .optional()
      .describe('Item codes from faostat_resolve_codes.'),
    element_codes: z
      .array(z.number().int())
      .optional()
      .describe('Element codes from faostat_resolve_codes (e.g. 5510 Production).'),
    year_start: z.number().int().optional().describe('Inclusive start year (e.g. 2000).'),
    year_end: z.number().int().optional().describe('Inclusive end year (e.g. 2022).'),
    include_aggregates: z
      .boolean()
      .default(false)
      .describe(
        'When false (default), exclude aggregate-region rows (codes ≥ 5000) so sums are not double-counted. Set true for World/continent/grouping roll-ups. Ignored when explicit area_codes are passed.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe('Max observations returned inline when the result does not spill. Max 1000.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID from a prior call to stage onto. Omit to start a fresh canvas (a new id is returned).',
      ),
  }),

  output: z.object({
    domain: z.string().describe('The domain code echoed back.'),
    observations: z
      .array(
        z
          .object({
            area_code: z.number().describe('Area code.'),
            area: z.string().describe('Area name.'),
            item_code: z.number().describe('Item code.'),
            item: z.string().describe('Item name.'),
            element_code: z.number().describe('Element code.'),
            element: z.string().describe('Element (metric) name.'),
            year: z.number().describe('Observation year.'),
            value: z.number().nullable().describe('Observed value; null when the cell is empty.'),
            unit: z.string().nullable().describe('Unit of measure; null when unspecified.'),
            flag: z
              .string()
              .nullable()
              .describe(
                'Data-quality flag (A=Official, E=Estimated, I=Imputed, B=break, X=external); null when unflagged.',
              ),
          })
          .describe('One observation. The flag is load-bearing — never drop or ignore it.'),
      )
      .describe('Inline observations (preview when the full set spilled to a canvas table).'),
    spilled: z.boolean().describe('True when the full result was staged on a DataCanvas table.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID holding the staged result — pass to faostat_dataframe_query / _describe.',
      ),
    table_name: z
      .string()
      .optional()
      .describe('Canvas table name holding the full result set (present when spilled).'),
  }),

  async handler(input, ctx) {
    const mirror = getFaostatMirror();
    const code = input.domain.toUpperCase();
    if (!mirror.isSelected(code)) {
      // Not selected — could be a real domain not in FAOSTAT_DOMAINS, or unknown.
      // domain_not_indexed is the actionable case; list_domains disambiguates.
      throw ctx.fail(
        'domain_not_indexed',
        `Domain "${code}" is not in the local mirror selection.`,
        ctx.recoveryFor('domain_not_indexed'),
      );
    }
    if (!(await mirror.ready(code))) {
      throw ctx.fail(
        'index_not_ready',
        `The ${code} mirror has not completed its initial sync.`,
        ctx.recoveryFor('index_not_ready'),
      );
    }

    const filters = {
      ...(input.area_codes?.length ? { areaCodes: input.area_codes } : {}),
      ...(input.item_codes?.length ? { itemCodes: input.item_codes } : {}),
      ...(input.element_codes?.length ? { elementCodes: input.element_codes } : {}),
      ...(input.year_start !== undefined ? { yearStart: input.year_start } : {}),
      ...(input.year_end !== undefined ? { yearEnd: input.year_end } : {}),
      includeAggregates: input.include_aggregates,
    };

    // Cheap count first: decide inline vs spill without materializing everything.
    const { rows, total } = await mirror.queryObservations(code, {
      ...filters,
      limit: input.limit,
      offset: 0,
    });

    ctx.enrich.total(total);

    if (total === 0) {
      ctx.enrich.notice(
        `No observations matched in ${code}. Widen the year range, relax filters, or re-check codes with faostat_resolve_codes${input.include_aggregates ? '' : ' (aggregates are excluded by default — set include_aggregates=true for regional roll-ups)'}.`,
      );
      return { domain: code, observations: [], spilled: false };
    }

    // Spill when the full result exceeds the inline budget AND canvas is on.
    const shouldSpill = total > INLINE_PREVIEW_ROWS;
    if (shouldSpill && !canvasEnabled()) {
      throw ctx.fail(
        'canvas_disabled',
        `Result has ${total} rows — too large to inline — but DataCanvas is disabled.`,
        ctx.recoveryFor('canvas_disabled'),
      );
    }

    if (shouldSpill) {
      const staged = await stageObservations(
        ctx,
        mirror.streamObservations(code, filters, STAGE_MAX_ROWS + 1),
        {
          sourceTool: 'faostat_query_observations',
          queryParams: {
            domain: code,
            area_codes: input.area_codes,
            item_codes: input.item_codes,
            element_codes: input.element_codes,
            year_start: input.year_start,
            year_end: input.year_end,
            include_aggregates: input.include_aggregates,
          },
          ...(input.canvas_id ? { canvasId: input.canvas_id } : {}),
        },
      );
      if (staged) {
        // `previewRows` holds the preview slice when spilled, or — when the stream
        // drained under the char budget — the COMPLETE set (the spill helper only
        // stops short on an overflow row). Either way it's the rows to inline:
        // returning the not-spilled full set here is what closes the 51–~600-row
        // dead band where re-capping at `limit` silently dropped rows.
        const observations = (staged.previewRows as unknown as ObservationRow[]).map(toObservation);
        if (staged.spilled) {
          ctx.enrich.notice(
            `Result of ${total} observations staged on canvas table ${staged.tableName}. Use faostat_dataframe_query (canvas_id ${staged.canvasId}) for GROUP BY, ranking, and time-series analysis over the full set.`,
          );
          return {
            domain: code,
            observations,
            spilled: true,
            canvas_id: staged.canvasId,
            table_name: staged.tableName,
          };
        }
        return { domain: code, observations, spilled: false };
      }
      // Canvas op failed outright (staged === undefined) — fall back to the inline
      // page. canvasEnabled() was true above, so advise raising `limit`, not
      // enabling a canvas that is already on.
      ctx.log.warning('Canvas staging failed; returning inline page', { total });
    }

    if (total > rows.length) {
      ctx.enrich.notice(
        `Showing ${rows.length} of ${total} observations (inline page). Raise limit (max 1000) to return more rows, or narrow the filters.`,
      );
    }
    return {
      domain: code,
      observations: rows.map(toObservation),
      spilled: false,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.spilled) {
      lines.push(
        `Full result spilled to canvas table **${result.table_name}** (canvas_id ${result.canvas_id}). Preview below — query the table for the complete set.\n`,
      );
    } else {
      lines.push('_Full result returned inline (not spilled to a canvas table)._\n');
    }
    lines.push(`**${result.observations.length} observation(s)** in ${result.domain}\n`);
    if (result.observations.length === 0) {
      lines.push('_No observations._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('| Area | Item | Element | Year | Value | Unit | Flag |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const o of result.observations) {
      lines.push(
        `| ${o.area} (${o.area_code}) | ${o.item} (${o.item_code}) | ${o.element} (${o.element_code}) | ${o.year} | ${o.value ?? ''} | ${o.unit ?? ''} | ${o.flag ?? ''} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
