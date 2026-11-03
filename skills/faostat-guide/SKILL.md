---
name: faostat-guide
description: Analyze food and agriculture statistics with faostat_* tools. Use for cross-country comparisons, production and trade analysis, and SQL across staged results where coverage, reporting years, aggregate areas, units, or incomplete results affect the conclusion.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use FAOSTAT for historical food and agriculture statistics from the domains available in this deployment's local mirror. Catalog presence does not establish local availability or observation coverage. The query surface is an area/item/element/year cube; do not infer bilateral trade partners or sub-national detail from country trade totals.

## Identifiers

Obtain domain codes from faostat_list_domains and area, item, and element identities from faostat_resolve_codes. Pass numeric item codes through item_codes; when code is null, pass the exact code_text through item_codes_text. Resolve items and elements in each domain being analyzed; a CPC crosswalk is not an item code. Areas share a vocabulary across domains, so a resolved area alone does not establish observations in the chosen domain.

Use the canvas and table identifiers returned by faostat_query_observations or faostat_commodity_profile. A canvas identifier alone does not establish that the latest call staged a table: check the spill status and returned table name.

## Gates

- Before concluding data is absent, distinguish a domain outside the mirror selection, an unfinished sync or upgrade, an unresolved identity, and an empty observation query. Inspect local sync metadata when freshness matters; the manifest's upstream update date is not proof that the mirror contains that update.
- Select the intended commodity and metric before calculating. Related raw and processed products are separate items. Keep units and elements separate in sums and comparisons; never replace a missing value with zero or present unflagged, estimated, or imputed data as official.
- Resolve elements with item_codes or item_codes_text to discover that item's metrics and observed units. These matches establish item/element compatibility, not coverage for particular countries, years, or sources. An empty observation query can return available_elements for the same purpose.
- Check period and value_qualifier before using a value. A reporting period such as 2000-2002 uses its midpoint as year for filtering; it remains a period observation. A value of 2.5 with qualifier < is an upper bound, not an exact measurement. Preserve the qualifier in calculations and conclusions.
- Keep source_code and source in the identity of observations when present. GLE can report multiple source estimates for the same area, item, element, and year; select a source or compare them separately rather than adding them together.
- For a same-year country ranking, restrict the analysis to that year. The commodity profile otherwise takes each country's own latest available year; report those years rather than describing the ranking as a common-year comparison.
- Choose either a published regional aggregate or its constituent countries for a total. Explicit area selections bypass automatic aggregate exclusion, so inspect the resolved country/aggregate classification even when the default exclusion is on.
- Inspect item kind separately: aggregate marks a verified domain-specific group that can overlap its members. Classification is incomplete; null means unclassified and does not establish that an item is safe to sum with other items. Item groups remain included in observation queries.
- Before calculating a complete-set statistic, read notices and truncation disclosures. An inline page may be incomplete even without a staged table. A truncated staged table lacks part of the source population; SQL pagination cannot recover those missing observations. Narrow or partition retrieval until every required slice is complete.
- Treat unavailable trade in a production-only profile as unavailable, not zero. Read trend observation counts alongside values: changing reporting coverage can change the total independently of production.

## Workflows

### One commodity or a controlled comparison

Use faostat_commodity_profile for a quick production/trade overview of one QCL item. If the commodity is ambiguous, resolve and select its identity rather than combining candidates. Its rankings and annual trend aggregate the full filtered mirror match independently of the staged observation table; incomplete staging does not make those summaries partial.

For a controlled comparison, use faostat_query_observations with the intended item, element, countries, and reporting period. For production versus trade, resolve the identities in both domains and check units before comparing. Join staged slices on the dimensions that identify the intended observations, including year, period, and source where present; filter or aggregate each side to the intended grain first so multiple elements, units, or sources do not multiply joined rows.

### Staged SQL analysis

Large results can be staged as DataCanvas tables. Call faostat_dataframe_describe for the returned canvas and table before writing SQL, then faostat_dataframe_query with one read-only SELECT. Pass the same canvas identifier to subsequent analytical calls when staging related results beside the first. Read each table's returned expires_at; if it disappears, rerun the source query and use the new identifiers.

Use disjoint year or code selections when partitioning an incomplete retrieval, and verify every partition's completeness before combining it. A dataframe query's truncation instead limits its returned SQL rows: aggregate further or page deterministically with ORDER BY and SQL LIMIT/OFFSET. Keep each SQL page within the tool's response limit.

### Name search

Send ordinary words to faostat_resolve_codes. Its full-text search normalizes whitespace-separated terms and applies prefix matching; it does not accept raw FTS operators or quoted-phrase syntax. Use its substring search when token-prefix matching does not express the intended label search, then inspect the candidates before selecting a code.
