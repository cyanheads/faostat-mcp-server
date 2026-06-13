/**
 * @fileoverview `faostat_commodity_profile` — a workflow tool that assembles a
 * global profile for one commodity in a single call: top producers, the
 * multi-decade production trend, and trade flows (top importers/exporters),
 * drawn from the production (QCL) and trade (TCL) domains. Convenience over
 * chaining faostat_resolve_codes + several faostat_query_observations calls.
 * Returns a partial result with a notice when a required domain isn't indexed.
 * @module mcp-server/tools/definitions/commodity-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { canvasEnabled, STAGE_MAX_ROWS, stageObservations } from '@/services/canvas-staging.js';
import type { ObservationRow } from '@/services/faostat-mirror/index.js';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';

/** Production domain + Production element code. */
const QCL = 'QCL';
const ELEMENT_PRODUCTION = 5510;
/** Trade domain + Import/Export quantity element codes. */
const TCL = 'TCL';
const ELEMENT_EXPORT_QTY = 5910;
const ELEMENT_IMPORT_QTY = 5610;

/** One ranked area entry. */
interface RankedArea {
  area: string;
  area_code: number;
  flag: string | null;
  unit: string | null;
  value: number;
  year: number;
}

/** Rank country rows by value for the latest year present, top N. */
function rankLatest(rows: ObservationRow[], topN: number): RankedArea[] {
  if (rows.length === 0) return [];
  // Reduce, not Math.max(...spread) — a large rows array would blow the call stack.
  let latestYear = -Infinity;
  for (const r of rows) if (r.year > latestYear) latestYear = r.year;
  return rows
    .filter((r) => r.year === latestYear && r.value !== null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, topN)
    .map((r) => ({
      area_code: r.area_code,
      area: r.area,
      value: r.value ?? 0,
      unit: r.unit,
      year: r.year,
      flag: r.flag,
    }));
}

export const commodityProfileTool = tool('faostat_commodity_profile', {
  title: 'faostat-mcp-server: commodity profile',
  description:
    'Assemble a global profile for one commodity in a single call: top-producing countries, the multi-decade production trend, and trade flows (top exporters and importers). Accepts a commodity name, resolves it to item codes, then queries the production (QCL) and trade (TCL) domains and merges the results. Country-level only (aggregates excluded). When a required domain is not indexed locally, returns a partial profile with a notice naming the gap rather than failing. The full merged observation set spills to a DataCanvas table for deeper SQL via faostat_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },

  enrichment: {
    resolvedItemCodes: z.array(z.number()).describe('Item codes the commodity query resolved to.'),
    notice: z
      .string()
      .optional()
      .describe('Names any required domain that was not indexed, or other partial-result context.'),
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
      reason: 'index_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The production (QCL) mirror is cold — its initial sync has never completed.',
      retryable: true,
      recovery:
        'Wait for the initial sync to finish, or run the mirror init script, then retry shortly.',
    },
  ],

  input: z.object({
    item_query: z
      .string()
      .min(1)
      .describe('Commodity name to profile (e.g. "maize", "wheat", "coffee green").'),
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
    canvas_id: z
      .string()
      .optional()
      .describe('Canvas ID from a prior call to stage onto. Omit to start a fresh canvas.'),
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
    top_producers: z
      .array(
        z
          .object({
            area_code: z.number().describe('Country code.'),
            area: z.string().describe('Country name.'),
            value: z.number().describe('Production value in the latest year present.'),
            unit: z.string().nullable().describe('Unit of measure; null when unspecified.'),
            year: z.number().describe('The latest year the ranking is drawn from.'),
            flag: z.string().nullable().describe('Data-quality flag; null when unflagged.'),
          })
          .describe('One top-producing country.'),
      )
      .describe('Top producers by production value (countries only).'),
    top_exporters: z
      .array(
        z
          .object({
            area_code: z.number().describe('Country code.'),
            area: z.string().describe('Country name.'),
            value: z.number().describe('Export quantity in the latest year present.'),
            unit: z.string().nullable().describe('Unit of measure; null when unspecified.'),
            year: z.number().describe('The latest year the ranking is drawn from.'),
            flag: z.string().nullable().describe('Data-quality flag; null when unflagged.'),
          })
          .describe('One top-exporting country.'),
      )
      .describe('Top exporters by export quantity (empty when trade is not indexed).'),
    top_importers: z
      .array(
        z
          .object({
            area_code: z.number().describe('Country code.'),
            area: z.string().describe('Country name.'),
            value: z.number().describe('Import quantity in the latest year present.'),
            unit: z.string().nullable().describe('Unit of measure; null when unspecified.'),
            year: z.number().describe('The latest year the ranking is drawn from.'),
            flag: z.string().nullable().describe('Data-quality flag; null when unflagged.'),
          })
          .describe('One top-importing country.'),
      )
      .describe('Top importers by import quantity (empty when trade is not indexed).'),
    trend_points: z
      .number()
      .describe('Count of production trend observations staged for the resolved commodity.'),
    spilled: z
      .boolean()
      .describe('True when the merged observation set was staged on a canvas table.'),
    canvas_id: z
      .string()
      .optional()
      .describe('Canvas ID holding the merged set — pass to faostat_dataframe_query / _describe.'),
    table_name: z
      .string()
      .optional()
      .describe(
        'Canvas table holding the merged production+trade observations (present when spilled).',
      ),
  }),

  async handler(input, ctx) {
    const mirror = getFaostatMirror();

    // QCL is the backbone of the profile; require it to be selected + ready.
    if (!mirror.isSelected(QCL)) {
      throw ctx.fail(
        'index_not_ready',
        'The production domain (QCL) is not in the local mirror selection.',
        ctx.recoveryFor('index_not_ready'),
      );
    }
    if (!(await mirror.ready(QCL))) {
      throw ctx.fail(
        'index_not_ready',
        'The production (QCL) mirror has not completed its initial sync.',
        ctx.recoveryFor('index_not_ready'),
      );
    }

    // 1. Resolve the commodity to item code(s).
    const resolved = await mirror.resolve('item', { query: input.item_query, limit: 5 });
    if (resolved.matches.length === 0) {
      throw ctx.fail(
        'no_match',
        `No commodity matched "${input.item_query}".`,
        ctx.recoveryFor('no_match'),
      );
    }
    const itemCodes = resolved.matches.map((m) => m.code);
    ctx.enrich({ resolvedItemCodes: itemCodes });

    const yearRange = {
      ...(input.year_start !== undefined ? { yearStart: input.year_start } : {}),
      ...(input.year_end !== undefined ? { yearEnd: input.year_end } : {}),
    };

    // 2. Production rows (full range, countries only) for ranking + trend. Bounded
    // by the staging cap — the ranking needs the latest-year slice, and the full
    // merged set is separately staged below for SQL. An unbounded pull would
    // materialize the whole filtered cube into one array.
    const production = await mirror.queryObservations(QCL, {
      itemCodes,
      elementCodes: [ELEMENT_PRODUCTION],
      ...yearRange,
      includeAggregates: false,
      limit: STAGE_MAX_ROWS,
      offset: 0,
    });
    const topProducers = rankLatest(production.rows, input.top_n);

    // 3. Trade flows — only when TCL is indexed + ready (partial result otherwise).
    let exporters: RankedArea[] = [];
    let importers: RankedArea[] = [];
    let tradeMissing = false;
    if (mirror.isSelected(TCL) && (await mirror.ready(TCL))) {
      const exportRows = await mirror.queryObservations(TCL, {
        itemCodes,
        elementCodes: [ELEMENT_EXPORT_QTY],
        ...yearRange,
        includeAggregates: false,
        limit: STAGE_MAX_ROWS,
        offset: 0,
      });
      const importRows = await mirror.queryObservations(TCL, {
        itemCodes,
        elementCodes: [ELEMENT_IMPORT_QTY],
        ...yearRange,
        includeAggregates: false,
        limit: STAGE_MAX_ROWS,
        offset: 0,
      });
      exporters = rankLatest(exportRows.rows, input.top_n);
      importers = rankLatest(importRows.rows, input.top_n);
    } else {
      tradeMissing = true;
    }

    // 4. Stage the merged production + trade observations for deeper SQL.
    let spilled = false;
    let canvasId: string | undefined;
    let tableName: string | undefined;
    if (canvasEnabled()) {
      const staged = await stageObservations(
        ctx,
        mergeStream(mirror, itemCodes, yearRange, tradeMissing),
        {
          sourceTool: 'faostat_commodity_profile',
          queryParams: { item_query: input.item_query, item_codes: itemCodes, ...yearRange },
          ...(input.canvas_id ? { canvasId: input.canvas_id } : {}),
        },
      );
      if (staged?.spilled) {
        spilled = true;
        canvasId = staged.canvasId;
        tableName = staged.tableName;
      } else if (staged) {
        canvasId = staged.canvasId;
      }
    }

    if (tradeMissing) {
      ctx.enrich.notice(
        `Trade domain (TCL) is not indexed — returning production-only profile. Add TCL to FAOSTAT_DOMAINS and re-sync for import/export flows.`,
      );
    } else if (spilled) {
      ctx.enrich.notice(
        `Merged production + trade observations staged on canvas table ${tableName} (canvas_id ${canvasId}). Query it with faostat_dataframe_query for full time-series analysis.`,
      );
    }

    return {
      item_query: input.item_query,
      resolved_items: resolved.matches.map((m) => ({ code: m.code, name: m.name })),
      top_producers: topProducers,
      top_exporters: exporters,
      top_importers: importers,
      trend_points: production.rows.length,
      spilled,
      ...(canvasId !== undefined ? { canvas_id: canvasId } : {}),
      ...(tableName !== undefined ? { table_name: tableName } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [`## Commodity profile: ${result.item_query}\n`];
    lines.push(
      `Resolved to: ${result.resolved_items.map((i) => `${i.name} (${i.code})`).join(', ')}\n`,
    );
    const rankBlock = (title: string, rows: typeof result.top_producers) => {
      if (rows.length === 0) return;
      lines.push(`### ${title}`);
      for (const r of rows) {
        lines.push(
          `- ${r.area} (${r.area_code}): ${r.value.toLocaleString()} ${r.unit ?? ''} [${r.year}${r.flag ? `, ${r.flag}` : ''}]`,
        );
      }
      lines.push('');
    };
    rankBlock('Top producers', result.top_producers);
    rankBlock('Top exporters', result.top_exporters);
    rankBlock('Top importers', result.top_importers);
    lines.push(`Production trend observations: ${result.trend_points}`);
    if (result.spilled) {
      lines.push(
        `\nFull set staged (spilled) on canvas table **${result.table_name}** (canvas_id ${result.canvas_id}) — query with faostat_dataframe_query.`,
      );
    } else {
      lines.push(
        '\n_Merged set not spilled to a canvas table (enable CANVAS_PROVIDER_TYPE=duckdb to stage it)._',
      );
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

/**
 * Merge production + trade observation streams for canvas staging. Each stream is
 * bounded by the staging cap (+1 for overflow disclosure); the spillover helper
 * drains the merged iterable lazily and stops at the cap, so the total staged
 * never exceeds {@link STAGE_MAX_ROWS}.
 */
async function* mergeStream(
  mirror: ReturnType<typeof getFaostatMirror>,
  itemCodes: number[],
  yearRange: { yearStart?: number; yearEnd?: number },
  tradeMissing: boolean,
): AsyncGenerator<Record<string, unknown>> {
  const streamLimit = STAGE_MAX_ROWS + 1;
  for await (const row of mirror.streamObservations(
    QCL,
    { itemCodes, elementCodes: [ELEMENT_PRODUCTION], ...yearRange, includeAggregates: false },
    streamLimit,
  )) {
    yield { ...row, domain: QCL };
  }
  if (!tradeMissing) {
    for await (const row of mirror.streamObservations(
      TCL,
      {
        itemCodes,
        elementCodes: [ELEMENT_EXPORT_QTY, ELEMENT_IMPORT_QTY],
        ...yearRange,
        includeAggregates: false,
      },
      streamLimit,
    )) {
      yield { ...row, domain: TCL };
    }
  }
}
