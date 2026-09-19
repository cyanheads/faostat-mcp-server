<div align="center">
  <h1>@cyanheads/faostat-mcp-server</h1>
  <p><b>Global food & agriculture statistics from the UN FAOSTAT bulk-download corpus, served from a local SQLite mirror with a DataCanvas SQL surface, over MCP. STDIO & Streamable HTTP.</b>
  <div>6 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/faostat-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faostat-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/faostat-mcp-server/releases/latest/download/faostat-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=faostat-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmFvc3RhdC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22faostat-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffaostat-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://faostat.caseyjhand.com/mcp](https://faostat.caseyjhand.com/mcp)

</div>

---

## Overview

Global food and agriculture statistics from the UN FAOSTAT bulk-download corpus — crop and livestock production, agricultural trade, food balances, food security and nutrition, land use, fertilizer use, and agrifood-systems emissions for 245+ countries and territories from 1961 to the present. Discover a domain, resolve area/item/element codes, then query the cube; large or merged result sets spill to a DataCanvas SQL surface for `GROUP BY`, ranking, and time-series analysis. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `faostat_list_domains` | Discover FAOSTAT statistical domains with codes, descriptions, last-update date, upstream row count, and local index status. The entry point — every query keys on a domain code. |
| `faostat_resolve_codes` | Resolve human terms to the opaque integer codes a query needs (areas, items, elements), flagging each area as a country or an aggregate region. |
| `faostat_query_observations` | Query a domain's cube by area(s), item(s), element(s), and year range. Inline preview for small results; large sets spill to a DataCanvas table. |
| `faostat_commodity_profile` | Workflow: assemble top producers, the production trend, and trade flows for one commodity from the production and trade domains in a single call. |
| `faostat_dataframe_query` | Run a read-only SQL `SELECT` against the canvas tables staged by the analytical tools. |
| `faostat_dataframe_describe` | List the canvas tables staged this session, each with provenance, row count, and column schema. |

## Capability reference

### `faostat_list_domains` <sub>tool</sub>

- Full FAOSTAT catalog (~69 domains) read live from the bulk manifest, annotated with local mirror status
- `code` for an exact domain lookup; `topic` substring filter over code/name/topic; `indexed_only` to list only domains queryable from the local mirror
- `offset` + `limit` (max 200, default 20) page the catalog — response reports `totalMatches`, `truncated`, and `nextOffset`
- Each entry reports `indexed` / `index_ready` flags, local row count, and last completed sync

---

### `faostat_resolve_codes` <sub>tool</sub>

- FTS5 full-text `query`, substring `name_contains`, or exact `code` lookup within a `dimension`: `area`, `item`, or `element`
- Item/element matches are scoped to codes present in the given `domain`'s cube; area codes are shared across domains
- Every area match is flagged `country` or `aggregate` (codes ≥ 5000, plus curated sub-threshold roll-ups such as China=351)
- `limit` (max 200, default 50) + `offset` page the match set
- Typed errors: `unknown_domain`, `index_not_ready`

---

### `faostat_query_observations` <sub>tool</sub>

- Filters by `area_codes` / `item_codes` / `element_codes` and an inclusive `year_start` / `year_end` range
- Aggregate regions excluded by default (`include_aggregates: false`); explicit `area_codes` bypass the exclusion
- `limit` caps the inline page (default 200, max 1000); a match that exceeds it spills in full to a DataCanvas table (50,000-row staging cap) for SQL via `faostat_dataframe_query`
- Every row carries its data-quality `flag` (`A`/`E`/`I`/`B`/`M`/`T`/`X`, others per domain) — never dropped
- Typed errors: `domain_not_indexed`, `index_not_ready`, `canvas_disabled`, `invalid_year_range`

---

### `faostat_commodity_profile` <sub>tool</sub>

- Resolves `item_query` to up to 5 item codes, then ranks top producers/exporters/importers and returns an annual production trend in one call
- Rankings are per-country sums grouped by unit, each country at its own latest reporting year; countries only (aggregates excluded)
- Returns a partial, production-only profile with a notice — rather than failing — when the trade domain (TCL) isn't indexed or still syncing
- `top_n` caps each ranked list (max 50); the merged observation set spills to a DataCanvas table for further SQL
- Typed errors: `no_match`, `index_not_ready`, `invalid_year_range`

---

### `faostat_dataframe_query` <sub>tool</sub>

- Single-statement read-only `SELECT` over staged `faostat_xxxxxxxx` tables — joins, aggregates, window functions, and CTEs all work
- Writes, DDL, `DROP`, `COPY`, `PRAGMA`, `ATTACH`, external-file functions, and system catalogs (`information_schema`, `sqlite_master`, `duckdb_*`) are rejected
- `row_limit` caps the response (default 1000, max 10000); `truncated` means more rows exist, with no exact total computed on this path
- Typed errors: `canvas_disabled`, `canvas_not_found`, `missing_table`, `system_catalog_access`, `invalid_sql`

---

### `faostat_dataframe_describe` <sub>tool</sub>

- Lists staged tables with source tool, query params, row count, column schema, and creation/expiry (2-hour sliding TTL)
- `name` describes one table outright; otherwise `offset` + `limit` (max 100, default 20) page the listing newest-first
- Typed errors: `canvas_disabled`, `canvas_not_found`, `missing_table`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FAOSTAT-specific:

- Persistent local SQLite mirror of the FAOSTAT bulk corpus via the framework `MirrorService`, with FTS5 over the dimension labels driving code resolution
- Streaming bulk-ZIP ingester — skips domains whose upstream update date hasn't advanced, and stream-parses the normalized CSV into SQLite without materializing the full file in memory
- Config-driven domain selection (`FAOSTAT_DOMAINS`) — the indexed set can grow without code changes, and the full catalog stays browsable regardless
- DataCanvas SQL surface (DuckDB) for `GROUP BY`, ranking, and time-series analysis over spilled result sets

Agent-friendly output:

- Country-vs-aggregate classification on every area, with aggregates excluded from sums by default — guards against double-counting World/continent rows with their member countries
- Data-quality provenance — every observation carries its FAOSTAT flag (`A`/`E`/`I`/`B`/`M`/`T`/`X`, others per domain), never dropped from output
- Graceful partial results — `faostat_commodity_profile` returns a production-only profile with a notice, rather than failing, when the trade domain isn't indexed
- Typed error contracts — `index_not_ready`, `domain_not_indexed`, `canvas_disabled`, and others each carry a concrete recovery hint

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

`mirror:init` is idempotent and resumable per domain — re-running after an interrupt re-streams only the unfinished domain ZIP. `FAOSTAT_DOMAINS` selects which domains are indexed; everything else in the catalog shows in `faostat_list_domains` with `indexed: false` until added and re-synced. On HTTP transport, set `FAOSTAT_REFRESH_CRON` to refresh in-process on a schedule; on stdio, run `mirror:refresh` out-of-band. The read tools return `index_not_ready` until the first sync completes.

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FAOSTAT_DOMAINS` | Comma-separated FAOSTAT domain codes to index into the local mirror. Domains outside this set appear in `faostat_list_domains` but are not queryable until added and re-synced. | `QCL,TCL,FBS,FS,RL,GLE,RFN,QV` |
| `FAOSTAT_MIRROR_PATH` | Directory holding the per-domain SQLite stores and the shared dimension database. Created if absent. | `./.faostat-mirror` |
| `FAOSTAT_BULK_BASE_URL` | FAOSTAT bulk-download service base URL (manifest + per-domain ZIPs). | `https://bulks-faostat.fao.org/production` |
| `FAOSTAT_REFRESH_CRON` | Cron for the in-process incremental refresh (HTTP transport only). Omit to disable and run `mirror:refresh` out-of-band. | — |
| `CANVAS_PROVIDER_TYPE` | DataCanvas engine. `duckdb` enables the SQL surface; set `none` to disable analytical staging (the `dataframe_*` tools then report `canvas_disabled` and large queries refuse to spill). | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto` (resolves to `stateful`). The server declares `stateless` in `src/index.ts` — no tool asks the caller for input mid-handler — and setting this overrides that declaration. | `stateless` |
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

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
