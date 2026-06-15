<div align="center">
  <h1>@cyanheads/faostat-mcp-server</h1>
  <p><b>Global food & agriculture statistics from the UN FAOSTAT bulk-download corpus, served from a local SQLite mirror with a DataCanvas SQL surface, over MCP. STDIO & Streamable HTTP.</b>
  <div>6 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/faostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=faostat-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmFvc3RhdC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22faostat-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffaostat-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://faostat.caseyjhand.com/mcp](https://faostat.caseyjhand.com/mcp)

</div>

---

## Overview

[FAOSTAT](https://www.fao.org/faostat/) is the UN Food and Agriculture Organization's authoritative global statistics service — crop and livestock production, agricultural trade, food balances, food security and nutrition, land use, fertilizer use, and agrifood-systems emissions for 245+ countries and territories from 1961 to the present. Each domain is a data cube of **area** (country/region) × **item** (commodity) × **element** (metric) × **year**, with a data-quality flag on every observation.

This server does not call the FAOSTAT REST query API — that endpoint is auth-gated (`HTTP 401` keyless). Instead it syncs FAOSTAT's keyless **bulk-download service** (per-domain ZIPs of normalized CSVs plus their dimension code lists) into a persistent local **SQLite mirror** (embedded, with FTS5 over the dimension labels) and serves every query from that mirror — fast, offline-capable, and free of per-request rate limits. Analytical query results spill to a **DataCanvas** (DuckDB-backed) so an agent can run SQL `GROUP BY`, rankings, joins, and time-series analysis over the full result set.

> [!IMPORTANT]
> **First run requires a mirror build.** The corpus is not bundled. Run `bun run mirror:init` once to download and index the selected FAOSTAT domains before querying. The read tools return `index_not_ready` until the first sync completes. See [Building the mirror](#building-the-mirror).

## Tools

Six tools organized around the mirror's discover → resolve → query flow, with a DataCanvas pair for SQL over large result sets:

| Tool | Description |
|:---|:---|
| `faostat_list_domains` | Discover FAOSTAT statistical domains with codes, descriptions, last-update date, upstream row count, and local index status. The entry point — every query keys on a domain code. |
| `faostat_resolve_codes` | Resolve human terms to the opaque integer codes a query needs (areas, items, elements), flagging each area as a country or an aggregate region. |
| `faostat_query_observations` | Query a domain's cube by area(s), item(s), element(s), and year range. Inline preview for small results; large sets spill to a DataCanvas table. |
| `faostat_commodity_profile` | Workflow: assemble top producers, the production trend, and trade flows for one commodity from the production and trade domains in a single call. |
| `faostat_dataframe_query` | Run a read-only SQL `SELECT` against the canvas tables staged by the analytical tools. |
| `faostat_dataframe_describe` | List the canvas tables staged this session, each with provenance, row count, and column schema. |

### `faostat_list_domains`

Discover the catalog and what's queryable right now.

- Full FAOSTAT catalog read live from the bulk manifest, annotated with local mirror status
- Per-domain `indexed` / `index_ready` flags, local row count, and last completed sync
- `topic` substring filter over code, name, and topic (e.g. `"trade"`, `"emissions"`, `"QCL"`)
- `indexed_only` to list just the domains queryable from the local mirror

---

### `faostat_resolve_codes`

Turn names into the integer codes the cube requires — FAOSTAT is unqueryable without code resolution.

- FTS5 full-text matching (`query`, e.g. `"maize"` → item 56), substring filter (`name_contains`), or exact-code lookup (`code`)
- Resolves within a `dimension`: `area` (countries/regions), `item` (commodities), or `element` (metrics like production, yield, import quantity)
- Every area match is flagged `country` or `aggregate` (World, continents, economic groupings; codes ≥ 5000) so an agent can avoid summing a region with its member countries
- Surfaces the CPC crosswalk code for items where available
- Omit all of `query` / `name_contains` / `code` to list the whole dimension

---

### `faostat_query_observations`

The core data tool — query a domain's cube and get observations with their data-quality flag.

- Filter by `area_codes`, `item_codes`, `element_codes` (resolve them first), and a `year_start` / `year_end` range
- **Aggregate regions are excluded by default** (`include_aggregates: false`) so a naive `SUM` does not double-count a region with its members — set `include_aggregates: true` for World/continent roll-ups, or pass explicit `area_codes` to query exactly what you name
- Small result sets return inline; large ones spill to a DataCanvas table (returned `canvas_id` + `table_name`) for SQL aggregation
- Every row carries its flag (`A`=Official, `E`=Estimated, `I`=Imputed, `B`=break, `X`=external) — honor it; never treat estimated/imputed values as official

---

### `faostat_commodity_profile`

A workflow tool that assembles a global profile for one commodity in a single call.

- Accepts a commodity name, resolves it to item codes, then queries the production (`QCL`) and trade (`TCL`) domains and merges the results
- Returns top-producing countries, top exporters, and top importers (ranked by the latest year present), plus a production-trend point count — countries only, aggregates excluded
- Returns a **partial profile** with a notice naming the gap when a required domain (e.g. trade) is not indexed, rather than failing
- The full merged production + trade observation set spills to a DataCanvas table for deeper SQL

---

### `faostat_dataframe_query` / `faostat_dataframe_describe`

SQL analytics over the canvas tables (`faostat_xxxxxxxx`) that `faostat_query_observations` and `faostat_commodity_profile` stage. Call `faostat_dataframe_describe` first to discover table and column names, then `faostat_dataframe_query` for cross-country and cross-item aggregation, `GROUP BY` rankings, joins, window functions, and CTEs — standard DuckDB SQL.

- **Read-only.** Writes, DDL, `DROP`, `COPY`, `PRAGMA`, `ATTACH`, and external-file table functions are rejected by the framework SQL gate. System catalogs (`information_schema`, `sqlite_master`, `duckdb_*`) are denied so a caller can't enumerate staged tables it doesn't hold a handle for — list them via `faostat_dataframe_describe`.
- Staged-table columns: `area_code`, `area`, `item_code`, `item`, `element_code`, `element`, `year`, `unit`, `value`, `flag`. Keep `flag` in projections and honor it in interpretation.
- `canvas_id` is optional on both tools — omit it to operate on the tables staged in the current session (the common case).

All tool output is also rendered as human-readable markdown (`content[]`) alongside the structured payload, so tool-only MCP clients reach the same data.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, the framework catches, classifies, and formats; typed error contracts give agents actionable recovery hints
- Pluggable auth: `none`, `jwt`, `oauth`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

FAOSTAT-specific:

- **Persistent local SQLite mirror** of the FAOSTAT bulk corpus via the framework `MirrorService` — one indexed table per selected domain plus shared dimension tables, with FTS5 over the dimension labels driving code resolution
- **Streaming bulk-ZIP ingester** — fetches the manifest, compares each domain's update date against the stored checkpoint to skip unchanged domains, and stream-parses the normalized CSV (∼18× decompression ratio) into SQLite without materializing the full file in memory
- **Config-driven domain selection** (`FAOSTAT_DOMAINS`) — the indexed set can grow without code changes; `faostat_list_domains` always shows the full catalog and which domains are locally queryable
- **DataCanvas SQL surface** (DuckDB) — analytical cube queries spill to a staged table for ad-hoc `GROUP BY` / ranking / time-series analysis

Agent-friendly output:

- **Country-vs-aggregate classification** on every area, plus aggregate exclusion by default — guards against the double-counting hazard of summing World/continent rows with their member countries
- **Data-quality flags carried through** on every observation (`A`/`E`/`I`/`B`/`X`) — never dropped, so downstream rigor can honor official-vs-estimated distinctions
- **Graceful partial results** — `faostat_commodity_profile` returns a production-only profile with a notice when trade is not indexed, rather than failing the request
- **Typed error contracts** — `index_not_ready`, `domain_not_indexed`, `empty_result`, `canvas_disabled`, and `no_match` each carry a concrete recovery hint (run the init script, pick an indexed domain, widen the query, enable the canvas)

## Getting started

### Public Hosted Instance

A public instance is available at `https://faostat.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "faostat-mcp-server": {
      "type": "streamable-http",
      "url": "https://faostat.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. The server runs entirely on a local mirror, so [build the mirror](#building-the-mirror) once before querying.

```json
{
  "mcpServers": {
    "faostat-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/faostat-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "faostat-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/faostat-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "faostat-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-v", "faostat-mirror:/usr/src/app/.faostat-mirror",
        "ghcr.io/cyanheads/faostat-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

No API key is required — the FAOSTAT bulk-download service is public and keyless.

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- Disk for the local mirror. The default domain set (`QCL,TCL,FBS,FS,RL,GLE,RFN,QV`, ∼37M rows) needs a few GB; `TCL` (∼17M rows) dominates and can be dropped from `FAOSTAT_DOMAINS` on a constrained host.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/faostat-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd faostat-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env to override the default domain set, mirror path, or refresh cron
```

### Building the mirror

The corpus is not bundled. Before the data tools can answer queries, sync the selected domains into the local mirror:

```sh
bun run mirror:init      # one-time bootstrap — downloads and indexes the FAOSTAT_DOMAINS set
bun run mirror:refresh   # re-sync domains whose upstream update date has advanced
bun run mirror:verify    # report sync status, local row counts, and sample reads
```

`mirror:init` is idempotent and resumable per domain — re-running after an interrupt re-streams only the unfinished domain ZIP. `FAOSTAT_DOMAINS` selects which domains are indexed; everything else in the catalog shows in `faostat_list_domains` with `indexed: false` until added and re-synced. On HTTP transport, set `FAOSTAT_REFRESH_CRON` to refresh in-process on a schedule; on stdio, run `mirror:refresh` out-of-band.

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FAOSTAT_DOMAINS` | Comma-separated FAOSTAT domain codes to index into the local mirror. Domains outside this set appear in `faostat_list_domains` but are not queryable until added and re-synced. | `QCL,TCL,FBS,FS,RL,GLE,RFN,QV` |
| `FAOSTAT_MIRROR_PATH` | Directory holding the per-domain SQLite stores and the shared dimension database. Created if absent. | `./.faostat-mirror` |
| `FAOSTAT_BULK_BASE_URL` | FAOSTAT bulk-download service base URL (manifest + per-domain ZIPs). | `https://bulks-faostat.fao.org/production` |
| `FAOSTAT_REFRESH_CRON` | Cron for the in-process incremental refresh (HTTP transport only). Omit to disable and run `mirror:refresh` out-of-band. | — |
| `CANVAS_PROVIDER_TYPE` | DataCanvas engine. `duckdb` enables the SQL surface; set `none` to disable analytical staging (the `dataframe_*` tools then report `canvas_disabled` and large queries refuse to spill). | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t faostat-mcp-server .
docker run --rm -p 3010:3010 -v faostat-mirror:/usr/src/app/.faostat-mirror faostat-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/faostat-mcp-server`. The build stage compiles the native dependencies (`@duckdb/node-api`, `better-sqlite3`) and the production stage reuses the prebuilt `node_modules`, so the slim runtime image carries no build toolchain. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. Mount a volume at the mirror path to persist the corpus across container recreations, and bootstrap it inside the container:

```sh
docker exec <container> bun run mirror:init      # one-time bootstrap
docker exec <container> bun run mirror:verify    # sync status + sample reads
docker exec <container> bun run mirror:refresh   # re-sync when FAO has updated a domain
```

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers the six tools, wires the mirror and canvas in `setup()`, schedules the HTTP refresh. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`). |
| `src/services/faostat-mirror` | The bulk-download mirror service — manifest discovery, streaming ZIP ingester, CSV parsing, dimension store, SQLite-backed `MirrorService` wiring. |
| `src/services/canvas-accessor.ts`, `canvas-staging.ts` | DataCanvas accessor and the spill/query/describe staging layer. |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
