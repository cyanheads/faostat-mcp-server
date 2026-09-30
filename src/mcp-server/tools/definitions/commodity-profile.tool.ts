/**
 * @fileoverview `faostat_commodity_profile` — a workflow tool that assembles a
 * global profile for one commodity in a single call: top producers, the annual
 * production trend, and trade flows (top importers/exporters), drawn from the
 * production (QCL) and trade (TCL) domains. Convenience over chaining
 * faostat_resolve_codes + several faostat_query_observations calls. Rankings and
 * the trend are SQL aggregates over the full filtered match — summed per country
 * across the resolved items, each country taken at its own latest year with data.
 * Returns a production-only result with a notice when the trade domain isn't
 * indexed; fails when the production domain isn't.
 * @module mcp-server/tools/definitions/commodity-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdownCell } from '@/mcp-server/tools/markdown-cell.js';
import {
  canvasEnabled,
  PROFILE_TABLE_SCHEMA,
  STAGE_MAX_ROWS,
  stageObservations,
} from '@/services/canvas-staging.js';
import type { AreaAggregateRow } from '@/services/faostat-mirror/index.js';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';

/** Production domain + Production element code. */
const QCL = 'QCL';
const ELEMENT_PRODUCTION = 5510;
/** Trade domain + Import/Export quantity element codes. */
const TCL = 'TCL';
const ELEMENT_EXPORT_QTY = 5910;
const ELEMENT_IMPORT_QTY = 5610;

/** Item codes the commodity name is allowed to fold into one profile. */
const MAX_PROFILE_ITEMS = 5;

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
            .describe(
              'Observations summed into value — one per resolved item reporting that year.',
            ),
          unit: z
            .string()
            .nullable()
            .describe(
              'Unit of measure for value; null when unspecified. Rows are grouped by unit, so values in different units are never summed together — a country can appear once per unit.',
            ),
          year: z
            .number()
            .describe(
              "This country's own latest year with data, computed per country — a country whose series ends earlier still ranks, at its own last reported year.",
            ),
          flags: z.string().nullable().describe(FLAGS_DESCRIPTION),
        })
        .describe(entryDescription),
    )
    .describe(listDescription);
}

export const commodityProfileTool = tool('faostat_commodity_profile', {
  title: 'faostat-mcp-server: commodity profile',
  description:
    "Assemble a global profile for one commodity in a single call: top-producing countries, the annual production trend, and trade flows (top exporters and importers). Accepts a commodity name, resolves it to item codes, then queries the production (QCL) and trade (TCL) domains and merges the results. Each ranking is a per-country sum across the resolved items, taken at that country's own latest year with data and grouped by unit so incomparable quantities are never added. The trend is returned inline as year/value points. Country-level only (aggregates excluded). The production domain (QCL) is required. When the trade domain (TCL) is not indexed locally, returns a production-only profile with a notice naming the gap rather than failing. When the merged observation set is too large to inline, it spills to a DataCanvas table (canvas_id + table_name) — call faostat_dataframe_describe for its columns, then faostat_dataframe_query for deeper SQL.",
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },

  enrichment: {
    resolvedItemCodes: z.array(z.number()).describe('Item codes the commodity query resolved to.'),
    resolvedItemMatches: z
      .number()
      .describe(
        `Total items the commodity query matched in QCL, before the ${MAX_PROFILE_ITEMS}-item profile cap.`,
      ),
    itemsTruncated: z
      .boolean()
      .describe(
        'True when the commodity name matched more items than the profile folded in — the profile then covers only the most relevant few.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'States where the observation set went — the canvas table it was staged on (with the describe-then-query pointer), fit inline, a staging failure, or a disabled canvas — plus a trade domain (TCL) that was not indexed, item-resolution truncation, mixed units in the rankings, or other partial-result context.',
      ),
  },

  // resolvedItemCodes is an array — give it a markdown trailer renderer so the
  // content[] line is a readable list, not a raw JSON blob.
  enrichmentTrailer: {
    resolvedItemCodes: { render: (codes) => `**Resolved item codes:** ${codes.join(', ')}` },
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'The item query resolved to no commodity code.',
      recovery: 'Try faostat_resolve_codes with dimension=item to find the commodity code.',
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
        'Retry, or bound the profile with year_start/year_end or a more specific item_query so it reads fewer rows.',
    },
  ],

  input: z.object({
    item_query: z
      .string()
      .min(1)
      .describe(
        `Commodity name to profile (e.g. "maize", "wheat", "coffee green"). Matched by relevance; the ${MAX_PROFILE_ITEMS} best-matching items are folded into one profile, so a broad name such as "milk" is narrowed — the response discloses how many items matched in total.`,
      ),
    year_start: z
      .number()
      .int()
      .optional()
      .describe('Inclusive start year for the trend (e.g. 1990).'),
    year_end: z.number().int().optional().describe('Inclusive end year for the trend (e.g. 2022).'),
    top_n: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Number of top producers / exporters / importers to return. Max 50.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID to stage onto, as returned by a prior faostat_query_observations / faostat_commodity_profile call — exactly 10 characters of letters, digits, hyphens, and underscores. Omit to stage onto this session’s canvas, created on the first spill and reused by every later call, so tables staged earlier in the session sit alongside this one.',
    ),
  }),

  output: z.object({
    item_query: z.string().describe('The commodity query echoed back.'),
    resolved_items: z
      .array(
        z
          .object({
            code: z.number().describe('Resolved item code.'),
            name: z.string().describe('Resolved item name.'),
          })
          .describe('One resolved commodity.'),
      )
      .describe('Commodities the query resolved to (the profile aggregates across all of them).'),
    top_producers: rankedAreas(
      'Production summed across the resolved items for this country, in its latest reporting year.',
      'One top-producing country.',
      'Top producers by summed production (countries only).',
    ),
    top_exporters: rankedAreas(
      'Export quantity summed across the resolved items for this country, in its latest reporting year.',
      'One top-exporting country.',
      'Top exporters by summed export quantity (empty when trade is not indexed).',
    ),
    top_importers: rankedAreas(
      'Import quantity summed across the resolved items for this country, in its latest reporting year.',
      'One top-importing country.',
      'Top importers by summed import quantity (empty when trade is not indexed).',
    ),
    production_trend: z
      .array(
        z
          .object({
            year: z.number().describe('Observation year.'),
            value: z
              .number()
              .describe(
                'Production summed across every country and resolved item reporting that year.',
              ),
            observations: z
              .number()
              .describe(
                'Observations summed into value — read it alongside value, since a change in coverage moves the total independently of production.',
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
        'The annual production series for the resolved commodity, summed over countries and items per year and ordered oldest-first. Aggregated in SQL over the complete filtered match, so it is not affected by the canvas staging cap.',
      ),
    trend_points: z
      .number()
      .describe(
        'Total production observations aggregated into production_trend. Exact — the aggregation runs over the complete filtered match, not a capped page.',
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
        'Canvas table holding the staged observations — production plus trade when the trade domain (TCL) is indexed, production only when it is not (present when spilled). The notice names which of the two the table holds. Pass it as name to faostat_dataframe_describe for its columns (a domain column tags each row QCL or TCL), then reference it in faostat_dataframe_query SQL.',
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

    // 1. Resolve the commodity to item code(s), scoped to QCL — the profile's
    // production backbone — so a resolved item is one QCL actually carries.
    const resolved = await mirror.resolve(QCL, 'item', {
      query: input.item_query,
      limit: MAX_PROFILE_ITEMS,
      signal,
    });
    if (resolved.matches.length === 0) {
      throw ctx.fail('no_match', `No commodity matched "${input.item_query}".`);
    }
    const itemCodes = resolved.matches.map((m) => m.code);
    const itemsTruncated = resolved.total > resolved.matches.length;
    ctx.enrich({
      resolvedItemCodes: itemCodes,
      resolvedItemMatches: resolved.total,
      itemsTruncated,
    });

    const yearRange = {
      ...(input.year_start !== undefined ? { yearStart: input.year_start } : {}),
      ...(input.year_end !== undefined ? { yearEnd: input.year_end } : {}),
    };

    /*
     * Every aggregation below runs against the same filter shape — only the
     * element differs — so the rankings, the trend, and the staged canvas table
     * all describe one population rather than three near-identical ones.
     */
    const filtersFor = (elementCode: number) => ({
      itemCodes,
      elementCodes: [elementCode],
      ...yearRange,
      includeAggregates: false,
    });

    // 2. Production ranking + trend as SQL aggregates over the full filtered
    // match. Neither is a row-oriented page, so neither is bounded by the staging
    // cap nor skewed by the read path's `ORDER BY year ASC` ordering.
    const productionFilters = filtersFor(ELEMENT_PRODUCTION);
    const topProducers = await mirror.rankAreaTotals(QCL, productionFilters, input.top_n, signal);
    const trend = await mirror.sumByYear(QCL, productionFilters, signal);

    // 3. Trade flows — only when TCL is selected + ready (partial result otherwise).
    // Selection and readiness are kept apart: each unavailable state gets its own
    // remedy in the notice below.
    let exporters: AreaAggregateRow[] = [];
    let importers: AreaAggregateRow[] = [];
    let tradeStatus: TradeStatus;
    if (!mirror.isSelected(TCL)) {
      tradeStatus = 'not_selected';
    } else if (!(await mirror.ready(TCL))) {
      tradeStatus = 'indexing';
    } else {
      tradeStatus = 'available';
      exporters = await mirror.rankAreaTotals(
        TCL,
        filtersFor(ELEMENT_EXPORT_QTY),
        input.top_n,
        signal,
      );
      importers = await mirror.rankAreaTotals(
        TCL,
        filtersFor(ELEMENT_IMPORT_QTY),
        input.top_n,
        signal,
      );
    }
    const tradeIncluded = tradeStatus === 'available';

    // 4. Stage the observations for deeper SQL — production, plus trade when TCL
    // contributed. A disabled canvas and a failed staging both leave canvasId
    // unset; canvasOn tells the two apart for the notice.
    const canvasOn = canvasEnabled();
    let spilled = false;
    let truncated = false;
    let stagedRowCount: number | undefined;
    let canvasId: string | undefined;
    let tableName: string | undefined;
    if (canvasOn) {
      const staged = await stageObservations(
        ctx,
        mergeStream(mirror, itemCodes, yearRange, tradeIncluded, signal),
        {
          sourceTool: 'faostat_commodity_profile',
          schema: PROFILE_TABLE_SCHEMA,
          // Provenance records the caller's input names; the staging write site
          // drops an unsupplied bound.
          queryParams: {
            item_query: input.item_query,
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
    // collected here and emitted as one call.
    const noticeParts: string[] = [];
    if (itemsTruncated) {
      noticeParts.push(
        `"${input.item_query}" matched ${resolved.total} items in QCL; the profile folded in the ${resolved.matches.length} best-matching (codes ${itemCodes.join(', ')}) and every figure above covers only those. Use a more specific item_query, or call faostat_resolve_codes (domain QCL, dimension=item) to see the full list and query the item you want directly.`,
      );
    }
    const units = new Set(
      [...topProducers, ...exporters, ...importers, ...trend].map((r) => r.unit),
    );
    if (units.size > 1) {
      noticeParts.push(
        `The resolved items report in more than one unit (${[...units].map((u) => u ?? 'unspecified').join(', ')}). Rows are grouped by unit rather than summed across them, so a country or year can appear once per unit and values are comparable only within the same unit.`,
      );
    }
    if (tradeStatus === 'not_selected') {
      noticeParts.push(
        `Trade domain (TCL) is not in the local mirror selection — returning a production-only profile. Add TCL to FAOSTAT_DOMAINS and re-sync for import/export flows.`,
      );
    } else if (tradeStatus === 'indexing') {
      noticeParts.push(
        `Trade domain (TCL) is selected but has not finished its initial sync — returning a production-only profile. The mirror is already building it, so no configuration change is needed: check faostat_list_domains with code TCL for its index_ready flag, then call this profile again once it turns true.`,
      );
    }
    // Every staging branch states its disposition here: format() sees only the
    // output, where a failed staging and a disabled canvas look identical.
    const describeTable = `faostat_dataframe_describe (name ${tableName}, canvas_id ${canvasId})`;
    // Where the complete row-level series lives when the table cannot hold it.
    const rowLevelSource = `faostat_query_observations on ${tradeIncluded ? 'QCL and TCL' : 'QCL'} with item codes ${itemCodes.join(', ')}`;
    if (truncated) {
      noticeParts.push(
        `The observation set exceeded the ${STAGE_MAX_ROWS}-row staging cap, so canvas table ${tableName} holds only the first ${stagedRowCount} rows and is INCOMPLETE. The rankings and trend above are unaffected — they are aggregated over the full match. Call ${describeTable} for its columns and types, then faostat_dataframe_query for the rows it holds. For the complete row-level series, call ${rowLevelSource} partitioned by year (year_start/year_end), then query each partition with faostat_dataframe_query (canvas_id ${canvasId}).`,
      );
    } else if (spilled) {
      // Name what actually reached the table: with trade unavailable only QCL
      // production rows were staged, and SQL written against trade element codes
      // would come back empty.
      const staged = tradeIncluded
        ? `Merged production + trade observations staged on canvas table ${tableName}`
        : `Production observations staged on canvas table ${tableName} — trade was unavailable, so the table holds QCL production rows only`;
      noticeParts.push(
        `${staged} (canvas_id ${canvasId}). Call ${describeTable} for its columns and types, then faostat_dataframe_query for row-level analysis beyond the rankings and trend above.`,
      );
    } else if (canvasId !== undefined) {
      // Canvas on, the set fit under the inline char budget so no table was
      // registered. Trade availability has no bearing here — a production-only set
      // that fits inline is as complete as a merged one — and the discriminator
      // matches format()'s so both surfaces report the same disposition. Do NOT
      // advise enabling a canvas that is already on (the dead-band notice bug).
      noticeParts.push(
        `Merged set fit inline — the rankings and trend above cover the full result, so no canvas table was staged for this call. canvas_id ${canvasId} is the canvas this call used; faostat_dataframe_describe (canvas_id ${canvasId}) lists any tables already staged on it, and faostat_dataframe_query runs SQL across them.`,
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
      item_query: input.item_query,
      resolved_items: resolved.matches.map((m) => ({ code: m.code, name: m.name })),
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
    // from "field not returned" to a content[]-only client.
    const rankBlock = (title: string, rows: typeof result.top_producers) => {
      lines.push(`### ${title}`);
      if (rows.length === 0) {
        lines.push('_None._', '');
        return;
      }
      for (const r of rows) {
        lines.push(
          `- ${r.area} (${r.area_code}): ${r.value.toLocaleString()} ${r.unit ?? ''} [${r.year}, ${r.observations} obs${r.flags ? `, flags ${r.flags}` : ''}]`,
        );
      }
      lines.push('');
    };
    rankBlock('Top producers', result.top_producers);
    rankBlock('Top exporters', result.top_exporters);
    rankBlock('Top importers', result.top_importers);

    lines.push(`### Production trend (${result.trend_points} observation(s))`);
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
      // registered. The rankings and trend above are the complete answer.
      lines.push('_Merged set fit inline — the figures above cover the full result._');
    } else {
      // A disabled canvas or a failed staging — indistinguishable here, so the
      // notice carries the disposition.
      lines.push('_No canvas table was staged for this result._');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

/**
 * Merge production + trade observation streams for canvas staging. Each stream is
 * bounded by the staging cap (+1 for overflow disclosure); the spillover helper
 * drains the merged iterable lazily and stops at the cap, so the total staged
 * never exceeds {@link STAGE_MAX_ROWS}. With `includeTrade` false the TCL stream
 * is skipped entirely and only production rows reach the table — the notice says
 * so rather than describing a merged set that was never assembled. Both streams
 * read under the call's `signal`, so the ceiling bounds the staging reads too.
 */
async function* mergeStream(
  mirror: ReturnType<typeof getFaostatMirror>,
  itemCodes: number[],
  yearRange: { yearStart?: number; yearEnd?: number },
  includeTrade: boolean,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const streamLimit = STAGE_MAX_ROWS + 1;
  for await (const row of mirror.streamObservations(
    QCL,
    { itemCodes, elementCodes: [ELEMENT_PRODUCTION], ...yearRange, includeAggregates: false },
    streamLimit,
    signal,
  )) {
    yield { ...row, domain: QCL };
  }
  if (includeTrade) {
    for await (const row of mirror.streamObservations(
      TCL,
      {
        itemCodes,
        elementCodes: [ELEMENT_EXPORT_QTY, ELEMENT_IMPORT_QTY],
        ...yearRange,
        includeAggregates: false,
      },
      streamLimit,
      signal,
    )) {
      yield { ...row, domain: TCL };
    }
  }
}
