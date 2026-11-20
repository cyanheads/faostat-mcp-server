/**
 * @fileoverview `faostat_resolve_codes` — resolves human terms to the opaque
 * codes a query needs (areas, items, elements). FAOSTAT is unqueryable
 * without code resolution: "wheat" → item 15, "production" → element 5510. Flags
 * each area as an individual country or an aggregate region so an agent doesn't
 * sum a region with its members, and carries each area's M49 code, which
 * `m49_code` also looks areas up by. Backed by FTS5 over the bundled dimension
 * code lists in the local mirror.
 * @module mcp-server/tools/definitions/resolve-codes
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { countInput } from '@/mcp-server/tools/count-input.js';
import {
  classifySearchQuery,
  quoteSearchText,
} from '@/services/faostat-mirror/dimensions-store.js';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';

/** Matches per page. */
const LIMIT = countInput({
  tool: 'faostat_resolve_codes',
  name: 'limit',
  default: 50,
  cap: 200,
  description: (cap) => `Matches to return on this page, at most ${cap} per call.`,
});

/**
 * `m49_code` as FAO stores it: the integer part zero-padded to three digits, any
 * dotted extension kept as given (`40` → `040`, `2.03` → `002.03`). The input
 * pattern guarantees one to three leading digits.
 */
function storedM49(code: string): string {
  const dot = code.indexOf('.');
  const whole = dot === -1 ? code : code.slice(0, dot);
  return whole.padStart(3, '0') + (dot === -1 ? '' : code.slice(dot));
}

export const resolveCodesTool = tool('faostat_resolve_codes', {
  title: 'faostat-mcp-server: resolve codes',
  description:
    'Resolve labels to the numeric codes or exact alphanumeric item identities faostat_query_observations needs: areas (countries/regions), items (commodities), and elements (metrics). Use query for full-text matching, name_contains for substring matching, code or code_text for exact identity, m49_code to find areas by M49 code, or omit them to list. Item and element matches occur in the selected domain; areas use shared vocabulary. For elements, optionally pass item_codes or item_codes_text to discover metrics and distinct units observed for those items; this does not establish area/year/source coverage. Empty item selectors match nothing. Page with offset and limit using nextOffset when truncated. Areas carry country/aggregate classification and the M49 code FAO publishes for each, a standard key for joining other sources. Verified domain-specific item groups carry aggregate; null means unclassified, not safe-to-sum. Item groups can overlap their members even with matching units. Area aggregates include codes ≥ 5000 and curated roll-ups such as China=351; exclude overlapping regional and country rows when summing.',
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
    ...LIMIT.enrichment,
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when limit was above its cap, nothing matched, more pages remain, or the dimension is not yet indexed.',
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
      reason: 'invalid_m49_selector',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'm49_code is supplied outside the area dimension, or with code or code_text.',
      recovery:
        'Use m49_code alone with dimension area, or use code for an FAO area code; omit m49_code for items and elements.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No code, code_text, or m49_code was given, and query is made only of quotes, parentheses, asterisks, and whitespace, such as "()" or "**", so no search term is left. A lone "*" lists instead.',
      recovery: 'Pass a query with at least one word, or omit query to list the dimension.',
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
      when: "The lookup's mirror read — time queued behind other calls' reads plus execution — ran past the 45-second per-call ceiling.",
      recovery:
        'For element lookup, pass item_codes or item_codes_text to narrow unit discovery, or use an exact code; retry after other reads finish.',
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
        'Full-text search term, FTS5-matched against the dimension labels with prefix matching (e.g. "wheat", "import quantity"). Relevance-ranked. Quotes, parentheses, asterisks, and control characters separate words. Blank or "*" reads as omitted; any other value made only of quotes, parentheses, asterisks, and whitespace, such as "()", fails invalid_query. Unread when code, code_text, or m49_code is given.',
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
        'Exact alphanumeric item code; letters are uppercased before lookup, so 210400f reads as 210400F. Only for dimension item; mutually exclusive with code. Numeric identities use code.',
      ),
    m49_code: z
      .string()
      .regex(/^\d{1,3}(\.\d+)?$/)
      .optional()
      .describe(
        'Exact M49 area code: one to three digits, optionally a dot and more digits, such as "840" or "002.03". The integer part is zero-padded to three digits before lookup, so "40" reads as "040". Returns every area carrying the code on one page. Only for dimension area; mutually exclusive with code and code_text; takes precedence over query and name_contains.',
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
        'For element resolution only: restrict elements and units to these exact text items, letters uppercased before lookup. Empty matches nothing; mutually exclusive with item_codes.',
      ),
    limit: LIMIT.schema,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based pagination offset into the match set. When the response reports truncated, pass the returned nextOffset here to fetch the next page. Ignored for exact lookups by code, code_text, or m49_code (always single-page).',
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
            m49_code: z
              .string()
              .optional()
              .describe(
                "Areas only: FAO's published M49 code, a string with its leading zeros (840, 001). The excluding-intra-trade aggregates carry dotted FAO extensions such as 002.03, and historical entities their former codes. Absent for items and elements, and for an area whose code list carries none.",
              ),
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
    if (
      input.m49_code !== undefined &&
      (input.dimension !== 'area' || input.code !== undefined || input.code_text !== undefined)
    )
      throw ctx.fail(
        'invalid_m49_selector',
        'm49_code requires dimension area and must not be combined with code or code_text.',
      );
    if (input.code_text !== undefined && (input.code !== undefined || input.dimension !== 'item'))
      throw ctx.fail(
        'invalid_text_selector',
        'code_text requires dimension item and must not be combined with code.',
      );
    // An exact selector wins and leaves query unread. Otherwise a blank or "*" query
    // lists, and one with no search term fails instead of listing unannounced (#67).
    const exactCode =
      input.code !== undefined || input.code_text !== undefined || input.m49_code !== undefined;
    const search = exactCode ? undefined : classifySearchQuery(input.query);
    const query = search?.kind === 'search' ? search.query : undefined;
    if (search?.kind === 'invalid')
      throw ctx.fail(
        'invalid_query',
        `query ${quoteSearchText(search.query)} holds no search term: it is made only of quotes, parentheses, asterisks, and whitespace.`,
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

    // Every stored text identity is uppercase, and the input pattern admits lowercase
    // letters: normalize before any mirror read so 210400f reads as 210400F (#68).
    const codeText = input.code_text?.toUpperCase();
    const itemCodesText = input.item_codes_text?.map((code) => code.toUpperCase());
    const m49Code = input.m49_code === undefined ? undefined : storedM49(input.m49_code);

    // An exact lookup answers on one page — code and code_text with at most one
    // match, m49_code with every area carrying the code — so limit never binds there
    // and is not clamped; the mirror ignores it on that path.
    const limit = exactCode ? undefined : LIMIT.clamp(ctx, input.limit);
    const { matches, total } = await mirror.resolve(input.domain, input.dimension, {
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(codeText !== undefined ? { codeText } : {}),
      ...(m49Code !== undefined ? { m49Code } : {}),
      ...(input.item_codes !== undefined ? { itemCodes: input.item_codes } : {}),
      ...(itemCodesText !== undefined ? { itemCodesText } : {}),
      ...(query !== undefined ? { query } : {}),
      ...(input.name_contains ? { nameContains: input.name_contains } : {}),
      limit: limit?.effective ?? 1,
      offset: input.offset,
      signal: mirror.readSignal(ctx.signal),
    });

    // Pagination window: this page covers [offset, offset + matches.length). More
    // remain when that end is short of the (domain-scoped) total — then nextOffset
    // is where the caller resumes.
    const nextOffset = input.offset + matches.length;
    const truncated = nextOffset < total;
    ctx.enrich({ totalMatches: total, truncated, ...(truncated ? { nextOffset } : {}) });

    // A clamped limit leads; the paging sentence after it names the next offset.
    const notices: string[] = limit?.clamped ? [limit.notice] : [];
    // What selected the matches; undefined is the listing, worded as one. The caller's
    // text is named escaped, so no control character in it reaches the notice.
    const criterion =
      input.code !== undefined
        ? `code ${input.code}`
        : codeText !== undefined
          ? `code_text "${codeText}"`
          : m49Code !== undefined
            ? `m49_code "${m49Code}"`
            : query !== undefined
              ? `query ${quoteSearchText(query)}`
              : input.name_contains
                ? `name containing ${quoteSearchText(input.name_contains)}`
                : undefined;
    if (matches.length === 0) {
      // Element resolution keeps only the elements observed for the selected items.
      const scope =
        input.item_codes !== undefined
          ? { field: 'item_codes', codes: input.item_codes }
          : itemCodesText !== undefined
            ? { field: 'item_codes_text', codes: itemCodesText }
            : undefined;
      const scoped = scope ? ` for ${scope.field} [${scope.codes.join(', ')}]` : '';
      const domainUpper = input.domain.toUpperCase();
      // The recovery names the selector the call used, the one criterion names.
      const exactField =
        input.code !== undefined ? 'code' : codeText !== undefined ? 'code_text' : undefined;
      const searchField =
        query !== undefined ? 'query' : input.name_contains ? 'name_contains' : undefined;
      const recovery = scope
        ? ` Only elements observed for those items count: check the items with faostat_resolve_codes dimension item, or omit ${scope.field} for every element in the domain.`
        : m49Code !== undefined
          ? ' List areas without m49_code, or search them by name with query, to read the m49_code each one carries.'
          : exactField
            ? ` Omit ${exactField} to list all ${input.dimension} codes, or search by name with query.`
            : searchField
              ? ` Broaden the term, check spelling, or omit ${searchField} to list all ${input.dimension} codes.`
              : '';
      notices.push(
        total > 0
          ? `Offset ${input.offset} is past the ${total} ${criterion ? `${input.dimension} match(es) for ${criterion}` : `${input.dimension} code(s) listed`}${scoped} in domain ${domainUpper}. Lower offset (0-based) to page back through the results.`
          : `No ${input.dimension} ${criterion ? `matched ${criterion}` : 'codes are listed'}${scoped} in domain ${domainUpper}.${recovery}`,
      );
    } else if (truncated) {
      notices.push(
        `${criterion ? `Showing ${input.dimension} matches` : `Listing ${input.dimension} codes`} ${input.offset + 1}–${nextOffset} of ${total}. Call again with offset ${nextOffset} to fetch the next page.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      domain: input.domain.toUpperCase(),
      dimension: input.dimension,
      matches: matches.map((m) => ({
        code: m.code,
        code_text: m.code_text,
        name: m.name,
        kind: m.kind,
        ...(m.cpc_code !== undefined ? { cpc_code: m.cpc_code } : {}),
        ...(m.m49_code !== undefined ? { m49_code: m.m49_code } : {}),
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
      const m49 = m.m49_code ? ` (M49 ${m.m49_code})` : '';
      const cpc = m.cpc_code ? ` (CPC ${m.cpc_code})` : '';
      const units =
        m.units !== undefined
          ? ` (units: ${m.units.length ? m.units.join(', ') : 'unspecified'})`
          : '';
      const code = [m.code, m.code_text].filter((value) => value !== null).join(' / ');
      lines.push(`- **${code}** — ${m.name}${kind}${m49}${cpc}${units}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
