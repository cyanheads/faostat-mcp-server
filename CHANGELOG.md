# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-27 · ⚠️ Breaking

Rewrites faostat_commodity_profile's rankings and trend as SQL aggregates over the full match, replacing the per-row flag field with flags (#5); rejects reversed year ranges (#17); fixes cold-TCL misreporting and an inaccurate staged-set notice (#19); and syncs the fit-inline notice across both client surfaces (#20).

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-07-27

Adopts @cyanheads/mcp-ts-core ^0.11.0 and TypeScript 7; adds offset/limit paging and an exact-code lookup to faostat_list_domains (#16); fixes dataframe_describe reporting every staged column as VARCHAR (#15) and the .mcpb bundle disabling every canvas tool by stripping DuckDB's platform binding (#18).

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-07-13

Fixes sub-5000 roll-up areas like China (351) evading aggregate exclusion and being mislabeled as a country (#4), and widens the data-quality flag legend across tool descriptions to the full FAOSTAT set (#6).

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-07-13

Adds offset-based pagination to faostat_resolve_codes (#7) and fixes cross-domain item/element code leakage by scoping resolution to the requested domain's actual code membership (#8).

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-07-13

Replaces the per-call unbounded COUNT(*) in faostat_query_observations and faostat_commodity_profile — the event-loop-blocking scan behind #3 — with a LIMIT+1 overflow probe and two composite indexes; spilled and preview rows now order by year.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-13

faostat_query_observations and faostat_commodity_profile disclose the 50,000-row staging cap (new truncated + staged_row_count fields) instead of presenting a capped result as complete (#9). query_observations rejects a reversed year range (invalid_year_range) and treats an empty code array as a zero-match, not a broadening (#12).

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-07-13

faostat_dataframe_query discloses row_limit truncation; the dataframe tools honor canvas_id with a typed canvas_not_found; faostat_dataframe_describe gains query_params provenance parity and a typed missing_table on a name miss. Adopts @cyanheads/mcp-ts-core ^0.10.14; clears GHSA-h67p-54hq-rp68 in a transitive js-yaml.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9 — devcheck gains a dependency-specifiers gate that rejects floating specifiers in package.json and bun.lock, and the packaging lint now validates plugin marketplace manifests.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-19

Adopt @cyanheads/mcp-ts-core ^0.10.8 — malformed-column canvas SQL now surfaces invalid_sql with the DuckDB binder detail naming the bad column; the server's gate-reason remap is retained for non-SELECT / denied / malformed-identifier statements.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-19

Close the 51–~600-row spill dead band (full set now returned inline) and align dataframe error-contract reasons with what the SQL gate emits.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-15

Public hosted endpoint at https://faostat.caseyjhand.com/mcp

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-14

Metadata fixes: scoped the README header to the published npm name and added the repository field to the MCPB manifest.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release: FAOSTAT global food & agriculture statistics over a local SQLite mirror of the bulk-download corpus, with a DataCanvas SQL surface.
