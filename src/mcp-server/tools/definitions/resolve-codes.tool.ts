/**
 * @fileoverview `faostat_resolve_codes` — resolves human terms to the opaque
 * codes a query needs (areas, items, elements). FAOSTAT is unqueryable
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
    'Resolve labels to the numeric codes or exact alphanumeric item identities faostat_query_observations needs: areas (countries/regions), items (commodities), and elements (metrics). Use query for full-text matching, name_contains for substring matching, code or code_text for exact identity, or omit them to list. Item and element matches occur in the selected domain; areas use shared vocabulary. For elements, optionally pass item_codes or item_codes_text to discover metrics and distinct units observed for those items; this does not establish area/year/source coverage. Empty item selectors match nothing. Page with offset and limit using nextOffset when truncated. Areas carry country/aggregate classification. Verified domain-specific item groups carry aggregate; null means unclassified, not safe-to-sum. Item groups can overlap their members even with matching units. Area aggregates include codes ≥ 5000 and curated roll-ups such as China=351; exclude overlapping regional and country rows when summing.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  enrichment: {
    totalMatches: z.number().describe('Total matches in this domain before the result cap.'),
    truncated: z
      .boolean()
      .describe(
        'True when more matches remain beyond the returned page — fetch them with nextOffset.',
      ),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe(
        'Offset to pass on the next call to fetch the following page. Present only when truncated is true; absent on the last page and for exact-code lookups.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, more pages remain, or the dimension is not yet indexed.',
      ),
  },

  errors: [
    {
      reason: 'invalid_item_scope',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Item selectors are combined or supplied outside element resolution.',
      recovery:
        'Use either item_codes or item_codes_text with dimension element; omit both for domain-wide elements.',
    },
    {
      reason: 'invalid_text_selector',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'code_text is supplied with code or outside the item dimension.',
      recovery: 'Use code_text alone for an alphanumeric item, or use code for numeric identities.',
    },
    {
      reason: 'unknown_domain',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The domain code is not a selected (indexed) FAOSTAT domain.',
      recovery: 'Call faostat_list_domains to see valid, indexed domain codes.',
    },
    {
      reason: 'index_not_ready',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The shared dimension tables are empty, or the selected item/element domain requires an initial sync or an ingest upgrade.',
      retryable: true,
      recovery: 'Wait for sync to finish, or run mirror:init or mirror:refresh, then retry.',
    },
    // Raised by the mirror read pool when the call's ceiling fires.
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      retryable: true,
      when: "The item or element lookup's mirror read — time queued behind other calls' reads plus execution — ran past the 45-second per-call ceiling.",
      recovery:
        'For element lookup, pass item_codes or item_codes_text to narrow unit discovery, or use an exact code; retry after other reads finish.',
    },
  ],

  input: z.object({
    domain: z
      .string()
      .min(1)
      .describe(
        'FAOSTAT domain code (e.g. "QCL"). Item and element resolution is scoped to the codes present in this domain\'s data; area code lists are shared across all indexed domains.',
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
    code_text: z
      .string()
      .regex(/^\d+[A-Za-z][A-Za-z0-9]*$/)
      .optional()
      .describe(
        'Exact alphanumeric item code. Only for dimension item; mutually exclusive with code. Numeric identities use code.',
      ),
    item_codes: z
      .array(z.number().int())
      .optional()
      .describe(
        'For element resolution only: restrict elements and units to these items. Empty matches nothing; omit for domain-wide elements. Mutually exclusive with item_codes_text.',
      ),
    item_codes_text: z
      .array(
        z
          .string()
          .regex(/^\d+[A-Za-z][A-Za-z0-9]*$/)
          .describe('Exact alphanumeric item identity.'),
      )
      .optional()
      .describe(
        'For element resolution only: restrict elements and units to these exact text items. Empty matches nothing; mutually exclusive with item_codes.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_MATCHES)
      .default(50)
      .describe('Maximum matches to return (max 200).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based pagination offset into the match set. When the response reports truncated, pass the returned nextOffset here to fetch the next page. Ignored for exact-code lookups (always single-page).',
      ),
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
              .nullable()
              .describe(
                'Numeric code for faostat_query_observations; null for alphanumeric items carried by code_text.',
              ),
            code_text: z
              .string()
              .nullable()
              .describe(
                'Exact alphanumeric item identity for item_codes_text; null for numeric codes.',
              ),
            name: z.string().describe('Human-readable label.'),
            kind: z
              .enum(['country', 'aggregate'])
              .nullable()
              .describe(
                'For areas: country or aggregate region. For items: aggregate only for verified domain-specific groups; null means unclassified, never safe-to-sum. Null for elements.',
              ),
            units: z
              .array(z.string().describe('Observed unit label.'))
              .optional()
              .describe(
                'Element matches only: distinct non-null units observed in the selected domain and item scope. Empty means no specified units.',
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
    if (
      (input.item_codes !== undefined || input.item_codes_text !== undefined) &&
      (input.dimension !== 'element' ||
        (input.item_codes !== undefined && input.item_codes_text !== undefined))
    )
      throw ctx.fail(
        'invalid_item_scope',
        'Item selectors require dimension element and are mutually exclusive.',
      );
    if (input.code_text !== undefined && (input.code !== undefined || input.dimension !== 'item'))
      throw ctx.fail(
        'invalid_text_selector',
        'code_text requires dimension item and must not be combined with code.',
      );
    const mirror = getFaostatMirror();
    if (!mirror.isSelected(input.domain)) {
      throw ctx.fail('unknown_domain', `Domain "${input.domain}" is not in the indexed set.`);
    }
    if (
      (input.dimension !== 'area' && !(await mirror.ready(input.domain))) ||
      !(await mirror.dimensions.isPopulated())
    ) {
      throw ctx.fail(
        'index_not_ready',
        `FAOSTAT shared dimensions or the selected ${input.domain.toUpperCase()} domain require a completed sync before resolution.`,
      );
    }

    const { matches, total } = await mirror.resolve(input.domain, input.dimension, {
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.code_text !== undefined ? { codeText: input.code_text } : {}),
      ...(input.item_codes !== undefined ? { itemCodes: input.item_codes } : {}),
      ...(input.item_codes_text !== undefined ? { itemCodesText: input.item_codes_text } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.name_contains ? { nameContains: input.name_contains } : {}),
      limit: input.limit,
      offset: input.offset,
      signal: mirror.readSignal(ctx.signal),
    });

    // Pagination window: this page covers [offset, offset + matches.length). More
    // remain when that end is short of the (domain-scoped) total — then nextOffset
    // is where the caller resumes.
    const nextOffset = input.offset + matches.length;
    const truncated = nextOffset < total;
    ctx.enrich({ totalMatches: total, truncated, ...(truncated ? { nextOffset } : {}) });

    if (matches.length === 0) {
      const criterion =
        input.code !== undefined
          ? `code ${input.code}`
          : input.code_text !== undefined
            ? `code_text "${input.code_text}"`
            : input.query
              ? `query "${input.query}"`
              : input.name_contains
                ? `name containing "${input.name_contains}"`
                : 'the listing';
      const domainUpper = input.domain.toUpperCase();
      ctx.enrich.notice(
        total > 0
          ? `Offset ${input.offset} is past the ${total} ${input.dimension} match(es) for ${criterion} in domain ${domainUpper}. Lower offset (0-based) to page back through the results.`
          : `No ${input.dimension} matched ${criterion} in domain ${domainUpper}. Broaden the term, check spelling, or omit query to list all ${input.dimension} codes.`,
      );
    } else if (truncated) {
      ctx.enrich.notice(
        `Showing ${input.dimension} matches ${input.offset + 1}–${nextOffset} of ${total}. Call again with offset ${nextOffset} to fetch the next page.`,
      );
    }

    return {
      domain: input.domain.toUpperCase(),
      dimension: input.dimension,
      matches: matches.map((m) => ({
        code: m.code,
        code_text: m.code_text,
        name: m.name,
        kind: m.kind,
        ...(m.cpc_code !== undefined ? { cpc_code: m.cpc_code } : {}),
        ...(m.units !== undefined ? { units: m.units } : {}),
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
      const units =
        m.units !== undefined
          ? ` (units: ${m.units.length ? m.units.join(', ') : 'unspecified'})`
          : '';
      const code = [m.code, m.code_text].filter((value) => value !== null).join(' / ');
      lines.push(`- **${code}** — ${m.name}${kind}${cpc}${units}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
