/**
 * @fileoverview `faostat_query_observations` — the core data tool. Queries a
 * domain's cube by area(s), item(s), element(s), and year range from the local
 * mirror, returning observations with their data-quality flag. Excludes
 * aggregate regions by default so a naive sum doesn't double-count World + its
 * members. Returns one page of up to `limit` rows from an `offset` of at most
 * {@link OFFSET_CAP}, with `nextOffset` while rows remain and the next page starts
 * within that bound; with DataCanvas on, a first page whose match exceeds `limit`
 * also stages the whole match to a canvas table for SQL through
 * faostat_dataframe_query.
 * @module mcp-server/tools/definitions/query-observations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { countInput } from '@/mcp-server/tools/count-input.js';
import { markdownCell } from '@/mcp-server/tools/markdown-cell.js';
import {
  canvasEnabled,
  OBSERVATION_TABLE_SCHEMA,
  STAGE_MAX_ROWS,
  stageObservations,
} from '@/services/canvas-staging.js';
import type { ObservationRow } from '@/services/faostat-mirror/index.js';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';

/**
 * `totalCount` is exact up to this many matches and, on any page but the last, a
 * floor beyond — the staging cap, so a staged first page and a counted page report
 * one total. The last page counts its match exactly, whatever its size.
 */
export const TOTAL_COUNT_CAP = STAGE_MAX_ROWS;

/**
 * The deepest `offset` the tool accepts: offset paging reaches the first 100,000 rows
 * of a match plus one page, and a larger match is partitioned by year or codes
 * instead. Twice {@link STAGE_MAX_ROWS}, so the rows past a staged table truncated at
 * the staging cap stay reachable by `offset`.
 */
export const OFFSET_CAP = 2 * STAGE_MAX_ROWS;

/** Observations per page. */
const LIMIT = countInput({
  tool: 'faostat_query_observations',
  name: 'limit',
  default: 200,
  cap: 1000,
  description: (cap) =>
    `Observations per page, at most ${cap} per call. Rows past the page are never dropped silently: nextOffset continues from them, and with DataCanvas on a first page (offset 0) whose match exceeds limit also stages the whole match to a canvas table (canvas_id + table_name).`,
});

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
  description: `Query a FAOSTAT domain's data cube by area(s), item(s), element(s), sources, and year range, returning values with units and data-quality flags. Resolve numeric codes or exact alphanumeric item identities with faostat_resolve_codes; element resolution accepts item selectors and returns units. Empty queries with explicit items and elements list available elements for those items across the domain, without establishing area/year/source coverage. Aggregate regions are excluded by default; include_aggregates=true returns roll-ups, and explicit area_codes are honored verbatim. Item groups can overlap their members even with matching units; they remain included, and kind=null does not establish safe-to-sum. Keep source methodologies separate. Returns up to limit rows from offset, in year order; pass nextOffset back as offset for the next page, up to offset ${OFFSET_CAP}, and partition a larger match by year or codes. With DataCanvas on, a first page (offset 0) whose match exceeds limit also stages the whole match to a DataCanvas table (canvas_id + table_name); call faostat_dataframe_describe for its columns, then faostat_dataframe_query for SQL over every row. Honor every row's flag: commonly A=Official, B=time-series break, E=Estimated, I=Imputed, M=Missing, T=Unofficial, X=international organization; unrecognized flags never establish official status.`,
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },

  enrichment: {
    ...LIMIT.enrichment,
    totalCount: z
      .number()
      .describe(
        'Observations the filters matched. Exact up to 50,000, and exact on the last page of any match; on any other page past 50,000 it is 50,000, a floor — more matched — and totalCountIsFloor is true. A staged first page reports the staged table row count, capped the same way (truncated is then true).',
      ),
    totalCountIsFloor: z
      .boolean()
      .optional()
      .describe(
        'True when totalCount (50,000) is a floor and not the match size: more than 50,000 observations matched and this page is not the last. Absent when totalCount is exact.',
      ),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe(
        `Offset of the next page — pass it back as offset to continue. Present while rows remain past this page; absent on the last page, past the end of the match, and when the next page would start past offset ${OFFSET_CAP}, the deepest offset accepted (the notice then says how to reach the rest).`,
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on empty results, aggregate exclusion, paging, an offset past the end, the end of offset paging, or how to reach the staged table.',
      ),
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
    // Raised by the staging layer when it resolves the caller's canvas_id.
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'A first page (offset 0) whose match exceeds limit stages with DataCanvas on, and canvas_id does not resolve to a live canvas — unknown, expired, or owned by another tenant. A page that holds the whole match, any offset above 0, and a server with DataCanvas off stage nothing and never consult canvas_id.',
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
    // Raised by the mirror read pool once server shutdown has closed it.
    {
      reason: 'pool_closed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      retryable: true,
      when: 'The server was shutting down and closed its mirror read workers while this call was queued or running.',
      recovery: 'Retry once the server is back up; this call did not complete.',
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
    limit: LIMIT.schema,
    // A position, not a count: never served at the bound, in either count-input mode.
    offset: z
      .number()
      .int()
      .min(0)
      .max(OFFSET_CAP, {
        error: `Send ${OFFSET_CAP} or less. Offset paging reaches at most ${OFFSET_CAP} rows into a match, so narrow the query with year_start/year_end, area_codes, item_codes, or element_codes until the rows you need fall inside that range, then page from offset 0.`,
      })
      .default(0)
      .describe(
        `Zero-based position of the page’s first row in the match, in year order. Pass the nextOffset a previous call returned to fetch the following page; a page past the first stages nothing. At most ${OFFSET_CAP}, so offset paging reaches the first ${OFFSET_CAP} rows of a match plus one page; to reach rows past that, partition the query by year (year_start/year_end) or narrower area_codes, item_codes, or element_codes, and page each part from offset 0.`,
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID to stage onto, as returned by a prior faostat_query_observations / faostat_commodity_profile call — exactly 10 characters of letters, digits, hyphens, and underscores. Consulted only when this call stages: a first page whose match exceeds limit, with DataCanvas on. Omit to stage onto this session’s canvas, created on the first stage and reused by every later call, so tables staged earlier in the session sit alongside this one.',
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
      .describe('One page of observations: up to limit rows from offset, in year order.'),
    spilled: z
      .boolean()
      .describe(
        'True when the whole match was staged on a DataCanvas table — only on a first page (offset 0) whose match exceeds limit, with DataCanvas on.',
      ),
    truncated: z
      .boolean()
      .describe(
        `True when the staged table hit the 50,000-row staging cap — the staged set is a PREFIX of the match, not the complete result. The rows past it start at offset 50000; page on from there up to offset ${OFFSET_CAP}, or partition the query by year or code ranges and stage each part.`,
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

    const limit = LIMIT.clamp(ctx, input.limit);
    /** Write the call's one notice (`ctx.enrich.notice` keeps the last write), a clamped limit first. */
    const notify = (guidance?: string) => {
      const parts = [...(limit.clamped ? [limit.notice] : []), ...(guidance ? [guidance] : [])];
      if (parts.length > 0) ctx.enrich.notice(parts.join(' '));
    };

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
      notify(
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

    // One ceiling for the call, across the page, the staging stream, and the count.
    const signal = mirror.readSignal(ctx.signal);

    // The page itself, read one row past limit: an overflow says rows remain past
    // the page without counting the match.
    const { rows, totalIsExact: lastPage } = await mirror.queryObservations(
      code,
      { ...filters, limit: limit.effective, offset: input.offset },
      signal,
    );

    /** The match size, counted at most one row past the cap: exact, or the cap as a floor. */
    const countMatch = async (): Promise<{ total: number; exact: boolean }> => {
      const counted = await mirror.countObservations(code, filters, TOTAL_COUNT_CAP, signal);
      return { total: Math.min(counted, TOTAL_COUNT_CAP), exact: counted <= TOTAL_COUNT_CAP };
    };

    // An empty page past offset 0 is either past the end of a match or no match.
    const pastEnd = rows.length === 0 && input.offset > 0 ? await countMatch() : undefined;
    if (pastEnd && pastEnd.total > 0) {
      ctx.enrich.total(pastEnd.total);
      if (!pastEnd.exact) ctx.enrich({ totalCountIsFloor: true });
      notify(
        pastEnd.exact
          ? `Offset ${input.offset} is past the end of the ${pastEnd.total} matching observations, so this page is empty. Call again with offset ${Math.floor((pastEnd.total - 1) / limit.effective) * limit.effective} for the last page.`
          : `Offset ${input.offset} is past the end of the match, so this page is empty; more than ${TOTAL_COUNT_CAP} observations matched (totalCount ${TOTAL_COUNT_CAP} is a floor). Call again with a lower offset — offset ${TOTAL_COUNT_CAP} still returns rows.`,
      );
      return { domain: code, observations: [], spilled: false, truncated: false };
    }

    if (rows.length === 0) {
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
      notify(
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

    const observations = rows.map(toObservation);
    // The first row past this page, while rows remain. nextOffset offers it only within
    // OFFSET_CAP; on a first page it is the page size, always within, so the staging
    // gate below still reads nextOffset as "rows remain".
    const following = lastPage ? undefined : input.offset + rows.length;
    const nextOffset = following !== undefined && following <= OFFSET_CAP ? following : undefined;

    // A first page that overflowed stages the whole match when the canvas is on;
    // later pages, and a page that holds the whole match, stage nothing.
    let stagingFailed = false;
    if (nextOffset !== undefined && input.offset === 0 && canvasEnabled()) {
      const staged = await stageObservations(
        ctx,
        mirror.streamObservations(code, filters, STAGE_MAX_ROWS + 1, signal),
        {
          sourceTool: 'faostat_query_observations',
          schema: OBSERVATION_TABLE_SCHEMA,
          // The stream overflows `limit`, so the buffered set registers even when it
          // fits the char budget: every row past the page is on the table (#14).
          previewLimit: limit.effective,
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
      if (staged?.spilled) {
        // The stream yields the exact match count when it drains under the staging
        // cap, so staged.rowCount is the exact total when !truncated, or the cap (a
        // floor) when truncated.
        ctx.enrich.total(staged.rowCount);
        ctx.enrich({ nextOffset, ...(staged.truncated ? { totalCountIsFloor: true } : {}) });
        // The pointer travels with the id: describe by name (a canvas_id alone
        // lists every table on the canvas), then query.
        const describe = `faostat_dataframe_describe (name ${staged.tableName}, canvas_id ${staged.canvasId})`;
        notify(
          staged.truncated
            ? `Matched more than ${STAGE_MAX_ROWS} observations — only the first ${staged.rowCount} were staged on canvas table ${staged.tableName} (staging cap ${STAGE_MAX_ROWS}) — the staged set is a PREFIX, not the complete result. Call ${describe} for its columns and types, then faostat_dataframe_query to analyze the staged rows. To reach the rest, call again with offset ${staged.rowCount} (the first row past the staged prefix) and follow nextOffset, or re-call faostat_query_observations partitioned by year (year_start/year_end) or with narrower area_codes/item_codes/element_codes so each partition stays under the cap, then query each with faostat_dataframe_query (canvas_id ${staged.canvasId}).`
            : `Result of ${staged.rowCount} observations staged on canvas table ${staged.tableName} (canvas_id ${staged.canvasId}); the first ${observations.length} are shown inline. Call ${describe} for its columns and types, then faostat_dataframe_query for GROUP BY, ranking, and time-series analysis over the full set — or continue with offset ${nextOffset} for the next page.`,
        );
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
      // A canvas op that failed outright: the page and offset paging still answer.
      stagingFailed = staged === undefined;
      if (stagingFailed)
        ctx.log.warning('Canvas staging failed; returning the page', { limit: limit.effective });
    }

    // The last page knows its total; any other page counts the match.
    const matched =
      following === undefined
        ? { total: input.offset + rows.length, exact: true }
        : await countMatch();
    ctx.enrich.total(matched.total);
    if (!matched.exact) ctx.enrich({ totalCountIsFloor: true });
    if (nextOffset !== undefined) ctx.enrich({ nextOffset });
    // Past OFFSET_CAP the next call is a partition; a query pinned to one year cannot split by year.
    const continuation =
      nextOffset !== undefined
        ? `Continue with offset ${nextOffset} for the next page.`
        : `Offset paging ends here: the next page would start past offset ${OFFSET_CAP}, the deepest offset this tool accepts. To reach the rows past it, partition the query ${input.year_start !== undefined && input.year_start === input.year_end ? '' : 'by year (year_start/year_end) or '}with narrower area_codes, item_codes, or element_codes, and page each part from offset 0.`;
    // The last page names no next call; a clamped limit is still disclosed there.
    notify(
      following === undefined
        ? undefined
        : `${stagingFailed ? 'Staging the full set to a canvas table failed, so the rows past this page are on no table — page through them with offset. ' : ''}Showing observations ${input.offset + 1}–${following} of ${matched.exact ? matched.total : `more than ${TOTAL_COUNT_CAP} (totalCount ${TOTAL_COUNT_CAP} is a floor)`}. ${continuation}`,
    );
    return {
      domain: code,
      observations,
      spilled: false,
      truncated: false,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.spilled && result.truncated) {
      lines.push(
        `Result spilled to canvas table **${result.table_name}** (canvas_id ${result.canvas_id}) but was TRUNCATED at the staging cap — only the first ${result.staged_row_count} row(s) were staged, so the table is INCOMPLETE. The first page is below; call again with offset ${result.staged_row_count} to page past the staged prefix, or partition the query by year (year_start/year_end) or narrower codes and re-run to stage the rest.\n`,
      );
    } else if (result.spilled) {
      lines.push(
        `Full result spilled to canvas table **${result.table_name}** (canvas_id ${result.canvas_id}). The first page is below — query the table for the complete set, or follow nextOffset for the next page.\n`,
      );
    } else {
      // Not "the full result": the page is capped at `limit`, and a failed canvas op
      // also lands here. The enrichment trailer carries the total and nextOffset.
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
