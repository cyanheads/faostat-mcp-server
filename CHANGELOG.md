# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
