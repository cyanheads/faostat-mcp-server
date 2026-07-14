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
    "Query a FAOSTAT domain's data cube by area(s), item(s), element(s), and year range, returning observations (area, item, element, year, value, unit, and the data-quality flag). Resolve codes first with faostat_resolve_codes — the cube is unqueryable without them. Aggregate regions (World, continents, economic groupings) are EXCLUDED by default so a naive SUM does not double-count a region with its member countries; set include_aggregates=true to get the regional roll-ups, or pass explicit area_codes to query exactly what you name. Small result sets return inline; large ones spill to a DataCanvas table (returned canvas_id + table_name) for GROUP BY / ranking / time-series analysis via faostat_dataframe_query. Every row carries its flag — commonly A=Official, B=time-series break, E=Estimated, I=Imputed, M=Missing (value cannot exist), T=Unofficial, X=from an international organization, plus others FAOSTAT defines per domain — so honor it, treat any unrecognized flag as informational, and never assume an estimated, imputed, or unrecognized value is official.",
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Observations matched. Exact when the result was returned inline or fully staged; when the match set exceeded the 50,000-row staging cap this is that cap — a floor, not the exact count (truncated is then true).',
      ),
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
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'year_start is greater than year_end — a self-contradictory range that can never match.',
      recovery:
        'Pass year_start ≤ year_end, or omit one bound to leave that side of the range open.',
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
        'When false (default), exclude aggregate-region rows (codes ≥ 5000 plus a few curated sub-threshold roll-ups such as China=351) so sums are not double-counted. Set true for World/continent/grouping roll-ups. Ignored when explicit area_codes are passed.',
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
                'Data-quality flag — commonly A=Official, B=time-series break, E=Estimated, I=Imputed, M=Missing (value cannot exist), T=Unofficial, X=from an international organization, plus others FAOSTAT defines per domain; treat any unrecognized flag as informational, never assume official. Null when unflagged.',
              ),
          })
          .describe('One observation. The flag is load-bearing — never drop or ignore it.'),
      )
      .describe('Inline observations (preview when the full set spilled to a canvas table).'),
    spilled: z.boolean().describe('True when the full result was staged on a DataCanvas table.'),
    truncated: z
      .boolean()
      .describe(
        'True when the staged table hit the 50,000-row staging cap — the staged set is a PREFIX of the match, not the complete result. Partition the query by year or code ranges to capture the rest.',
      ),
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
    staged_row_count: z
      .number()
      .optional()
      .describe(
        'Rows actually staged on the canvas table (present when spilled). Equals the full match count unless truncated, in which case it is the 50,000-row cap.',
      ),
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

    // A reversed year range is a contradiction the mirror would silently treat as
    // zero matches with generic no-match guidance — reject it with actionable detail.
    if (
      input.year_start !== undefined &&
      input.year_end !== undefined &&
      input.year_start > input.year_end
    ) {
      throw ctx.fail(
        'invalid_year_range',
        `year_start (${input.year_start}) is after year_end (${input.year_end}).`,
        ctx.recoveryFor('invalid_year_range'),
      );
    }

    // An explicitly-empty code array is a zero-match selection, NOT "match all". The
    // mirror's own `.length` guard (in both queryObservations and streamObservations)
    // would otherwise drop an empty array and broaden the query to the entire
    // dimension, so short-circuit here — before any mirror call — the moment a code
    // array is defined-and-empty. An omitted array still means "unfiltered".
    const emptyDimension =
      input.area_codes?.length === 0
        ? 'area_codes'
        : input.item_codes?.length === 0
          ? 'item_codes'
          : input.element_codes?.length === 0
            ? 'element_codes'
            : undefined;
    if (emptyDimension) {
      ctx.enrich.total(0);
      ctx.enrich.notice(
        `${emptyDimension} was an empty array — an explicit empty selection matches nothing. Omit ${emptyDimension} to query every code in that dimension, or pass codes from faostat_resolve_codes.`,
      );
      return { domain: code, observations: [], spilled: false, truncated: false };
    }

    const filters = {
      ...(input.area_codes?.length ? { areaCodes: input.area_codes } : {}),
      ...(input.item_codes?.length ? { itemCodes: input.item_codes } : {}),
      ...(input.element_codes?.length ? { elementCodes: input.element_codes } : {}),
      ...(input.year_start !== undefined ? { yearStart: input.year_start } : {}),
      ...(input.year_end !== undefined ? { yearEnd: input.year_end } : {}),
      includeAggregates: input.include_aggregates,
    };

    // Overflow probe (not a COUNT): fetch just past the inline budget so the spill
    // decision never scans the whole cube. Widen the fetch to at least
    // INLINE_PREVIEW_ROWS so the probe can always tell "exceeds the inline budget"
    // even when a small input.limit was requested; the display slice caps at limit.
    const { rows, total, totalIsExact } = await mirror.queryObservations(code, {
      ...filters,
      limit: Math.max(input.limit, INLINE_PREVIEW_ROWS),
      offset: 0,
    });

    if (total === 0) {
      ctx.enrich.total(0);
      ctx.enrich.notice(
        `No observations matched in ${code}. Widen the year range, relax filters, or re-check codes with faostat_resolve_codes${input.include_aggregates ? '' : ' (aggregates are excluded by default — set include_aggregates=true for regional roll-ups)'}.`,
      );
      return { domain: code, observations: [], spilled: false, truncated: false };
    }

    // Spill when the match set exceeds the inline budget AND canvas is on. An
    // inexact total means more rows matched than were probed (past the inline budget).
    const shouldSpill = !totalIsExact || total > INLINE_PREVIEW_ROWS;
    if (shouldSpill && !canvasEnabled()) {
      throw ctx.fail(
        'canvas_disabled',
        `Result exceeds the ${INLINE_PREVIEW_ROWS}-row inline budget but DataCanvas is disabled.`,
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
        // The stream yields the exact match count when it drains under the staging
        // cap, so staged.rowCount is the exact total when !truncated (and the exact
        // size of an inline-fit set), or the cap (a floor) when truncated.
        ctx.enrich.total(staged.rowCount);
        if (staged.spilled) {
          if (staged.truncated) {
            ctx.enrich.notice(
              `Matched more than ${STAGE_MAX_ROWS} observations — only the first ${staged.rowCount} were staged on canvas table ${staged.tableName} (staging cap ${STAGE_MAX_ROWS}) — the staged set is a PREFIX, not the complete result. To capture the rest, re-call faostat_query_observations partitioned by year (year_start/year_end) or with narrower area_codes/item_codes/element_codes so each partition stays under the cap, then query each with faostat_dataframe_query (canvas_id ${staged.canvasId}).`,
            );
          } else {
            ctx.enrich.notice(
              `Result of ${staged.rowCount} observations staged on canvas table ${staged.tableName}. Use faostat_dataframe_query (canvas_id ${staged.canvasId}) for GROUP BY, ranking, and time-series analysis over the full set.`,
            );
          }
          return {
            domain: code,
            observations,
            spilled: true,
            truncated: staged.truncated,
            canvas_id: staged.canvasId,
            table_name: staged.tableName,
            staged_row_count: staged.rowCount,
          };
        }
        return { domain: code, observations, spilled: false, truncated: false };
      }
      // Canvas op failed outright (staged === undefined) — fall back to the inline
      // page. canvasEnabled() was true above, so advise raising `limit`, not
      // enabling a canvas that is already on.
      ctx.log.warning('Canvas staging failed; returning inline page', { total });
    }

    // Not spilling (the match set is within the inline budget, so total is exact),
    // or a spill attempt fell back to the inline page. Show up to input.limit rows.
    const inline = rows.slice(0, input.limit);
    ctx.enrich.total(total);
    if (total > inline.length) {
      ctx.enrich.notice(
        `Showing ${inline.length} of ${totalIsExact ? total : `more than ${total}`} observations (inline page). Raise limit (max 1000) to return more rows, or narrow the filters.`,
      );
    }
    return {
      domain: code,
      observations: inline.map(toObservation),
      spilled: false,
      truncated: false,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.spilled && result.truncated) {
      lines.push(
        `Result spilled to canvas table **${result.table_name}** (canvas_id ${result.canvas_id}) but was TRUNCATED at the staging cap — only the first ${result.staged_row_count} row(s) were staged, so the table is INCOMPLETE. Preview below; partition the query by year (year_start/year_end) or narrower codes and re-run to stage the rest.\n`,
      );
    } else if (result.spilled) {
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
