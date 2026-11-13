<div align="center">
  <h1>@cyanheads/faostat-mcp-server</h1>
  <p><b>Global food & agriculture statistics from the UN FAOSTAT bulk-download corpus, served from a local SQLite mirror with a DataCanvas SQL surface, via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Skill Resource • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/faostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/faostat-mcp-server/releases/latest/download/faostat-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=faostat-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmFvc3RhdC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22faostat-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffaostat-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://faostat.caseyjhand.com/mcp](https://faostat.caseyjhand.com/mcp)

</div>

---

## Overview

Global food and agriculture statistics from the UN's FAOSTAT: production, trade, food balances, food security, land use, fertilizer, and emissions for 245+ countries and territories since 1961. Resolve commodity and country codes, query the data, and run SQL over large results.

### Tools

| Tool | Description |
|:---|:---|
| `faostat_list_domains` | Discover FAOSTAT statistical domains with codes, descriptions, last-update date, upstream row count, and local index status. The entry point — every query keys on a domain code. |
| `faostat_resolve_codes` | Resolve human terms to the codes a query needs (areas, items, elements), flagging each area as a country or an aggregate region. |
| `faostat_query_observations` | Query a domain's cube by area(s), item(s), element(s), and year range. Returns pages of up to `limit` rows by an `offset` of at most 100,000; with DataCanvas on, a first page whose match exceeds `limit` also stages the whole match to a canvas table. |
| `faostat_commodity_profile` | Workflow: assemble top producers, the production trend, and trade flows for one commodity from the production and trade domains in a single call. The elements follow what the item carries: Production, or Stocks for live-animal items. |
| `faostat_dataframe_query` | Run a read-only SQL `SELECT` against the canvas tables staged by the analytical tools. |
| `faostat_dataframe_describe` | List the canvas tables staged this session, each with provenance, row count, and column schema. |
| `faostat_dataframe_drop` | Drop one staged canvas table before its 2-hour TTL. Opt-in — callable only with `FAOSTAT_DATAFRAME_DROP_ENABLED=true`. |

## Capability reference

### `faostat_list_domains` <sub>tool</sub>

- Full FAOSTAT catalog (~69 domains) read live from the bulk manifest, annotated with local mirror status
- `code` for an exact domain lookup; `topic` substring filter over code/name/topic; `indexed_only` to list only domains queryable from the local mirror
- `offset` + `limit` (at most 200 per call, default 20; a larger value is served at 200 with a notice) page the catalog — response reports `totalMatches`, `truncated`, and `nextOffset`
- Each entry reports `indexed` / `index_ready` flags, local row count, and last completed sync

---

### `faostat_resolve_codes` <sub>tool</sub>

- FTS5 full-text `query`, substring `name_contains`, or exact `code` lookup within a `dimension`: `area`, `item`, or `element`; `code_text` looks up alphanumeric items
- Item/element matches are scoped to codes present in the given `domain`'s cube; area codes are shared across domains
- Element matches include observed `units`; `item_codes` or `item_codes_text` restrict element discovery and units to selected items. Item/element lookups require that domain to be ready
- Every area match is flagged `country` or `aggregate` (codes ≥ 5000, plus curated sub-threshold roll-ups such as China=351)
- Verified item groups are marked `aggregate` by domain. Classification is incomplete: `kind: null` does not mean items can safely be summed together
- `limit` (at most 200 per call, default 50; a larger value is served at 200 with a notice) + `offset` page the match set
- Typed errors: `unknown_domain`, `index_not_ready`, `invalid_text_selector`, `invalid_item_scope`, `query_timeout`, `pool_closed`

---

### `faostat_query_observations` <sub>tool</sub>

- Filters by `area_codes` / `item_codes` / `item_codes_text` / `element_codes` / `source_codes` and an inclusive `year_start` / `year_end` range
- Alphanumeric items retain their exact `item_code_text` with `item_code: null`; numeric items retain their integer code
- Period observations retain `period` (e.g. `2000-2002`) and use its midpoint as `year` for filtering. Censored values retain the numeric bound plus `value_qualifier` (e.g. `<` with `2.5`)
- Source-specific rows carry `source_code` and `source`; omitting `source_codes` returns all sources, which must be compared separately rather than summed
- An empty query with explicit item and element selections returns `available_elements` with labels and units for those items; this does not establish coverage for the requested areas, years, or sources
- Aggregate regions excluded by default (`include_aggregates: false`); explicit `area_codes` bypass the exclusion
- `limit` (default 200, at most 1000 per call; a larger value is served at 1000 with `requestedLimit`/`effectiveLimit` and a notice) is the page size and `offset` its start; `nextOffset` continues while rows remain, with or without DataCanvas, and `totalCount` is exact up to 50,000 and on the last page, and on any other page a floor past 50,000, which `totalCountIsFloor: true` discloses
- `offset` reaches at most 100,000 rows into a match (a larger value is rejected); a page whose next page would start past that carries no `nextOffset`, and its notice says to partition the query by `year_start`/`year_end` or narrower codes and page each part from `offset` 0
- With DataCanvas on, a first page (`offset` 0) whose match exceeds `limit` also stages the whole match to a canvas table (50,000-row staging cap) — `faostat_dataframe_describe` for its columns, then SQL via `faostat_dataframe_query`
- Every row carries its data-quality `flag` (`A`/`E`/`I`/`B`/`M`/`T`/`X`, others per domain) — never dropped
- Typed errors: `domain_not_indexed`, `index_not_ready`, `canvas_not_found`, `invalid_year_range`, `conflicting_item_selectors`, `query_timeout`, `pool_closed`

---

### `faostat_commodity_profile` <sub>tool</sub>

- Selects one QCL item with `item_code` or `item_query` (code takes precedence), then ranks top producers/exporters/importers and returns an annual production trend
- The elements follow what the item carries: Production (5510) and tonne trade quantities (5610/5910) for an item with Production; for live-animal items, which have none, their Stocks elements (5111, 5112, 5114) and every import/export quantity element they carry, grouped by unit. `ranking_elements` names each ranking's elements and units, and the section headings repeat them
- Query selection prefers a unique exact label after trimming, collapsing whitespace, and case folding; otherwise requires a unique relevance match. For ambiguous terms such as `maize` or `milk`, call `faostat_resolve_codes` with `domain: "QCL"`, `dimension: "item"`, and the query, then pass the selected `item_code` (e.g. `56` for maize grain)
- Rankings are per-country sums grouped by unit, each country at its own latest reporting year; `years_behind` marks how far a row trails its ranking's latest year, and the notice names lagging rows with a `year_start` that drops them; countries only (aggregates excluded)
- Returns a partial profile without trade, with a notice — rather than failing — when the trade domain (TCL) isn't indexed or still syncing
- `top_n` caps each ranked list (at most 50 per call; a larger value is served at 50 with a notice); when the merged observation set is too large to inline it spills to a DataCanvas table — `faostat_dataframe_describe` for its columns, then `faostat_dataframe_query` for further SQL
- Every staging outcome is stated in the notice: the staged table, a set that fit inline, a staging failure, or a disabled canvas
- Typed errors: `missing_item`, `ambiguous_item`, `no_match`, `domain_not_indexed`, `index_not_ready`, `invalid_year_range`, `canvas_not_found`, `query_timeout`, `pool_closed`

---

### `faostat_dataframe_query` <sub>tool</sub>

- Single-statement read-only `SELECT` over staged `faostat_xxxxxxxx` tables — joins, aggregates, window functions, and CTEs all work
- Writes, DDL, `DROP`, `COPY`, `PRAGMA`, `ATTACH`, external-file functions, and system catalogs are rejected — including a column alias, CTE name, or table alias spelled like a DuckDB internal metadata view (such as `duckdb_tables` or `pg_tables`); rename it. The same spelling inside a string literal is fine.
- Engine-setting introspection, `query_table`, dynamic `query()` SQL, and file table references are rejected; `query()` with a single literal read-only `SELECT` remains supported
- `row_limit` caps the response (at most the canvas row limit per call — `CANVAS_DEFAULT_ROW_LIMIT`, 10000 unless configured — and default 1000, or that limit when it is lower); a larger value is served at that cap with `requestedRowLimit` / `effectiveRowLimit` and a notice; `truncated` means more rows exist, with no exact total computed on this path
- Typed errors: `canvas_disabled`, `canvas_not_found`, `missing_table`, `system_catalog_access`, `invalid_sql`

---

### `faostat_dataframe_describe` <sub>tool</sub>

- Lists staged tables with source tool, query params, row count, column schema, and recorded creation/expiry timestamps
- `name` describes one table outright; otherwise `offset` + `limit` (at most 100 per call, default 20; a larger value is served at 100 with a notice) page the listing newest-first
- Typed errors: `canvas_disabled`, `canvas_not_found`, `missing_table`

---

### `faostat_dataframe_drop` <sub>tool</sub>

- Opt-in: registered disabled — listed on the landing page with its enable hint, absent from `tools/list` — unless `FAOSTAT_DATAFRAME_DROP_ENABLED=true`
- Drops one staged `faostat_xxxxxxxx` table and its provenance from the session canvas, or from the canvas a `canvas_id` names
- Idempotent: a name not staged on that canvas returns `dropped: false` with a notice and changes nothing
- Typed errors: `canvas_disabled`, `canvas_not_found`

## Features

The [faostat-guide](./skills/faostat-guide/SKILL.md) covers reporting periods, censored values, source estimates, country versus regional totals, units, coverage, and complete SQL analysis across staged results. It ships with plugin, npm, Docker, and MCPB installs and is served through the MCP Skills extension as a skill resource.

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FAOSTAT-specific:

- Persistent local SQLite mirror of the FAOSTAT bulk corpus via the framework `MirrorService`, with FTS5 over the dimension labels driving code resolution
- Streaming bulk-ZIP ingester — skips domains whose upstream update date hasn't advanced, and stream-parses the normalized CSV into SQLite without materializing the full file in memory
- Config-driven domain selection (`FAOSTAT_DOMAINS`) — the indexed set can grow without code changes, and the full catalog stays browsable regardless
- DataCanvas SQL surface (DuckDB) for `GROUP BY`, ranking, and time-series analysis over staged result sets

Agent-friendly output:

- Country-vs-aggregate classification on every area, with aggregates excluded from sums by default — guards against double-counting World/continent rows with their member countries
- Data-quality provenance — every observation carries its FAOSTAT flag (`A`/`E`/`I`/`B`/`M`/`T`/`X`, others per domain), never dropped from output
- Graceful partial results — `faostat_commodity_profile` returns a profile without trade, with a notice, rather than failing, when the trade domain isn't indexed
- Typed error contracts — `index_not_ready`, `domain_not_indexed`, `canvas_disabled`, and others each carry a concrete recovery hint

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http faostat-mcp-server https://faostat.caseyjhand.com/mcp
```

Or run it locally after [building the mirror](#building-the-mirror):

```sh
claude mcp add faostat-mcp-server -- npx -y @cyanheads/faostat-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "faostat-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/faostat-mcp-server"]
    }
  }
}
```

The bulk-download service is public and keyless. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FAOSTAT_DOMAINS` | Comma-separated FAOSTAT domain codes to index into the local mirror. Domains outside this set appear in `faostat_list_domains` but are not queryable until added and re-synced. | `QCL,TCL,FBS,FS,RL,GLE,RFN,QV` |
| `FAOSTAT_MIRROR_PATH` | Directory holding the per-domain SQLite stores and the shared dimension database. Created if absent. | `./.faostat-mirror` |
| `FAOSTAT_BULK_BASE_URL` | FAOSTAT bulk-download service base URL (manifest + per-domain ZIPs). | `https://bulks-faostat.fao.org/production` |
| `FAOSTAT_REFRESH_CRON` | Cron for the in-process incremental refresh (HTTP transport only). Omit to disable and run `mirror:refresh` out-of-band. | — |
| `CANVAS_PROVIDER_TYPE` | DataCanvas engine. `duckdb` enables the SQL surface; set `none` to disable analytical staging (the `dataframe_*` tools then report `canvas_disabled`; `faostat_query_observations` pages with `offset` and stages nothing). | `duckdb` |
| `CANVAS_DEFAULT_ROW_LIMIT` | Most rows one `faostat_dataframe_query` call returns, and the cap its `row_limit` is served at; below 1000 it is also `row_limit`'s default. | `10000` |
| `FAOSTAT_DATAFRAME_DROP_ENABLED` | Set `true` to make `faostat_dataframe_drop` callable. Off, the tool is registered disabled: absent from `tools/list`, shown on the landing page with this hint. | `false` |
| `FAOSTAT_CLAMP_LIMITS` | A count input (`limit`, `top_n`, `row_limit`) above its cap is served at the cap, with `requestedX`/`effectiveX` fields and a notice. Set `false` to advertise each cap as a schema maximum and reject larger values. | `true` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto` (resolves to `stateful`). The server declares `stateless` in `src/index.ts` — no tool asks the caller for input mid-handler — and setting this overrides that declaration. | `stateless` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+), plus disk for the mirror. The default domain set (`QCL,TCL,FBS,FS,RL,GLE,RFN,QV`, ∼37M rows) needs a few GB; drop `TCL` (∼17M rows) from `FAOSTAT_DOMAINS` on a constrained host.

```sh
git clone https://github.com/cyanheads/faostat-mcp-server.git
cd faostat-mcp-server && bun install
cp .env.example .env
# Override the default domain set, mirror path, or refresh cron in .env.
```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest suite under Bun, then under Node
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Building the mirror

The corpus is not bundled. Before the data tools can answer queries, sync the selected domains into the local mirror:

```sh
bun run mirror:init      # one-time bootstrap — downloads and indexes the FAOSTAT_DOMAINS set
bun run mirror:refresh   # re-sync domains whose upstream update date has advanced; build missing planner statistics
bun run mirror:verify    # report sync status, local row counts, checkpoints, and dimension population
```

`mirror:init` is idempotent and resumable per domain — re-running after an interrupt re-streams only the unfinished domain ZIP. `FAOSTAT_DOMAINS` selects which domains are indexed; everything else in the catalog shows in `faostat_list_domains` with `indexed: false` until added and re-synced. On HTTP transport, set `FAOSTAT_REFRESH_CRON` to refresh in-process on a schedule; on stdio, run `mirror:refresh` out-of-band. The read tools return `index_not_ready` until the first sync completes.

After upgrading an older mirror, run `mirror:refresh`. FS and GLE rebuild once to recover period/text-item rows and separate source estimates, even when the upstream date is unchanged; they remain unready until that rebuild succeeds. Compatible numeric domains stay readable and gain the new indexes during refresh without a forced download. Until those indexes are prepared, domain-wide element/unit discovery can be slow; scope it with `item_codes` or `item_codes_text` when possible.

`mirror:refresh` also builds query-planner statistics (`ANALYZE`) for any selected domain whose statistics are missing or do not cover one of its indexes, even when its data is unchanged upstream — a mirror synced by an older release, one a refresh has just given a new index, or one whose last build failed. Otherwise the server builds them itself, in the background on a worker thread, the first time a data read touches that domain, and keeps answering meanwhile.

### Docker

```sh
docker run --rm -p 3010:3010 -v faostat-mirror:/usr/src/app/.faostat-mirror ghcr.io/cyanheads/faostat-mcp-server:latest
```

Build locally with `docker build -t faostat-mcp-server .`. For stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-v", "faostat-mirror:/usr/src/app/.faostat-mirror", "ghcr.io/cyanheads/faostat-mcp-server:latest"]`. The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/faostat-mcp-server`. A dedicated dependency stage installs the production tree for the target platform (DuckDB's prebuilt native binding included), so the slim runtime image carries no build toolchain and a multi-arch build never runs Bun under emulation. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. Mount a volume at the mirror path to persist the corpus across container recreations, and bootstrap it inside the container:

```sh
docker exec <container> bun run mirror:init      # one-time bootstrap
docker exec <container> bun run mirror:verify    # sync status, row counts, checkpoints, and dimension population
docker exec <container> bun run mirror:refresh   # re-sync updated domains; build missing planner statistics
```

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers the seven tools (`faostat_dataframe_drop` behind its opt-in flag), wires the mirror and canvas in `setup()`, schedules the HTTP refresh. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `skills/faostat-guide` | Published agent guide, also served as an MCP skill resource. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`). |
| `src/services/faostat-mirror` | The bulk-download mirror service — manifest discovery, streaming ZIP ingester, CSV parsing, dimension store, SQLite-backed `MirrorService` wiring, and the two-worker read pool (`read-pool.ts`, `read-worker.ts`) that runs cube reads and statistics builds off the main thread. |
| `src/services/canvas-accessor.ts`, `canvas-staging.ts` | DataCanvas accessor and the spill/query/describe/drop staging layer. |
| `scripts/faostat-mirror-*.ts` | `mirror:init` / `mirror:refresh` / `mirror:verify` CLIs. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in the `createApp()` array in `src/index.ts`
- Wrap external data: validate raw → normalize to domain type → return output schema; never fabricate missing fields, and carry the data-quality flag through

## Data attribution

Data is sourced from [FAOSTAT](https://www.fao.org/faostat/), the statistics division of the Food and Agriculture Organization of the United Nations (FAO). FAOSTAT data is published under [CC BY-4.0](https://creativecommons.org/licenses/by/4.0/); cite FAO as the source in downstream use. This project is not affiliated with or endorsed by the FAO.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
