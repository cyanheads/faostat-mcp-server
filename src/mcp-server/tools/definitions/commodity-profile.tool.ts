/**
 * @fileoverview `faostat_commodity_profile` — a workflow tool that assembles a
 * global profile for one commodity in a single call: top producers, the annual
 * trend, and trade flows (top importers/exporters), drawn from the production
 * (QCL) and trade (TCL) domains. Convenience over chaining
 * faostat_resolve_codes + several faostat_query_observations calls. The elements
 * follow what the item carries (#51): Production and tonne trade quantities for
 * an item with Production, Stocks and every trade quantity element it carries for
 * the live-animal items that have none. Rankings and the trend are SQL aggregates
 * over the full filtered match — summed per country for the selected item, each
 * country taken at its own latest year with data. Returns a QCL-only result with a
 * notice when the trade domain isn't indexed; fails when the production domain isn't.
 * @module mcp-server/tools/definitions/commodity-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { countInput } from '@/mcp-server/tools/count-input.js';
import { markdownCell } from '@/mcp-server/tools/markdown-cell.js';
import {
  canvasEnabled,
  PROFILE_TABLE_SCHEMA,
  STAGE_MAX_ROWS,
  stageObservations,
} from '@/services/canvas-staging.js';
import type {
  AreaAggregateRow,
  ObservationQuery,
  YearAggregateRow,
} from '@/services/faostat-mirror/index.js';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';

/** Production domain. */
const QCL = 'QCL';
/** Production (t). An item with any Production row ranks on it alone. */
const ELEMENT_PRODUCTION = 5510;
/**
 * Stocks in head (5111), thousand head (5112), and number (5114): the QCL
 * elements of the live-animal items, which carry no Production rows. On the mirror
 * as synced no item carries Production and Stocks, nor two Stocks elements; an
 * item that did would rank on Production, or on every Stocks element by unit.
 */
const STOCKS_ELEMENTS = [5111, 5112, 5114];
/** Trade domain. */
const TCL = 'TCL';
/** Export/import quantity in tonnes — a Production item's trade rankings keep these alone. */
const ELEMENT_EXPORT_QTY = 5910;
const ELEMENT_IMPORT_QTY = 5610;
/** Every export/import quantity element, one per unit (No, An, 1000 An, t). */
const EXPORT_QUANTITY_ELEMENTS = [5907, 5908, 5909, ELEMENT_EXPORT_QTY];
const IMPORT_QUANTITY_ELEMENTS = [5607, 5608, 5609, ELEMENT_IMPORT_QTY];

/** Maximum candidate identities shown when the caller must select an item. */
const MAX_ITEM_CANDIDATES = 5;

/** Rows per ranking; a larger value is served at the cap (#56). */
const TOP_N = countInput({
  tool: 'faostat_commodity_profile',
  name: 'top_n',
  default: 10,
  cap: 50,
  description: (cap) =>
    `Rows in each ranking (top producers, exporters, importers), at most ${cap} per call.`,
});

/**
 * Whether the trade domain (TCL) contributed to the profile, and — when it did
 * not — which of the two unavailable states applies. They carry different
 * remedies: a domain outside the mirror selection needs a config change, one
 * mid-sync needs only a retry, so they are never collapsed into one flag.
 */
type TradeStatus = 'available' | 'indexing' | 'not_selected';

/** Shared description for the aggregated data-quality flag set. */
const FLAGS_DESCRIPTION =
  'Distinct data-quality flags across the summed observations, comma-separated and sorted — commonly A=Official, B=time-series break, E=Estimated, I=Imputed, M=Missing (value cannot exist), T=Unofficial, X=from an international organization, plus others FAOSTAT defines per domain; treat any unrecognized flag as informational, never assume official. Null when no summed observation carried a flag. More than one flag means the total mixes data qualities.';

/** Output schema for one ranked-area list (producers / exporters / importers). */
function rankedAreas(valueDescription: string, entryDescription: string, listDescription: string) {
  return z
    .array(
      z
        .object({
          area_code: z.number().describe('Country code.'),
          area: z.string().describe('Country name.'),
          value: z.number().describe(valueDescription),
          observations: z
            .number()
            .describe('Observations summed into value for the selected item and reporting year.'),
          unit: z
            .string()
            .nullable()
            .describe(
              'Unit of measure for value; null when unspecified. Rows are grouped by unit, so values in different units are never summed together — a country can appear once per unit.',
            ),
          year: z
            .number()
            .describe(
              "This country's own latest year with data, computed per country — a country whose series ends earlier still ranks, at its own last reported year; years_behind says how far that trails the ranking.",
            ),
          years_behind: z
            .number()
            .int()
            .describe(
              "The ranking's latest year minus year: 0 when this row is current. The ranking's latest year is the newest year among every row it matched — all countries and units within year_start/year_end — not only the rows returned. A positive value marks a series that stopped earlier, such as a dissolved state or a country that stopped reporting the item; year_start set to the ranking's latest year keeps only current rows.",
            ),
          flags: z.string().nullable().describe(FLAGS_DESCRIPTION),
        })
        .describe(entryDescription),
    )
    .describe(listDescription);
}

/** Output schema for the elements one ranking used, with their units. */
function rankingElementList(description: string) {
  return z
    .array(
      z
        .object({
          element_code: z.number().describe('FAOSTAT element code.'),
          element: z
            .string()
            .nullable()
            .describe('Element label; null when the element vocabulary has no label for the code.'),
          units: z
            .array(z.string().nullable())
            .describe(
              'Units of the rows the ranking matched for this element within the year bounds; null is an unspecified unit. Empty when no row in the bounds carries the element.',
            ),
        })
        .describe('One element the ranking used.'),
    )
    .describe(description);
}

/** An element as headings and notices name it: `Stocks 5111 (An)`, units when known. */
function elementLabel(e: {
  element: string | null;
  element_code: number;
  units?: (string | null)[];
}): string {
  const units = e.units?.length ? ` (${e.units.map((u) => u ?? 'unspecified').join(', ')})` : '';
  return `${e.element ?? 'element'} ${e.element_code}${units}`;
}

export const commodityProfileTool = tool('faostat_commodity_profile', {
  title: 'faostat-mcp-server: commodity profile',
  description:
    "Assemble a global profile for one QCL item in a single call: top-producing countries, the annual trend, and trade flows (top exporters and importers). The elements follow what the item carries: Production (5510) and tonne trade quantities (5610/5910) for an item with Production; for live-animal items, which have none, their Stocks elements and every trade quantity element they carry. ranking_elements names each ranking's elements and units. Supply item_code or item_query; code wins when both are supplied. A query selects a unique normalized exact label, otherwise a unique relevance match; ambiguous queries require an explicit code. Each ranking uses the selected item at each country's own latest year with data, grouped by unit. The trend is returned inline as year/value points. Country-level only (aggregates excluded). QCL is required; unavailable TCL yields a profile without trade, with a notice. When the merged observation set is too large to inline, it spills to a DataCanvas table (canvas_id + table_name) — call faostat_dataframe_describe for its columns, then faostat_dataframe_query for deeper SQL.",
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },

  enrichment: {
    ...TOP_N.enrichment,
    resolvedItemCodes: z.array(z.number()).describe('Item codes the commodity query resolved to.'),
    resolvedItemMatches: z
      .number()
      .describe('Number of selected QCL items; always one for a successful profile.'),
    itemsTruncated: z
      .boolean()
      .describe('Always false: successful profiles select one item without truncating selection.'),
    notice: z
      .string()
      .optional()
      .describe(
        'States where the observation set went — the canvas table, inline result, staging failure, or disabled canvas — plus unavailable trade data, mixed units, or other partial-result context.',
      ),
  },

  // resolvedItemCodes is an array — give it a markdown trailer renderer so the
  // content[] line is a readable list, not a raw JSON blob.
  enrichmentTrailer: {
    resolvedItemCodes: { render: (codes) => `**Resolved item codes:** ${codes.join(', ')}` },
  },

  errors: [
    {
      reason: 'missing_item',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither item_code nor item_query was supplied.',
      recovery: 'Supply item_code or item_query to select one QCL item.',
    },
    {
      reason: 'ambiguous_item',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The query matches more than one QCL item without a unique exact label.',
      recovery:
        'Call faostat_resolve_codes with domain QCL, dimension item and the same query, then call faostat_commodity_profile with the selected item_code.',
    },
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query matched no item, or item_code is absent from QCL.',
      recovery:
        'Call faostat_resolve_codes with domain QCL and dimension item, then pass a returned code as item_code.',
    },
    {
      reason: 'domain_not_indexed',
      code: JsonRpcErrorCode.NotFound,
      when: 'The production domain (QCL) is not in the local mirror selection (FAOSTAT_DOMAINS), so there is no production data to profile.',
      recovery:
        'This deployment’s mirror must include the production domain: add QCL to FAOSTAT_DOMAINS and re-sync. Until then, faostat_query_observations answers on any indexed domain (faostat_list_domains shows the indexed flag).',
    },
    {
      reason: 'index_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The production domain (QCL) is selected, but its mirror is cold — its initial sync has never completed.',
      retryable: true,
      recovery:
        'Wait for the initial sync to finish, or run the mirror init script, then retry shortly.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'year_start is greater than year_end — a self-contradictory range that can never match. The bounds reach the production, trade, and merged canvas-stream queries alike, so every one of them would return nothing.',
      recovery:
        'Pass year_start ≤ year_end, or omit one bound to leave that side of the range open.',
    },
    // Raised by the staging layer when it resolves the caller's canvas_id.
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'DataCanvas is enabled and canvas_id does not resolve to a live canvas — unknown, expired, or owned by another tenant.',
      recovery:
        'Omit canvas_id to stage onto this session’s canvas, or pass a canvas_id returned within the 2-hour table TTL by an earlier faostat_query_observations / faostat_commodity_profile call.',
    },
    // Raised by the mirror read pool when the call's ceiling fires.
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      retryable: true,
      when: "The profile's mirror reads (commodity resolution, rankings, trend, staging stream) — time queued behind other calls plus execution — ran past the 45-second per-call ceiling.",
      recovery:
        'Retry shortly, or bound the profile with year_start/year_end so it reads fewer rows (the rankings then cover only that window); the 45-second ceiling includes time this call spent queued behind other mirror reads.',
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
    item_code: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Exact item code present in QCL; takes precedence over item_query. Obtain it from faostat_resolve_codes with domain QCL and dimension item.',
      ),
    item_query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Commodity label or search term (e.g. "Wheat"). A unique normalized exact QCL label wins, otherwise the relevance search must match exactly one item. Broad queries such as "maize" or "milk" require item_code. Supply this or item_code.',
      ),
    year_start: z
      .number()
      .int()
      .optional()
      .describe(
        "Inclusive start year (e.g. 1990) for the rankings, the trend, and the staged rows. An area with no data from this year on drops out of the rankings; set it to a ranking's latest year to keep only current rows.",
      ),
    year_end: z
      .number()
      .int()
      .optional()
      .describe(
        'Inclusive end year (e.g. 2022) for the rankings, the trend, and the staged rows; each area then ranks at its latest year up to this one.',
      ),
    top_n: TOP_N.schema,
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID to stage onto, as returned by a prior faostat_query_observations / faostat_commodity_profile call — exactly 10 characters of letters, digits, hyphens, and underscores. Omit to stage onto this session’s canvas, created on the first spill and reused by every later call, so tables staged earlier in the session sit alongside this one.',
    ),
  }),

  output: z.object({
    item_query: z
      .string()
      .describe('Supplied query echoed back, or the canonical selected label for code-only calls.'),
    resolved_items: z
      .array(
        z
          .object({
            code: z.number().describe('Resolved item code.'),
            name: z.string().describe('Resolved item name.'),
          })
          .describe('One resolved commodity.'),
      )
      .describe('The single selected QCL item and its canonical label.'),
    ranking_elements: z
      .object({
        top_producers: rankingElementList(
          'QCL elements top_producers ranks and production_trend sums: Production (5510) when the item has any Production row, otherwise every Stocks element (5111, 5112, 5114) it carries. Empty when it carries none of them.',
        ),
        top_exporters: rankingElementList(
          'TCL elements top_exporters ranks: Export quantity 5910 for an item with Production, otherwise every export quantity element (5907–5910), of those the item carries. Empty when trade is unavailable or the item carries none of them.',
        ),
        top_importers: rankingElementList(
          'TCL elements top_importers ranks: Import quantity 5610 for an item with Production, otherwise every import quantity element (5607–5610), of those the item carries. Empty when trade is unavailable or the item carries none of them.',
        ),
      })
      .describe(
        'The elements and units behind each ranking, picked from what the selected item carries. Within a ranking, rows are grouped by unit and never summed across units.',
      ),
    top_producers: rankedAreas(
      'The ranked QCL element total for the selected item and country in its latest reporting year — Production, or Stocks for an item without Production rows.',
      'One top-ranked country.',
      'Top countries by the summed QCL element in ranking_elements.top_producers — Production, or Stocks (animals held) for live-animal items without Production rows. Countries only.',
    ),
    top_exporters: rankedAreas(
      'Export quantity for the selected item and country in its latest reporting year.',
      'One top-exporting country.',
      'Top exporters by summed export quantity (empty when trade is not indexed or the item carries no export quantity element).',
    ),
    top_importers: rankedAreas(
      'Import quantity for the selected item and country in its latest reporting year.',
      'One top-importing country.',
      'Top importers by summed import quantity (empty when trade is not indexed or the item carries no import quantity element).',
    ),
    production_trend: z
      .array(
        z
          .object({
            year: z.number().describe('Observation year.'),
            value: z
              .number()
              .describe(
                'The selected item’s ranking_elements.top_producers quantity summed across every country reporting that year.',
              ),
            observations: z
              .number()
              .describe(
                'Observations summed into value — read it alongside value, since a change in coverage moves the total independently of the quantity measured.',
              ),
            unit: z
              .string()
              .nullable()
              .describe(
                'Unit of measure for value; null when unspecified. Points are grouped by unit, so a year can appear once per unit rather than summing incomparable quantities.',
              ),
            flags: z.string().nullable().describe(FLAGS_DESCRIPTION),
          })
          .describe('One annual trend point.'),
      )
      .describe(
        'The annual series of the ranking_elements.top_producers elements — Production, or Stocks for an item without Production rows — for the selected item, summed over countries per year and ordered oldest-first. Aggregated in SQL over the complete filtered match, so it is not affected by the canvas staging cap.',
      ),
    trend_points: z
      .number()
      .describe(
        'Total observations aggregated into production_trend. Exact — the aggregation runs over the complete filtered match, not a capped page.',
      ),
    spilled: z
      .boolean()
      .describe('True when the merged observation set was staged on a canvas table.'),
    truncated: z
      .boolean()
      .describe(
        'True when the STAGED CANVAS TABLE hit the 50,000-row staging cap and is therefore a PREFIX of the merged observation set — re-query faostat_query_observations partitioned by year to stage the rest. The rankings and production_trend above are SQL aggregates over the complete match and stay exact either way.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID this call staged onto. When spilled it holds table_name — pass both to faostat_dataframe_describe (table_name as name) for the columns and types, then canvas_id to faostat_dataframe_query for SQL. Also present when the merged set fit inline and no table was staged; faostat_dataframe_describe with this canvas_id then lists any tables already staged on it. Absent when the canvas is disabled or staging failed.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'Canvas table holding the staged observations: the selected item’s QCL rows for the ranking_elements.top_producers elements, plus its TCL rows for the top_exporters and top_importers elements when trade contributed (present when spilled). The notice names which domains the table holds. Pass it as name to faostat_dataframe_describe for its columns (a domain column tags each row QCL or TCL), then reference it in faostat_dataframe_query SQL.',
      ),
    staged_row_count: z
      .number()
      .optional()
      .describe(
        'Rows actually staged on the merged canvas table (present when spilled). Equals the 50,000-row cap when truncated.',
      ),
  }),

  async handler(input, ctx) {
    const mirror = getFaostatMirror();

    // QCL is the backbone of the profile; require it to be selected + ready. Not
    // selected is a configuration gap no retry closes; selected but cold is not.
    if (!mirror.isSelected(QCL)) {
      throw ctx.fail(
        'domain_not_indexed',
        'The production domain (QCL) is not in the local mirror selection.',
      );
    }
    if (!(await mirror.ready(QCL))) {
      throw ctx.fail(
        'index_not_ready',
        'The production (QCL) mirror has not completed its initial sync.',
      );
    }

    // A reversed range is a contradiction every downstream query would silently
    // report as an empty-but-legitimate profile — reject it before resolving the
    // commodity or touching the cube. Equal bounds are a valid single-year range.
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

    // One ceiling for the call, across every mirror read below.
    const signal = mirror.readSignal(ctx.signal);
    if (input.item_code === undefined && input.item_query === undefined) {
      throw ctx.fail('missing_item', 'Supply item_code or item_query.');
    }

    // Resolve one identity before any ranking or staging; never add related products.
    const resolved = await mirror.resolve(QCL, 'item', {
      ...(input.item_code !== undefined ? { code: input.item_code } : {}),
      ...(input.item_query !== undefined ? { query: input.item_query } : {}),
      preferExact: true,
      limit: MAX_ITEM_CANDIDATES,
      signal,
    });
    const selected = resolved.matches[0];
    if (!selected || selected.code === null) {
      throw ctx.fail(
        'no_match',
        `No QCL item matched ${input.item_code ?? `"${input.item_query}"`}.`,
      );
    }
    if (resolved.total > 1) {
      const candidates = resolved.matches.map((item) => `${item.code}: ${item.name}`).join('; ');
      throw ctx.fail(
        'ambiguous_item',
        `${resolved.total} QCL items match "${input.item_query}". Candidates${resolved.total > resolved.matches.length ? ` (showing ${resolved.matches.length} of ${resolved.total}; truncated)` : ''}: ${candidates}.`,
      );
    }
    const itemQuery = input.item_query ?? selected.name;
    const itemCodes = [selected.code];
    ctx.enrich({
      resolvedItemCodes: itemCodes,
      resolvedItemMatches: resolved.total,
      itemsTruncated: false,
    });

    const yearRange = {
      ...(input.year_start !== undefined ? { yearStart: input.year_start } : {}),
      ...(input.year_end !== undefined ? { yearEnd: input.year_end } : {}),
    };
    // Each ranking is served at most the cap; topN.effective is the bound from here on.
    const topN = TOP_N.clamp(ctx, input.top_n);

    /*
     * Every aggregation below runs against the same filter shape — only the
     * elements differ — so the rankings, the trend, and the staged canvas table
     * all describe one population rather than three near-identical ones.
     */
    const filtersFor = (elementCodes: number[]) => ({
      itemCodes,
      elementCodes,
      ...yearRange,
      includeAggregates: false,
    });
    const codesOf = (elements: { element_code: number }[]) => elements.map((e) => e.element_code);
    /** Each selected element named with the units its ranking's matched rows carry. */
    const withUnits = (
      elements: { element: string | null; element_code: number }[],
      units: { element_code: number; unit: string | null }[],
    ) =>
      elements.map((e) => ({
        element_code: e.element_code,
        element: e.element,
        units: units.filter((u) => u.element_code === e.element_code).map((u) => u.unit),
      }));

    /*
     * 2. Pick the elements from what the item carries (#51): Production when it has
     * any Production row, otherwise the Stocks elements it carries. The selection
     * read is item-bounded and ignores the year bounds, so the bounds never switch
     * an item between Production and Stocks.
     */
    const qclElements = await mirror.itemElements(QCL, itemCodes, signal);
    const hasProduction = qclElements.some((e) => e.element_code === ELEMENT_PRODUCTION);
    const producerElements = qclElements.filter((e) =>
      hasProduction
        ? e.element_code === ELEMENT_PRODUCTION
        : STOCKS_ELEMENTS.includes(e.element_code),
    );
    // A Production item keeps its tonne trade quantities; any other ranks every quantity element.
    const tradeCandidates = {
      exporters: hasProduction ? [ELEMENT_EXPORT_QTY] : EXPORT_QUANTITY_ELEMENTS,
      importers: hasProduction ? [ELEMENT_IMPORT_QTY] : IMPORT_QUANTITY_ELEMENTS,
    };

    // 3. Producer ranking + trend as SQL aggregates over the full filtered match.
    // Neither is a row-oriented page, so neither is bounded by the staging cap nor
    // skewed by the read path's `ORDER BY year ASC` ordering. An empty element list
    // reads nothing: the element filter would otherwise drop out and match them all.
    const producerCodes = codesOf(producerElements);
    const productionFilters = filtersFor(producerCodes);
    let topProducers: AreaAggregateRow[] = [];
    let trend: YearAggregateRow[] = [];
    let producerUnits: { element_code: number; unit: string | null }[] = [];
    if (producerCodes.length > 0) {
      topProducers = await mirror.rankAreaTotals(QCL, productionFilters, topN.effective, signal);
      trend = await mirror.sumByYear(QCL, productionFilters, signal);
      producerUnits = await mirror.elementUnits(QCL, productionFilters, signal);
    }

    // 4. Trade flows — only when TCL is selected + ready (partial result otherwise).
    // Selection and readiness are kept apart: each unavailable state gets its own
    // remedy in the notice below.
    let exporters: AreaAggregateRow[] = [];
    let importers: AreaAggregateRow[] = [];
    let exporterElements: { element: string | null; element_code: number }[] = [];
    let importerElements: { element: string | null; element_code: number }[] = [];
    let tradeUnits: { element_code: number; unit: string | null }[] = [];
    let tradeCodes: number[] = [];
    let tradeStatus: TradeStatus;
    if (!mirror.isSelected(TCL)) {
      tradeStatus = 'not_selected';
    } else if (!(await mirror.ready(TCL))) {
      tradeStatus = 'indexing';
    } else {
      tradeStatus = 'available';
      const tclElements = await mirror.itemElements(TCL, itemCodes, signal);
      exporterElements = tclElements.filter((e) =>
        tradeCandidates.exporters.includes(e.element_code),
      );
      importerElements = tclElements.filter((e) =>
        tradeCandidates.importers.includes(e.element_code),
      );
      if (exporterElements.length > 0) {
        exporters = await mirror.rankAreaTotals(
          TCL,
          filtersFor(codesOf(exporterElements)),
          topN.effective,
          signal,
        );
      }
      if (importerElements.length > 0) {
        importers = await mirror.rankAreaTotals(
          TCL,
          filtersFor(codesOf(importerElements)),
          topN.effective,
          signal,
        );
      }
      // One units read covers both trade rankings' elements.
      tradeCodes = codesOf([...exporterElements, ...importerElements]);
      if (tradeCodes.length > 0) {
        tradeUnits = await mirror.elementUnits(TCL, filtersFor(tradeCodes), signal);
      }
    }
    const rankingElements = {
      top_producers: withUnits(producerElements, producerUnits),
      top_exporters: withUnits(exporterElements, tradeUnits),
      top_importers: withUnits(importerElements, tradeUnits),
    };

    // 5. Stage the rows the rankings read for deeper SQL — the producer elements'
    // QCL rows, plus the trade elements' TCL rows when trade contributed. A disabled
    // canvas and a failed staging both leave canvasId unset; canvasOn tells the two
    // apart for the notice.
    const canvasOn = canvasEnabled();
    let spilled = false;
    let truncated = false;
    let stagedRowCount: number | undefined;
    let canvasId: string | undefined;
    let tableName: string | undefined;
    if (canvasOn) {
      const staged = await stageObservations(
        ctx,
        mergeStream(mirror, filtersFor, { QCL: producerCodes, TCL: tradeCodes }, signal),
        {
          sourceTool: 'faostat_commodity_profile',
          schema: PROFILE_TABLE_SCHEMA,
          /**
           * Record the selected code, supplied query (or canonical label for
           * code-only calls), and caller-named year bounds; staging drops undefined bounds.
           */
          queryParams: {
            item_query: itemQuery,
            item_code: selected.code,
            item_codes: itemCodes,
            year_start: input.year_start,
            year_end: input.year_end,
          },
          ...(input.canvas_id ? { canvasId: input.canvas_id } : {}),
        },
      );
      if (staged?.spilled) {
        spilled = true;
        truncated = staged.truncated;
        stagedRowCount = staged.rowCount;
        canvasId = staged.canvasId;
        tableName = staged.tableName;
      } else if (staged) {
        canvasId = staged.canvasId;
      }
    }

    // ctx.enrich.notice is last-wins, so every condition worth disclosing is
    // collected here and emitted as one call — the top_n clamp first. The rankings
    // have no further page, so the clamp names no next call.
    const noticeParts: string[] = topN.clamped ? [topN.notice] : [];
    if (producerElements.length === 0) {
      noticeParts.push(
        `${selected.name} carries no Production (${ELEMENT_PRODUCTION}) or Stocks (${STOCKS_ELEMENTS.join(', ')}) rows in QCL — its QCL elements are ${qclElements.map(elementLabel).join('; ')} — so top_producers and production_trend are empty.`,
      );
    } else if (!hasProduction) {
      noticeParts.push(
        `Stocks replaced Production: ${selected.name} has no Production (${ELEMENT_PRODUCTION}) rows in QCL, so top_producers and production_trend use ${rankingElements.top_producers.map(elementLabel).join('; ')} — Stocks count what is held, not what was produced.`,
      );
    }
    if (tradeStatus === 'available') {
      // Name the trade rankings the item gave no element, and which elements were looked for.
      const missing = [
        ...(exporterElements.length === 0
          ? [
              {
                field: 'top_exporters',
                what: `export quantity (${tradeCandidates.exporters.join(', ')})`,
              },
            ]
          : []),
        ...(importerElements.length === 0
          ? [
              {
                field: 'top_importers',
                what: `import quantity (${tradeCandidates.importers.join(', ')})`,
              },
            ]
          : []),
      ];
      if (missing.length > 0) {
        noticeParts.push(
          `TCL holds no ${missing.map((m) => m.what).join(' or ')} rows for ${selected.name}, so ${missing.map((m) => m.field).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} empty.`,
        );
      }
    }
    /*
     * Name every returned row that trails its ranking's latest year (#50), and the
     * year_start that leaves that ranking only current areas. Each ranking has its
     * own latest year, so the suggestion is per ranking. A lagging row's year is at
     * or after any year_start the call set and before the suggested one, so the
     * suggestion always narrows the call.
     */
    const lagging = (
      [
        ['top_producers', topProducers],
        ['top_exporters', exporters],
        ['top_importers', importers],
      ] as const
    ).flatMap(([field, rows]) => {
      const behind = rows.filter((r) => r.years_behind > 0);
      const [first] = behind;
      return first ? [{ field, latest: first.year + first.years_behind, rows: behind }] : [];
    });
    if (lagging.length > 0) {
      const byYear = new Map<number, string[]>();
      for (const { field, latest } of lagging)
        byYear.set(latest, [...(byYear.get(latest) ?? []), field]);
      const listed = lagging.map(
        ({ field, latest, rows }) =>
          `In ${field} (latest year ${latest}): ${rows.map((r) => `${r.area} (${r.area_code}) ${r.year}, ${r.years_behind} year${r.years_behind === 1 ? '' : 's'} behind`).join('; ')}.`,
      );
      const suggestions = [...byYear].map(
        ([year, fields]) =>
          `year_start ${year} leaves ${fields.join(' and ')} only areas reporting in ${year}`,
      );
      noticeParts.push(
        `Rows behind their ranking's latest year — each country ranks at its own latest year with data. ${listed.join(' ')} year_start restricts every ranking to areas with data from that year on, and production_trend to those years: ${suggestions.join('; ')}.`,
      );
    }
    const units = new Set(
      [...topProducers, ...exporters, ...importers, ...trend].map((r) => r.unit),
    );
    if (units.size > 1) {
      noticeParts.push(
        `The selected item reports in more than one unit (${[...units].map((u) => u ?? 'unspecified').join(', ')}). Rows are grouped by unit rather than summed across them, so a country or year can appear once per unit and values are comparable only within the same unit.`,
      );
    }
    if (tradeStatus === 'not_selected') {
      noticeParts.push(
        `Trade domain (TCL) is not in the local mirror selection — returning a profile without trade. Add TCL to FAOSTAT_DOMAINS and re-sync for import/export flows.`,
      );
    } else if (tradeStatus === 'indexing') {
      noticeParts.push(
        `Trade domain (TCL) is selected but has not finished its initial sync — returning a profile without trade. The mirror is already building it, so no configuration change is needed: check faostat_list_domains with code TCL for its index_ready flag, then call this profile again once it turns true.`,
      );
    }
    // Every staging branch states its disposition here: format() sees only the
    // output, where a failed staging and a disabled canvas look identical.
    const describeTable = `faostat_dataframe_describe (name ${tableName}, canvas_id ${canvasId})`;
    // The domains whose rows reached the staging stream, with the elements read from each.
    const stagedSources = [
      ...(producerCodes.length > 0 ? [{ domain: QCL, elementCodes: producerCodes }] : []),
      ...(tradeCodes.length > 0 ? [{ domain: TCL, elementCodes: tradeCodes }] : []),
    ];
    const stagedDomains = stagedSources.map((s) => s.domain);
    /*
     * Where the complete row-level series lives when the table cannot hold it: the
     * domains and elements the staging stream read, so following the pointer returns
     * the staged set and not every element the item carries. An item with no ranking
     * element staged nothing, and its rows are whatever QCL holds for it. The call's
     * year bounds ride along: the staging stream read within them, so a pointer
     * without them would return every year.
     */
    const yearBounds = [
      ...(input.year_start !== undefined ? [`year_start ${input.year_start}`] : []),
      ...(input.year_end !== undefined ? [`year_end ${input.year_end}`] : []),
    ];
    const rowLevelSource = `faostat_query_observations with item codes ${itemCodes.join(', ')} on ${stagedSources.map((s) => `${s.domain} (element codes ${s.elementCodes.join(', ')})`).join(' and ') || QCL}${yearBounds.length > 0 ? ` with ${yearBounds.join(' and ')}` : ''}`;
    if (truncated) {
      noticeParts.push(
        `The observation set exceeded the ${STAGE_MAX_ROWS}-row staging cap, so canvas table ${tableName} holds only the first ${stagedRowCount} rows and is INCOMPLETE. The rankings and trend above are unaffected — they are aggregated over the full match. Call ${describeTable} for its columns and types, then faostat_dataframe_query for the rows it holds. For the complete row-level series, call ${rowLevelSource} partitioned by year (year_start/year_end), then query each partition with faostat_dataframe_query (canvas_id ${canvasId}).`,
      );
    } else if (spilled) {
      // Name what actually reached the table: without trade rows only QCL rows were
      // staged, and SQL written against trade element codes would come back empty.
      const domains = stagedDomains.join(' + ');
      const staged =
        stagedDomains.length > 1
          ? `Merged ${domains} observations staged on canvas table ${tableName}`
          : `${domains} observations staged on canvas table ${tableName} — the table holds ${domains} rows only`;
      noticeParts.push(
        `${staged} (canvas_id ${canvasId}). Call ${describeTable} for its columns and types, then faostat_dataframe_query for row-level analysis beyond the rankings and trend above.`,
      );
    } else if (canvasId !== undefined) {
      // Canvas on, the set fit under the inline char budget so no table was
      // registered. Trade availability has no bearing here — a QCL-only set that
      // fits inline is as complete as a merged one — and the discriminator matches
      // format()'s so both surfaces report the same disposition. Do NOT advise
      // enabling a canvas that is already on (the dead-band notice bug). With no
      // producer element the sections are empty, so nothing claims a full result.
      noticeParts.push(
        `Merged set fit inline${producerCodes.length > 0 ? ' — the rankings and trend above cover the full result, so' : ', so'} no canvas table was staged for this call. canvas_id ${canvasId} is the canvas this call used; faostat_dataframe_describe (canvas_id ${canvasId}) lists any tables already staged on it, and faostat_dataframe_query runs SQL across them.`,
      );
    } else if (canvasOn) {
      // The canvas is on but staging failed outright — the enable advice would be wrong.
      noticeParts.push(
        `The observation set could not be staged to a canvas table, so this call returns no canvas_id. The rankings and trend above are aggregated over the full match and remain complete; for row-level data, call ${rowLevelSource}.`,
      );
    } else {
      noticeParts.push(
        'Merged set not staged to a canvas table (enable CANVAS_PROVIDER_TYPE=duckdb for deeper SQL on large results).',
      );
    }
    ctx.enrich.notice(noticeParts.join(' '));

    return {
      item_query: itemQuery,
      resolved_items: [{ code: selected.code, name: selected.name }],
      ranking_elements: rankingElements,
      top_producers: topProducers,
      top_exporters: exporters,
      top_importers: importers,
      production_trend: trend,
      trend_points: trend.reduce((sum, point) => sum + point.observations, 0),
      spilled,
      truncated,
      ...(canvasId !== undefined ? { canvas_id: canvasId } : {}),
      ...(tableName !== undefined ? { table_name: tableName } : {}),
      ...(stagedRowCount !== undefined ? { staged_row_count: stagedRowCount } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [`## Commodity profile: ${result.item_query}\n`];
    lines.push(
      `Resolved to: ${result.resolved_items.map((i) => `${i.name} (${i.code})`).join(', ')}\n`,
    );
    // Every section renders unconditionally: an omitted heading is indistinguishable
    // from "field not returned" to a content[]-only client. Each heading names the
    // elements and units its section used (ranking_elements).
    const heading = (title: string, elements: typeof result.ranking_elements.top_producers) =>
      elements.length > 0 ? `${title} — ${elements.map(elementLabel).join('; ')}` : title;
    const rankBlock = (title: string, rows: typeof result.top_producers) => {
      lines.push(`### ${title}`);
      if (rows.length === 0) {
        lines.push('_None._', '');
        return;
      }
      for (const r of rows) {
        lines.push(
          `- ${r.area} (${r.area_code}): ${r.value.toLocaleString()} ${r.unit ?? ''} [${r.year}, ${r.years_behind} yr behind, ${r.observations} obs${r.flags ? `, flags ${r.flags}` : ''}]`,
        );
      }
      lines.push('');
    };
    const elements = result.ranking_elements;
    rankBlock(heading('Top producers', elements.top_producers), result.top_producers);
    rankBlock(heading('Top exporters', elements.top_exporters), result.top_exporters);
    rankBlock(heading('Top importers', elements.top_importers), result.top_importers);

    lines.push(
      `### ${heading(`Production trend (${result.trend_points} observation(s))`, elements.top_producers)}`,
    );
    if (result.production_trend.length === 0) {
      lines.push('_None._', '');
    } else {
      lines.push('| Year | Value | Unit | Observations | Flags |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const p of result.production_trend) {
        lines.push(
          `| ${p.year} | ${p.value.toLocaleString()} | ${markdownCell(p.unit)} | ${p.observations} | ${markdownCell(p.flags)} |`,
        );
      }
      lines.push('');
    }

    // The output cannot say whether trade rows reached the table, so no line here
    // calls the staged set merged — the notice names what the table holds.
    if (result.truncated) {
      lines.push(
        `The observation set spilled to canvas table **${result.table_name}** (canvas_id ${result.canvas_id}) but was TRUNCATED at ${result.staged_row_count} rows, so that table is incomplete. The rankings and trend above are aggregated over the full match and remain exact. Query faostat_query_observations directly (partitioned by year) for the complete row-level series.`,
      );
    } else if (result.spilled) {
      lines.push(
        `Full observation set staged (spilled) on canvas table **${result.table_name}** (canvas_id ${result.canvas_id}) — query with faostat_dataframe_query.`,
      );
    } else if (result.canvas_id !== undefined) {
      // Canvas is on; the merged set fit under the inline budget so no table was
      // registered. The rankings and trend above are the complete answer — unless
      // the item gave them no element, when there is nothing to call complete.
      lines.push(
        elements.top_producers.length > 0
          ? '_Merged set fit inline — the figures above cover the full result._'
          : '_Merged set fit inline; no canvas table was staged._',
      );
    } else {
      // A disabled canvas or a failed staging — indistinguishable here, so the
      // notice carries the disposition.
      lines.push('_No canvas table was staged for this result._');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

/**
 * Merge the QCL and TCL observation streams behind the rankings for canvas
 * staging: each domain's rows for the elements its rankings used. Each stream is
 * bounded by the staging cap (+1 for overflow disclosure); the spillover helper
 * drains the merged iterable lazily and stops at the cap, so the total staged
 * never exceeds {@link STAGE_MAX_ROWS}. A domain with no elements — trade
 * unavailable, or an item that carries none of a domain's ranking elements — is
 * skipped entirely, since an empty element filter would match every element; the
 * notice names the domains that reached the table. Both streams read under the
 * call's `signal`, so the ceiling bounds the staging reads too.
 */
async function* mergeStream(
  mirror: ReturnType<typeof getFaostatMirror>,
  filtersFor: (elementCodes: number[]) => Omit<ObservationQuery, 'limit' | 'offset'>,
  elementCodes: Record<typeof QCL | typeof TCL, number[]>,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const streamLimit = STAGE_MAX_ROWS + 1;
  for (const domain of [QCL, TCL] as const) {
    const codes = elementCodes[domain];
    if (codes.length === 0) continue;
    for await (const row of mirror.streamObservations(
      domain,
      filtersFor(codes),
      streamLimit,
      signal,
    )) {
      yield { ...row, domain };
    }
  }
}
