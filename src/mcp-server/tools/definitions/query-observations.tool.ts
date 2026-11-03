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
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdownCell } from '@/mcp-server/tools/markdown-cell.js';
import {
  canvasEnabled,
  OBSERVATION_TABLE_SCHEMA,
  STAGE_MAX_ROWS,
  stageObservations,
} from '@/services/canvas-staging.js';
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
  item_code_text,
  period,
  value_qualifier,
  source_code,
  source,
}: ObservationRow) {
  return {
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
    item_code_text,
    period,
    value_qualifier,
    source_code,
    source,
  };
}

export const queryObservationsTool = tool('faostat_query_observations', {
  title: 'faostat-mcp-server: query observations',
  description:
    "Query a FAOSTAT domain's data cube by area(s), item(s), element(s), sources, and year range, returning values with units and data-quality flags. Resolve numeric codes or exact alphanumeric item identities with faostat_resolve_codes; element resolution accepts item selectors and returns units. Empty queries with explicit items and elements list available elements for those items across the domain, without establishing area/year/source coverage. Aggregate regions are excluded by default; include_aggregates=true returns roll-ups, and explicit area_codes are honored verbatim. Item groups can overlap their members even with matching units; they remain included, and kind=null does not establish safe-to-sum. Keep source methodologies separate. Small results return inline; large ones spill to a DataCanvas table (canvas_id + table_name); call faostat_dataframe_describe for columns, then faostat_dataframe_query for analysis. Honor every row's flag: commonly A=Official, B=time-series break, E=Estimated, I=Imputed, M=Missing, T=Unofficial, X=international organization; unrecognized flags never establish official status.",
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Observations matched. Exact when the result was returned inline or fully staged. A floor — more matched — in two cases, both named by the notice: the match exceeded the 50,000-row staging cap (truncated is then true), or staging failed and the response fell back to an inline page.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance on empty results, aggregate exclusion, or how to reach the spilled set.'),
  },

  errors: [
    {
      reason: 'conflicting_item_selectors',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Both numeric item_codes and exact item_codes_text are supplied.',
      recovery: 'Supply either item_codes or item_codes_text, omitting the other selector.',
    },
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
      when: 'The domain mirror requires an initial sync or an ingest upgrade.',
      retryable: true,
      recovery: 'Wait for sync to finish, or run mirror:init or mirror:refresh, then retry.',
    },
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The result is too large to inline but DataCanvas is off, so it cannot be staged for SQL.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb to enable SQL on large result sets, or narrow the query.',
    },
    // Raised by the staging layer when it resolves the caller's canvas_id.
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'The result is large enough to stage and canvas_id does not resolve to a live canvas — unknown, expired, or owned by another tenant. A result that fits inline stages nothing and never consults canvas_id.',
      recovery:
        'Omit canvas_id to stage onto this session’s canvas, or pass a canvas_id returned within the 2-hour table TTL by an earlier faostat_query_observations / faostat_commodity_profile call.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'year_start is greater than year_end — a self-contradictory range that can never match.',
      recovery:
        'Pass year_start ≤ year_end, or omit one bound to leave that side of the range open.',
    },
    // Raised by the mirror read pool when the call's ceiling fires.
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      retryable: true,
      when: "The call's mirror reads — time queued behind other calls plus execution — ran past the 45-second per-call ceiling.",
      recovery:
        'Retry, or narrow the query with item_codes, element_codes, or a tighter year range so it reads fewer rows.',
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
    item_codes_text: z
      .array(
        z
          .string()
          .regex(/^\d+[A-Za-z][A-Za-z0-9]*$/)
          .describe('Exact alphanumeric item code.'),
      )
      .optional()
      .describe(
        'Exact alphanumeric item identities from resolver code_text; mutually exclusive with item_codes. Numeric codes use item_codes.',
      ),
    source_codes: z
      .array(z.number().int())
      .optional()
      .describe(
        'Exact source codes, such as 3050 or 3051 in GLE. Omit to return every methodology; choose or group sources before summing.',
      ),
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
      .describe(
        'Max observations returned inline — also the preview size when the result stages to a canvas table. Rows past it are never dropped silently: a match larger than limit stages in full to a DataCanvas table (canvas_id + table_name), and when no table is staged the notice reports how many matched so you can raise limit or narrow the filters. Max 1000.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID to stage onto, as returned by a prior faostat_query_observations / faostat_commodity_profile call — exactly 10 characters of letters, digits, hyphens, and underscores. Omit to stage onto this session’s canvas, created on the first spill and reused by every later call, so tables staged earlier in the session sit alongside this one.',
    ),
  }),

  output: z.object({
    domain: z.string().describe('The domain code echoed back.'),
    available_elements: z
      .array(
        z
          .object({
            code: z.number().describe('Element code available for the selected items.'),
            name: z.string().describe('Element label.'),
            units: z
              .array(z.string().describe('Observed unit.'))
              .describe('Distinct specified units for these items in this domain.'),
          })
          .describe('An element observed for the selected items.'),
      )
      .optional()
      .describe(
        'On an empty query with explicit items and elements: all elements available for those items across the domain. Does not establish coverage for requested area/year/source filters.',
      ),
    observations: z
      .array(
        z
          .object({
            area_code: z.number().describe('Area code.'),
            area: z.string().describe('Area name.'),
            item_code: z
              .number()
              .nullable()
              .describe('Numeric item code; null for alphanumeric identities.'),
            item_code_text: z
              .string()
              .nullable()
              .describe('Exact alphanumeric item code; null for numeric identities.'),
            period: z
              .string()
              .nullable()
              .describe(
                'Original multi-year period label; null for annual rows. Year is the integer midpoint.',
              ),
            value_qualifier: z
              .string()
              .nullable()
              .describe(
                'Bound operator such as <; value is a bound rather than an exact observation when present.',
              ),
            source_code: z
              .number()
              .nullable()
              .describe('Source methodology code; null when the domain has none.'),
            source: z.string().nullable().describe('Source methodology label; null when absent.'),
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
        'Canvas ID holding the staged table (present when spilled) — pass it with table_name to faostat_dataframe_describe for the columns and types, then to faostat_dataframe_query for SQL.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'Canvas table holding the staged result set (present when spilled; a PREFIX of the match when truncated) — pass it as name to faostat_dataframe_describe, then reference it in faostat_dataframe_query SQL.',
      ),
    staged_row_count: z
      .number()
      .optional()
      .describe(
        'Rows actually staged on the canvas table (present when spilled). Equals the full match count unless truncated, in which case it is the 50,000-row cap.',
      ),
  }),

  async handler(input, ctx) {
    if (input.item_codes !== undefined && input.item_codes_text !== undefined)
      throw ctx.fail(
        'conflicting_item_selectors',
        'item_codes and item_codes_text are mutually exclusive.',
      );
    const mirror = getFaostatMirror();
    const code = input.domain.toUpperCase();
    if (!mirror.isSelected(code)) {
      // Not selected — could be a real domain not in FAOSTAT_DOMAINS, or unknown.
      // domain_not_indexed is the actionable case; list_domains disambiguates.
      throw ctx.fail(
        'domain_not_indexed',
        `Domain "${code}" is not in the local mirror selection.`,
      );
    }
    if (!(await mirror.ready(code))) {
      throw ctx.fail(
        'index_not_ready',
        `The ${code} mirror requires a completed sync before it can be queried.`,
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
      );
    }

    // An explicitly-empty code array is a zero-match selection, NOT "match all". The
    // mirror's own `.length` guard (in both queryObservations and streamObservations)
    // would otherwise drop an empty array and broaden the query to the entire
    // dimension, so short-circuit here — before any mirror call — the moment a code
    // array is defined-and-empty. An omitted array still means "unfiltered".
    const emptyDimension = (
      ['area_codes', 'item_codes', 'element_codes', 'item_codes_text', 'source_codes'] as const
    ).find((dimension) => input[dimension]?.length === 0);
    if (emptyDimension) {
      ctx.enrich.total(0);
      ctx.enrich.notice(
        `${emptyDimension} was an empty array — an explicit empty selection matches nothing. Omit ${emptyDimension} to query every code in that dimension${emptyDimension === 'source_codes' ? ', or pass source codes carried by observations in this domain' : ', or pass codes from faostat_resolve_codes'}.`,
      );
      return { domain: code, observations: [], spilled: false, truncated: false };
    }

    const filters = {
      ...(input.area_codes?.length ? { areaCodes: input.area_codes } : {}),
      ...(input.item_codes?.length ? { itemCodes: input.item_codes } : {}),
      ...(input.item_codes_text?.length ? { itemCodesText: input.item_codes_text } : {}),
      ...(input.source_codes?.length ? { sourceCodes: input.source_codes } : {}),
      ...(input.element_codes?.length ? { elementCodes: input.element_codes } : {}),
      ...(input.year_start !== undefined ? { yearStart: input.year_start } : {}),
      ...(input.year_end !== undefined ? { yearEnd: input.year_end } : {}),
      includeAggregates: input.include_aggregates,
    };

    // One ceiling for the call, across both the probe and the staging stream.
    const signal = mirror.readSignal(ctx.signal);

    // Overflow probe (not a COUNT): fetch just past the inline budget so the spill
    // decision never scans the whole cube. Widen the fetch to at least
    // INLINE_PREVIEW_ROWS so the probe can always tell "exceeds the inline budget"
    // even when a small input.limit was requested; the display slice caps at limit.
    const { rows, total, totalIsExact } = await mirror.queryObservations(
      code,
      { ...filters, limit: Math.max(input.limit, INLINE_PREVIEW_ROWS), offset: 0 },
      signal,
    );

    if (total === 0) {
      let availableElements: { code: number; name: string; units: string[] }[] | undefined;
      if (
        (input.item_codes !== undefined || input.item_codes_text !== undefined) &&
        input.element_codes !== undefined
      ) {
        availableElements = [];
        let offset = 0;
        let availableTotal: number;
        do {
          const page = await mirror.resolve(code, 'element', {
            ...(input.item_codes !== undefined ? { itemCodes: input.item_codes } : {}),
            ...(input.item_codes_text !== undefined
              ? { itemCodesText: input.item_codes_text }
              : {}),
            limit: 200,
            offset,
            signal,
          });
          availableTotal = page.total;
          availableElements.push(
            ...page.matches.map((match) => {
              if (match.code === null || match.units === undefined)
                throw internalError(
                  'Element resolution returned an invalid identity or omitted units.',
                );
              return { code: match.code, name: match.name, units: match.units };
            }),
          );
          offset += page.matches.length;
        } while (offset < availableTotal);
      }
      ctx.enrich.total(0);
      ctx.enrich.notice(
        `No observations matched in ${code}. Widen the year range, relax filters, or re-check codes with faostat_resolve_codes${input.include_aggregates ? '' : ' (aggregates are excluded by default — set include_aggregates=true for regional roll-ups)'}.`,
      );
      return {
        domain: code,
        observations: [],
        spilled: false,
        truncated: false,
        ...(availableElements !== undefined ? { available_elements: availableElements } : {}),
      };
    }

    // Spill when the match set exceeds the inline budget AND canvas is on. An
    // inexact total means more rows matched than were probed (past the inline budget).
    const shouldSpill = !totalIsExact || total > INLINE_PREVIEW_ROWS;
    if (shouldSpill && !canvasEnabled()) {
      throw ctx.fail(
        'canvas_disabled',
        `Result exceeds the ${INLINE_PREVIEW_ROWS}-row inline budget but DataCanvas is disabled.`,
      );
    }

    if (shouldSpill) {
      const staged = await stageObservations(
        ctx,
        mirror.streamObservations(code, filters, STAGE_MAX_ROWS + 1, signal),
        {
          sourceTool: 'faostat_query_observations',
          schema: OBSERVATION_TABLE_SCHEMA,
          // Spill on the caller's inline budget as well as the char budget, so a
          // result that drains under the char budget but exceeds `limit` still
          // lands on a table instead of forcing a choice between ignoring `limit`
          // and dropping rows with no recovery path (#14, without regressing #1).
          previewLimit: input.limit,
          queryParams: {
            domain: code,
            area_codes: input.area_codes,
            item_codes: input.item_codes,
            item_codes_text: input.item_codes_text,
            source_codes: input.source_codes,
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
        // drained under both budgets — the COMPLETE set. Capping at `limit` is safe
        // on either branch: staging spills on the row budget too, so a set larger
        // than `limit` is on the canvas table in full. That honors `limit` (#14)
        // without reopening the dead band where capping dropped rows (#1).
        const observations = (staged.previewRows as unknown as ObservationRow[])
          .slice(0, input.limit)
          .map(toObservation);
        // The stream yields the exact match count when it drains under the staging
        // cap, so staged.rowCount is the exact total when !truncated (and the exact
        // size of an inline-fit set), or the cap (a floor) when truncated.
        ctx.enrich.total(staged.rowCount);
        if (staged.spilled) {
          // The pointer travels with the id: describe by name (a canvas_id alone
          // lists every table on the canvas), then query.
          const describe = `faostat_dataframe_describe (name ${staged.tableName}, canvas_id ${staged.canvasId})`;
          if (staged.truncated) {
            ctx.enrich.notice(
              `Matched more than ${STAGE_MAX_ROWS} observations — only the first ${staged.rowCount} were staged on canvas table ${staged.tableName} (staging cap ${STAGE_MAX_ROWS}) — the staged set is a PREFIX, not the complete result. Call ${describe} for its columns and types, then faostat_dataframe_query to analyze the staged rows. To capture the rest, re-call faostat_query_observations partitioned by year (year_start/year_end) or with narrower area_codes/item_codes/element_codes so each partition stays under the cap, then query each with faostat_dataframe_query (canvas_id ${staged.canvasId}).`,
            );
          } else {
            ctx.enrich.notice(
              `Result of ${staged.rowCount} observations staged on canvas table ${staged.tableName} (canvas_id ${staged.canvasId}); the first ${observations.length} are shown inline. Call ${describe} for its columns and types, then faostat_dataframe_query for GROUP BY, ranking, and time-series analysis over the full set.`,
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
    // `!totalIsExact` is its own trigger, not a refinement of the row comparison:
    // the probe fetches max(limit, 50) rows, so an overflowing probe with a limit
    // at or above the inline budget leaves total === inline.length while the real
    // match is larger. Without this the canvas-failure fallback returns a capped
    // page reporting itself as the whole exact result — a silent drop.
    if (!totalIsExact || total > inline.length) {
      ctx.enrich.notice(
        `Showing ${inline.length} of ${totalIsExact ? total : `more than ${total}`} observations (inline page)${shouldSpill ? ' — staging the full set to a canvas table failed, so the rows past this page are not on a table' : ''}. Raise limit (max 1000) to return more rows, or narrow the filters.`,
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
      // Not "the full result": the inline page is capped at `limit`, and a failed
      // canvas op also lands here. The enrichment notice carries the exact total.
      lines.push('_Returned inline — no canvas table was staged for this result._\n');
    }
    lines.push(`**${result.observations.length} observation(s)** in ${result.domain}\n`);
    if (result.available_elements !== undefined) {
      lines.push(
        'Elements observed for the selected items across this domain; these do not establish requested area/year/source coverage:',
      );
      if (result.available_elements.length === 0)
        lines.push('_No elements available for these items._');
      for (const element of result.available_elements)
        lines.push(
          `- **${element.code}** — ${markdownCell(element.name)} (units: ${element.units.length ? element.units.map(markdownCell).join(', ') : 'unspecified'})`,
        );
    }
    if (result.observations.length === 0) {
      lines.push('_No observations._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('| Area | Item | Element | Year | Value | Unit | Flag | Period | Source |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const o of result.observations) {
      const itemCode = [o.item_code, o.item_code_text]
        .filter((value) => value !== null)
        .join(' / ');
      lines.push(
        `| ${markdownCell(o.area)} (${o.area_code}) | ${markdownCell(o.item)} (${markdownCell(itemCode)}) | ${markdownCell(o.element)} (${o.element_code}) | ${o.year} | ${o.value_qualifier ?? ''}${o.value ?? ''} | ${markdownCell(o.unit)} | ${markdownCell(o.flag)} | ${markdownCell(o.period)} | ${markdownCell(o.source)}${o.source_code === null ? '' : ` (${o.source_code})`} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
