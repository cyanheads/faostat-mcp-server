/**
 * @fileoverview `faostat_resolve_codes` — resolves human terms to the opaque
 * integer codes a query needs (areas, items, elements). FAOSTAT is unqueryable
 * without code resolution: "wheat" → item 15, "production" → element 5510. Flags
 * each area as an individual country or an aggregate region so an agent doesn't
 * sum a region with its members. Backed by FTS5 over the bundled dimension code
 * lists in the local mirror.
 * @module mcp-server/tools/definitions/resolve-codes
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';

/** Cap on returned matches. */
const MAX_MATCHES = 200;

export const resolveCodesTool = tool('faostat_resolve_codes', {
  title: 'faostat-mcp-server: resolve codes',
  description:
    'Resolve human terms to the opaque integer codes faostat_query_observations needs, within a dimension: areas (countries/regions), items (commodities), or elements (metrics like production, yield, import quantity). Pass `query` for fuzzy full-text matching ("maize" → item 56), `name_contains` for a substring filter, or `code` for an exact-code lookup; omit all three to list the whole dimension. Every area match is flagged `country` or `aggregate` — aggregates (World, continents, economic groupings; codes ≥ 5000) double-count if summed with their member countries, so resolve before querying and exclude aggregates unless you want the regional roll-up.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  enrichment: {
    totalMatches: z.number().describe('Total matches before the result cap.'),
    truncated: z.boolean().describe('True when matches were capped at the limit.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched or the dimension is not yet indexed.'),
  },

  errors: [
    {
      reason: 'unknown_domain',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The domain code is not a selected (indexed) FAOSTAT domain.',
      recovery: 'Call faostat_list_domains to see valid, indexed domain codes.',
    },
    {
      reason: 'index_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The dimension tables are not yet populated (mirror has never completed a sync).',
      retryable: true,
      recovery:
        'Wait for the initial sync to finish or run the mirror init script, then retry shortly.',
    },
  ],

  input: z.object({
    domain: z
      .string()
      .min(1)
      .describe(
        'FAOSTAT domain code to verify the index is ready (e.g. "QCL"). Dimension code lists (areas, items, elements) are shared across all indexed domains.',
      ),
    dimension: z
      .enum(['area', 'item', 'element'])
      .describe(
        'Which dimension to resolve: "area" (countries/regions), "item" (commodities), or "element" (metrics).',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search term, FTS5-matched against the dimension labels with prefix matching (e.g. "wheat", "import quantity"). Relevance-ranked.',
      ),
    name_contains: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter over the label. Used only when `query` is omitted.',
      ),
    code: z
      .number()
      .int()
      .optional()
      .describe('Exact code lookup. Takes precedence over `query`/`name_contains` when provided.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_MATCHES)
      .default(50)
      .describe('Maximum matches to return (max 200).'),
  }),

  output: z.object({
    domain: z.string().describe('The domain code echoed back.'),
    dimension: z.string().describe('The dimension resolved.'),
    matches: z
      .array(
        z
          .object({
            code: z
              .number()
              .describe('The opaque integer code to pass into faostat_query_observations.'),
            name: z.string().describe('Human-readable label.'),
            kind: z
              .enum(['country', 'aggregate'])
              .nullable()
              .describe(
                'For areas: "country" (individual nation) or "aggregate" (region/grouping; excluded from sums by default). Null for items/elements.',
              ),
            cpc_code: z
              .string()
              .optional()
              .describe('CPC crosswalk code for items (apostrophe stripped), when available.'),
          })
          .describe('One resolved code match.'),
      )
      .describe('Matching codes, relevance-ranked for query mode, else by code.'),
  }),

  async handler(input, ctx) {
    const mirror = getFaostatMirror();
    if (!mirror.isSelected(input.domain)) {
      throw ctx.fail(
        'unknown_domain',
        `Domain "${input.domain}" is not in the indexed set.`,
        ctx.recoveryFor('unknown_domain'),
      );
    }
    if (!(await mirror.dimensions.isPopulated())) {
      throw ctx.fail(
        'index_not_ready',
        'FAOSTAT dimension tables are not yet populated.',
        ctx.recoveryFor('index_not_ready'),
      );
    }

    const { matches, total } = await mirror.resolve(input.dimension, {
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.name_contains ? { nameContains: input.name_contains } : {}),
      limit: input.limit,
    });

    ctx.enrich({ totalMatches: total, truncated: total > matches.length });
    if (matches.length === 0) {
      const criterion =
        input.code !== undefined
          ? `code ${input.code}`
          : input.query
            ? `query "${input.query}"`
            : input.name_contains
              ? `name containing "${input.name_contains}"`
              : 'the listing';
      ctx.enrich.notice(
        `No ${input.dimension} matched ${criterion} in domain ${input.domain.toUpperCase()}. Broaden the term, check spelling, or omit query to list all ${input.dimension} codes.`,
      );
    }

    return {
      domain: input.domain.toUpperCase(),
      dimension: input.dimension,
      matches: matches.map((m) => ({
        code: m.code,
        name: m.name,
        kind: m.kind,
        ...(m.cpc_code !== undefined ? { cpc_code: m.cpc_code } : {}),
      })),
    };
  },

  format: (result) => {
    if (result.matches.length === 0) {
      return [
        { type: 'text', text: `_No ${result.dimension} codes matched in ${result.domain}._` },
      ];
    }
    const lines: string[] = [
      `**${result.matches.length} ${result.dimension} code(s) in ${result.domain}:**\n`,
    ];
    for (const m of result.matches) {
      const kind = m.kind ? ` [${m.kind}]` : '';
      const cpc = m.cpc_code ? ` (CPC ${m.cpc_code})` : '';
      lines.push(`- **${m.code}** — ${m.name}${kind}${cpc}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
