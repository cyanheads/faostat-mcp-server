# faostat-mcp-server — Design

Global food and agriculture statistics from the UN's [FAOSTAT](https://www.fao.org/faostat/) — crop and livestock production, agricultural trade, food balances, food security, land use, fertilizer/pesticide use, and agri-emissions, for 245+ countries from 1961 to present.

Data path: FAOSTAT's keyless **bulk-download service** (per-domain zipped normalized CSVs), synced into a persistent local **MirrorService** (embedded SQLite + FTS5) and queried locally. The public REST query API requires authorization (401 keyless — see [Design Decisions](#design-decisions)), so the mirror is the data path, not an optimization. Analytical query results spill to a **DataCanvas** for ad-hoc SQL.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `faostat_list_domains` | Discover FAOSTAT statistical domains (production, trade, food balances, food security, land use, emissions, prices, population) with codes, descriptions, last-update date, row count, and local index status. Entry point — every query keys on a domain code. Bounded retrieval: exact-code lookup, filters, and paging. | `code?` (exact lookup), `topic?` (filter), `indexed_only?`, `limit?`, `offset?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `faostat_resolve_codes` | Resolve human terms to the opaque codes a query needs, within a domain: areas (countries/regions), items (commodities), elements (metrics). "wheat" → item 15; "production" → element 5510. FAOSTAT is unqueryable without code resolution. Flags whether an area code is an individual country or an aggregate region. | `domain`, `dimension` (`area`\|`item`\|`element`), `query?`, `name_contains?`, `code?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `faostat_query_observations` | Query a domain's data cube by area(s), item(s), element(s), and year range. Returns observations (area, item, element, year, value, unit, data-quality flag). Inline preview for small results; large result sets spill to a DataCanvas table — `faostat_dataframe_describe` for its columns, then SQL aggregation via `faostat_dataframe_query`. | `domain`, `area_codes?`, `item_codes?`, `element_codes?`, `year_start?`, `year_end?`, `include_aggregates?`, `canvas_id?` | `readOnlyHint`, `openWorldHint:false` |
| `faostat_commodity_profile` | Workflow: assemble a global profile for one commodity — top producers, the annual production trend, and trade flows (top importers/exporters) — from the production and trade domains in one call. Rankings are per-country sums across the resolved items, each country at its own latest year; the trend inlines as year/value points. When the merged observation set is too large to inline it spills to a DataCanvas table — `faostat_dataframe_describe` for its columns, then `faostat_dataframe_query`. Convenience over chaining `resolve_codes` + multiple `query_observations`. | `item_query`, `year_start?`, `year_end?`, `top_n?`, `canvas_id?` | `readOnlyHint`, `openWorldHint:false` |
| `faostat_dataframe_query` | Run a read-only SQL SELECT against tables staged on a DataCanvas by `faostat_query_observations` or `faostat_commodity_profile`. Use for cross-country/cross-item aggregation, grouping, joins, and time-series analysis over the full result set. | `sql`, `canvas_id?`, `row_limit?` | `readOnlyHint`, `openWorldHint:false` |
| `faostat_dataframe_describe` | List DataCanvas tables and columns staged by a prior query call — each table's name, row count, and column schema. Call before `faostat_dataframe_query` to discover table/column names for SQL. | `canvas_id?`, `name?`, `limit?`, `offset?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `faostat_dataframe_drop` | Drop one staged canvas table and its provenance before its 2-hour TTL. Idempotent (`dropped: false` for a name not staged on the resolved canvas). Opt-in: registered through `disabledTool()` unless `FAOSTAT_DATAFRAME_DROP_ENABLED=true`. | `name`, `canvas_id?` | `destructiveHint`, `idempotentHint`, `openWorldHint:false` |

**Surface count: 7 tools** (`faostat_dataframe_drop` opt-in). No resources, no prompts (see below).

### Resources

None. The data behind every resource candidate (domain catalog, code lists, observations) is already reachable through the tool surface, and the server's clients are agent-driven (tool-only). A `faostat://domain/{code}` summary resource was considered and dropped — `faostat_list_domains` covers it without a second access path to maintain.

### Prompts

None. Purely data/action-oriented; no recurring multi-step interaction pattern that a static template improves. `faostat_commodity_profile` already encodes the one workflow worth structuring, as a tool (works on tool-only clients; a prompt would not).

## Overview

**What it wraps:** FAOSTAT — the FAO's authoritative global food & agriculture statistics, organized into ~68 *domains*. Each domain is a cube of **area** (country/region) × **item** (commodity) × **element** (metric: production, yield, area harvested, import/export quantity & value, …) × **year**, with a data-quality **flag** per observation.

**Data acquisition:** FAOSTAT publishes the full corpus as keyless per-domain ZIPs (normalized long-format CSV + bundled dimension code lists). The server syncs a **selected set of domains** into a local SQLite mirror on a schedule and serves every query from the mirror — fast, offline-capable, no per-request rate limits. The (auth-gated) REST API is not used.

**Audience:** Economists, food-security and development researchers, journalists, sustainability analysts, and agents answering production/trade/consumption questions at country and global scale. Composes with `worldbank-mcp-server` (development indicators alongside ag production), `usda-mcp-server` (US detail vs. FAO's global view), `eurostat-mcp-server` (EU cross-check), `gbif-biodiversity-mcp-server` (crop/species context).

**Scope:** Read-only. The corpus is published reference data; there are no writes, no irreversible operations. The only state the server owns is its local mirror (a derived cache of public data, rebuildable from source) and ephemeral per-session canvases.

## Requirements

- **Keyless.** No API key — the bulk service is public. `auth: none`.
- **Local mirror as primary data path.** Sync selected domains' bulk CSVs into embedded SQLite (one table per domain, plus shared dimension tables); query the mirror, never the live REST API per request.
- **Code resolution is mandatory.** Area/item/element codes are opaque integers. `faostat_resolve_codes` (FTS5 over the bundled code lists) is a first-class tool, not a convenience — without it the cube is unqueryable.
- **Area-code duality must surface.** The `area` dimension mixes individual countries (e.g. Afghanistan=2) and aggregate regions (World, Africa=5100, EU). Observations default to **excluding aggregates** (`include_aggregates: false`) so an agent doesn't sum a region with its members; `resolve_codes` labels each area `country` vs `aggregate`.
- **Data-quality flags carried through.** Every observation has a flag (A=Official, E=Estimated, I=Imputed, B=Time-series break, X=External). Carry it on every row; never drop it — it's load-bearing for rigor.
- **Analytical SQL surface.** Cube queries are inherently `GROUP BY country/item/year` analytical workloads → DataCanvas spillover + a mandatory `faostat_dataframe_describe`/`faostat_dataframe_query` pair.
- **Refresh, don't block startup.** Initial mirror build runs out-of-band (CLI); incremental refresh runs on a schedule. Read path gates on mirror readiness with a clear "still indexing" error when cold.
- **Stream-parse bulk CSVs.** Decompressed CSVs are large (QCL: 33 MB zip → ~600 MB CSV, ~18× ratio). Stream rows from the zip into SQLite; never materialize the full CSV in memory.

## Domain Mapping

FAOSTAT exposes ~68 domains. The mirror indexes a **selected default set** (the high-value analytical cubes; standard `Area×Item×Element×Year` schema). Survey-shaped domains (e.g. `MDDW`, with `Survey`/`FoodGroup` columns) and the giant detailed trade matrix (`TM`, 52M rows) are excluded from the v1 selection.

| Domain | Code | Rows (confirmed) | Purpose |
|:-------|:-----|:-----------------|:--------|
| Crops & livestock production | `QCL` | 4.2M | Production, yield, area harvested |
| Trade: crops & livestock | `TCL` | 17.3M | Import/export quantity and value |
| Food Balances (2010–) | `FBS` | 4.8M | Supply, food vs. feed vs. other use |
| Food Security & Nutrition (suite) | `FS` | 0.28M | Undernourishment, dietary energy |
| Land use | `RL` | 0.41M | Agricultural land, arable, forest |
| Agrifood-systems emissions (livestock) | `GLE` | 6.7M | Livestock and manure emissions |
| Agrifood-systems emissions (totals) | `GT` | 2.5M | Aggregated agri-emissions totals — opt in via `FAOSTAT_DOMAINS` |
| Agrifood-systems emissions (crops) | `GCE` | 0.77M | Crop-related agri-emissions — opt in via `FAOSTAT_DOMAINS` |
| Fertilizers by nutrient | `RFN` | 0.24M | Nutrient N/P/K production & use |
| Value of agricultural production | `QV` | 3.4M | Gross production value |

Default indexed set (`FAOSTAT_DOMAINS` default: `QCL,TCL,FBS,FS,RL,GLE,RFN,QV`) totals ~37M rows. `TCL` (17.3M) is at the upper edge of the MirrorService tier (10⁴–10⁷ guide); it is included because it is a normalized cube like `QCL` and benefits from SQLite's indexed lookups over the `(item_code, element_code, year)` indexes. A deployment constrained on RAM/disk can drop it from `FAOSTAT_DOMAINS`.

The selection is **config-driven** (`FAOSTAT_DOMAINS`), so the indexed set can grow without code changes. `faostat_list_domains` reads the live manifest for the *full* catalog and annotates which are locally indexed — an agent always sees what exists and what's queryable.

**Operations by noun (raw material for the tool surface):**

| Noun | Operations | Tool coverage |
|:-----|:-----------|:--------------|
| Domain | list (with codes, descriptions, sync state) | `faostat_list_domains` |
| Code (area/item/element) | resolve name→code, list within domain, classify country/aggregate | `faostat_resolve_codes` |
| Observation | query by area×item×element×year, filter aggregates, aggregate via SQL | `faostat_query_observations` → `faostat_dataframe_query` |
| Commodity (cross-domain) | top producers + trend + trade flows | `faostat_commodity_profile` |

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `faostat-mirror` | FAOSTAT bulk-download service (manifest `datasets_E.json` + per-domain ZIPs); embedded SQLite mirror via `MirrorService` (`defineMirror`/`sqliteMirrorStore`) | all data tools |
| `ReadPool` (`faostat-mirror/read-pool.ts` + `read-worker.ts`) | Two `node:worker_threads` workers that run the cube reads and the planner-statistics builds off the main thread | `faostat-mirror` |
| canvas accessor | `core.canvas` (DataCanvas, DuckDB) — module-level `getCanvas()` accessor wired in `setup()` | `query_observations`, `commodity_profile`, `dataframe_*` |

**Mirror service shape.** One `MirrorService` instance per indexed domain (each domain is its own table + FTS index over the dimension labels), plus shared dimension tables (`areas`, `items`, `elements`, `flags`) populated from the bundled code-list CSVs. The `sync` ingester:

1. Fetches the manifest (`datasets_E.json`); for each selected domain compares `DateUpdate` / `Last-Modified` against the stored checkpoint — skip unchanged domains.
2. Streams the domain ZIP, parses the bundled code-list CSVs into the shared dimension tables, then stream-parses the normalized data CSV → row objects keyed by the declared columns.
3. Yields pages of `{ records, checkpoint: DateUpdate }`. `checkpoint` is the domain's ISO `DateUpdate` (lexicographically monotonic); no intra-run `cursor` needed (a domain ZIP is one atomic unit — re-fetch on interrupt rather than resume mid-file).

**Schema (per-domain table):** `area_code INTEGER, area_m49 TEXT, area TEXT, item_code INTEGER, item TEXT, element_code INTEGER, element TEXT, year INTEGER, unit TEXT, value DOUBLE, flag TEXT, note TEXT`. Indexes on `(area_code)`, `(item_code)`, `(element_code)`, `(year)`, plus the composites `(element_code, year)` and `(item_code, element_code, year)` matching the common filter shapes (see row-read ordering below). FTS5 over `area`, `item`, `element` (drives `resolve_codes`). The ingester maps columns off the **actual CSV header per domain** (not a hardcoded order) so a non-standard domain fails loudly rather than mis-mapping.

**Off-thread reads (`ReadPool`).** Both SQLite drivers are synchronous and neither can interrupt a running statement, so a cube read on the main thread would stall every request, `/healthz` included, for its full duration. The five cube reads (`queryObservations`, `streamObservations`, `rankAreaTotals`, `sumByYear`, and the distinct-code read behind `resolve`) run instead on `ReadPool` (`src/services/faostat-mirror/read-pool.ts`): two `node:worker_threads` workers, the same API under Bun and Node, fed from one first-in, first-out queue (#3). The main thread still builds every statement and owns the framework `Mirror` (sync, DDL, state), and it opens a domain file before any worker does, so the file and its cube table exist. Each worker (`read-worker.ts`) runs one job at a time against its own read-write handle per domain file, opened through the framework's `openSqliteHandle` (`bun:sqlite` under Bun, `better-sqlite3` under Node), and replies with the rows or a serializable error. Workers spawn on first use and do not keep the process alive while idle. `teardown()` closes the pool first: queued and running jobs reject with `ServiceUnavailable`, idle workers close their handles and exit, and a worker mid-statement is retired rather than awaited.

- **Per-call ceiling.** A tool call takes one signal from `FaostatMirror.readSignal()` before its first read: the call's own signal plus a 45 s ceiling (`QUERY_CEILING_MS`), which sits under the MCP SDK's 60 s default client timeout and covers queue wait and execution across every read the call makes. Past it, the read fails with a retryable `Timeout` carrying `reason: 'query_timeout'`. `faostat_query_observations`, `faostat_commodity_profile`, and `faostat_resolve_codes` declare that reason with their own recovery. A cancelled call settles as `RequestCancelled`. A read failure raised inside the staging stream (ceiling, cancellation, crashed worker) fails the call rather than falling back to an inline page.
- **Cut-off and retirement.** When the signal aborts, the caller is rejected at once. A queued read just leaves the queue. A running read cannot be stopped, since `worker.terminate()` takes effect only once the statement returns, so its worker is retired and a replacement serves the next job. Retired workers count toward a four-thread cap: a replacement spawns only while live plus retired workers number fewer than four, and at the cap a job with no free live worker waits in the queue for a retired worker to exit, so the pool never holds more than four threads. A worker that crashes fails its job with a retryable `ServiceUnavailable` and is respawned for the next.
- **Handle epochs.** A connection that has loaded its schema keeps the planner statistics it read then. After each successful `ANALYZE` the main thread bumps that file's epoch (`invalidate()`), and a worker holding a handle from an older epoch reopens it before its next job on the file.
- **Opening behind a lock.** A worker's open waits out another connection's lock — such as one recovering the WAL index after workers are retired and respawned — for up to the handle's 5 s `busy_timeout`: `openSqliteHandle` sets `busy_timeout` before its first read of the file and retries the switch to WAL itself ([cyanheads/mcp-ts-core#607](https://github.com/cyanheads/mcp-ts-core/issues/607)). An open that still fails rejects the read as `DatabaseError`, the driver's error on `cause`.

**Query-planner statistics.** The composite indexes only pay off once SQLite has cardinality statistics. With no `sqlite_stat1`, the cost-based optimizer cannot tell the two composites apart and seeks `(element_code, year)` for an item+element filter, scanning that entire element slice: measured warm on the real `QCL` mirror (4.2M rows), ~1,190 ms vs ~6 ms for the year-scoped ranking `faostat_commodity_profile` runs, with `EXPLAIN QUERY PLAN` confirming the index switch. A cold first touch of the 916 MB file is worse again. The penalty is largest exactly where a year bound narrows an item+element filter — the aggregate shapes below. The mirror therefore runs a full `ANALYZE` per cube table after any sync that applies rows, since a domain ZIP replaces the vintage the previous statistics described, and whenever a sync or a data read finds a domain with no `sqlite_stat1`, so a mirror synced before statistics existed, or whose last build failed, is caught up without a re-download. A sampled `ANALYZE` (`PRAGMA analysis_limit`) is not a substitute: every limit measured produced uniform per-key estimates that left the wrong index selected.

A build never runs on the serving thread (#24). Cold, `ANALYZE` takes 9.7 s on `QCL` and about 103 s on `TCL` when run on the main thread, which would stall every request for its whole run. The build is instead an `analyze` job on the read pool, on a worker's read-write handle; `TCL` takes about 71 s there while the main thread keeps answering `/healthz` and other calls. When a data read finds a domain without statistics, it schedules one background build and answers at once on the plan it has. Waiting would push the caller past its `query_timeout`. The build takes no signal, so no ceiling or cancellation cuts it off, and it is single-flight per domain: reads arriving while it runs schedule no second one. The pool runs at most one build at a time. A queued build lets reads pass it, so the two workers never both hold a build and reads always keep one. Nothing builds at startup; the first data read or sync that finds a domain without statistics schedules it.

`ANALYZE` holds the file's write lock for its whole run, so an in-process sync and a build of the same domain never overlap. `runDomainSync` waits out a build already in flight before it writes, and data reads schedule no build while it runs. The sync then ends with its own build, awaited, when it applied rows or the domain still has no statistics — which is how `mirror:refresh` warms a domain that is unchanged upstream but has no statistics. A sync that applied nothing to a domain that has statistics skips the pass, so the nightly no-op refresh stays a no-op. A second sync of a domain whose sync is running fails at once with `Conflict`, since both would share the domain's ingester slot. The guarantee covers only syncs in the server's own process: an out-of-band `mirror:refresh` that writes a domain while the server is building its statistics waits up to the 5 s `busy_timeout` for the lock, then fails its page write.

The read-side trigger sits on the reads the statistics serve — the filtering and aggregating paths — and not on `resolve_codes`'s distinct-dimension-code scan, which the single-column index already satisfies: that call, the one an agent makes first, would spend a worker on an optimization it cannot use (#22). Statistics are an optimization, so a failed build (read-only volume, a writer holding the lock past `busy_timeout`) leaves the domain on the uninformed plan rather than failing anything, and only success is remembered. A later data read retries, so contention that clears costs one more build rather than the uninformed plan for the rest of the process. Reads stop retrying after three failed attempts per domain per process, so an obstruction that never clears cannot re-run a minute-long pass on every request; a later sync still builds.

**Row-read ordering.** The two row reads — the overflow probe behind `faostat_query_observations` and the spill stream both staging tools use — return rows in year order and prepare one statement, built by `buildObservationSql`. Without an item filter they `ORDER BY year`, so `(element_code, year)` or `(year)` supplies the order and the `LIMIT` stops the scan early. With an item filter they `ORDER BY +year`: the unary plus stops the planner from choosing an index just to avoid the sort, so it seeks `(item_code, element_code, year)` and sorts the matched rows, which the item codes already bound. Under a plain `year` and the spill stream's 50,001-row `LIMIT`, `bun:sqlite` (the Docker runtime) chose the `(element_code, year)` order instead and walked the whole element slice, testing `item_code` per row — on `QCL`, 1.6M rows to return 27,893 for the five items "sugar" resolves to (#33).

**Resilience.** Both bulk fetches use the raw `fetch` (a `fetchWithTimeout` deadline would also cover the body stream of a multi-hundred-MB ZIP) and map a non-2xx response through `httpErrorFromResponse`, so the status sets the error code: 403 → `Forbidden`, 404 → `NotFound`, 408/425/504 → `Timeout`, 429 → `RateLimited`, other 5xx → `ServiceUnavailable`. The manifest fetch runs inside `withRetry` (base delay 1.5 s, three retries — the service is occasionally slow or degraded), so only a transient status (408, 425, 429, 5xx other than 501) re-enters the backoff; any other status fails on its first request. The FAO bulk host answers a wrong path with 403, so a manifest failure that will not be retried carries a recovery hint naming `FAOSTAT_BULK_BASE_URL` (in the hint, never the message), which `faostat_list_domains` and the `mirror:init` / `mirror:refresh` scripts all show. The per-domain ZIP download is not retried in-process; its status error names the domain and keeps the ZIP URL on `error.data`, since it reaches only the sync logs. Parse failures on a malformed ZIP throw transient errors, not `SerializationError`, so a refresh retries.

**Readiness.** Read path gates on `await mirror.ready()` per domain. Cold (never-completed init) → `faostat_query_observations` throws `index_not_ready` with a recovery hint to run the init or wait. Mid-refresh stays queryable (transactional).

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `FAOSTAT_BULK_BASE_URL` | no | Bulk service base. Default `https://bulks-faostat.fao.org/production`. |
| `FAOSTAT_DOMAINS` | no | Comma-separated domain codes to index. Default `QCL,TCL,FBS,FS,RL,GLE,RFN,QV`. |
| `FAOSTAT_MIRROR_PATH` | no | Directory holding the per-domain SQLite mirrors plus the shared dimension database. Default `./.faostat-mirror`. |
| `FAOSTAT_REFRESH_CRON` | no | Cron for incremental refresh (HTTP transport only). No default — unset disables the in-process refresh; `"0 6 * * *"` (daily off-peak) is the recommended value. |
| `CANVAS_PROVIDER_TYPE` | no | DataCanvas engine. `src/index.ts` defaults it to `duckdb`; `none` turns the SQL surface off, and the `dataframe_*` tools and observation spillover then report `canvas_disabled`. |
| `FAOSTAT_DATAFRAME_DROP_ENABLED` | no | `true` makes `faostat_dataframe_drop` callable. Default `false`: the tool is registered disabled (absent from `tools/list`, shown on the landing page with the enable hint), and the server `instructions` omit it. |

Server config lives in `src/config/server-config.ts` as a separate Zod schema (`parseEnvConfig`), never merged with core config. `CANVAS_PROVIDER_TYPE` is a core var (already in `AppConfig`); the rest are server-specific.

Peer deps to add: `@duckdb/node-api` (DataCanvas), and on Node deployments `better-sqlite3` (MirrorService — `bun:sqlite` is built-in on Bun). Mirror + canvas are both Node/Bun-only (no Workers build); this server does not target Workers.

## Implementation Order

1. **Config + server setup** — `server-config.ts` (domain list, paths, base URL), `createApp({ name: 'faostat-mcp-server', title: 'faostat-mcp-server', … })`, canvas accessor wired in `setup()`.
2. **Mirror service** — `defineMirror` + `sqliteMirrorStore` per domain, the bulk-ZIP `sync` ingester (manifest fetch → stream-parse code lists + data CSV), shared dimension tables, FTS index. `runSync` CLI scripts (`mirror:init`, `mirror:refresh`, `mirror:verify`); refresh cron in `setup()`.
3. **`faostat_list_domains`** — live manifest read + per-domain mirror status. (Independently testable against the manifest.)
4. **`faostat_resolve_codes`** — FTS5 / filter over dimension tables; country-vs-aggregate classification.
5. **`faostat_query_observations`** — mirror query with code/year filters + aggregate exclusion; spillover to canvas.
6. **`faostat_dataframe_describe` + `faostat_dataframe_query`** — canvas introspection + read-only SQL (mandatory pair for the spilled `canvas_id`).
7. **`faostat_commodity_profile`** — workflow composing `resolve_codes` + production/trade mirror queries.

Each step independently testable. Tools 3–5 can land before 6–7; the mirror (step 2) gates everything.

## Workflow Analysis

`faostat_commodity_profile` (multi-step, mirror-internal — no external calls per request once indexed):

| # | Operation | Source | Purpose |
|:--|:----------|:-------|:--------|
| 1 | Resolve `item_query` → item code(s) | dimension FTS | "maize" → item 56 |
| 2 | Top producers | `QCL` mirror table, element=Production, `SUM(value)` GROUP BY `(area_code, unit)` at each group's own `MAX(year)`, ORDER BY the sum | Ranked producer list (countries only, aggregates excluded) |
| 3 | Annual trend | `QCL`, every matching area, `SUM(value)` GROUP BY `(year, unit)` over all years in range | Year/value series inlined in the response |
| 4 | Trade flows | `TCL` mirror table, Import/Export quantity, same per-area aggregation as step 2 | Top importers/exporters |
| 5 | Stage full set on canvas | `spillover()` → canvas table | Escape hatch for `faostat_dataframe_query` |

Design questions the table surfaces: the profile runs 4 mirror aggregations (production rank, trend, export rank, import rank) and merges them; it inlines a compact summary (top-N + the annual trend) and spills the row-level union to one canvas table so the agent can drill in. Steps 2–4 aggregate in SQL over the complete filtered match rather than over a row-oriented page, so a ranking is bounded by neither the staging cap nor the read path's `ORDER BY year ASC` ordering. An aggregate cannot use a `LIMIT` to bound its own input the way a row fetch can, so these are the queries most exposed to a bad index choice — they are the reason the cube's query-planner statistics (above) are maintained rather than left to chance. No elicit (read-only, idempotent). If the trade domain (`TCL`) isn't indexed, the profile returns a production-only result with a `notice` naming the gap rather than failing — production without trade is still useful. Production is the backbone: an unselected `QCL` fails with `domain_not_indexed`, a selected but cold one with `index_not_ready`.

**Ranking semantics.** Each `(area, unit)` group is taken at its *own* latest year with data, not at one global `MAX(year)` across every resolved item — otherwise a single fast-reporting country's newest year wipes every slower reporter out of the ranking. Within a country, an item whose series ends earlier is left out of that country's latest-year sum rather than contributed at its own last value: summing across vintages inside one row would silently mix years behind a single number. Grouping by `unit` alongside `area_code` keeps tonnes and head counts from being added together; with a single unit — the ordinary case — it degenerates to one row per country.

## Design Decisions

**Data path — bulk CSV, not REST (verified 2026-06-13).** Every `faostatservices.fao.org/api/v1/` endpoint (`/data`, `/domains`, `/definitions`, `/codes`, `/dimensions`) returns `HTTP 401 "Missing Authorization Header"` keyless, with default and browser UA; the legacy `fenixservices` host times out. The bulk service (`bulks-faostat.fao.org/production/datasets_E.json` + per-domain ZIPs) is HTTP 200, keyless, and machine-readable (68 datasets with size, row count, update date, and exact ZIP URL). Each ZIP bundles the data CSV **and its dimension code lists**, so the bulk path supplies both the cube and the vocabularies — no API needed. Full probe log: `docs/data-source-verification.md`. **Decision: build entirely on the bulk service; do not implement a REST client.** If FAO restores keyless REST later, it could back a live fallback for un-indexed domains — noted, not built.

**Storage backend — MirrorService (embedded SQLite + FTS5).** Corpus sizing decides the tier per the framework's guidance (in-memory ≲10⁴; MirrorService 10⁴–10⁷; external ≳10⁸). The full corpus is ~170M rows / 1.48 GB compressed, but it's skewed: trade matrices dominate (`TM` 52M, `TCL` 17M) while the core analytical domains are 10⁴–10⁷ each (`QCL` 4.2M, `FBS` 4.8M, `GLE` 6.7M, `RL` 0.41M). In-memory is wrong (4.2M QCL rows won't fit comfortably and vanish on restart); an external store is overkill for a single-process public-data server. MirrorService gives durable, cross-session, FTS-indexed local query with a self-refresh state machine — exactly the "mirror a bulk upstream instead of paginating it live" pattern. `TM` (52M) is deferred from the default set on size; it can be opted in via `FAOSTAT_DOMAINS` where the deployment has the disk/RAM.

`TCL` (17.3M rows, 271 MB compressed) slightly exceeds the 10⁷ guide — it is included in the default set because it shares the standard normalized cube schema, SQLite handles it well with the declared `(item_code, element_code, year)` indexes, and dropping it eliminates trade flows from the default commodity profile workflow. Deployments constrained on RAM or startup time can remove it from `FAOSTAT_DOMAINS`; the design's `domain_not_indexed` error path surfaces the gap clearly.

**DataCanvas — yes (both gates pass).** (1) *Analytical, not just large:* the workload is `SELECT element, area, year, SUM/AVG(value) … GROUP BY …` — cross-country comparison, multi-decade trends, producer rankings. An agent absolutely writes `GROUP BY` against this. (2) *Too big to inline:* a single area×item×element×year slice across 245 countries × 60+ years easily exceeds any context budget. So `faostat_query_observations` and `faostat_commodity_profile` inline a preview and spill the full set to a canvas table, and — per the framework's hard rule — the `canvas_id` is paired with `faostat_dataframe_query` (+ `faostat_dataframe_describe`) in the same surface. Without the query pair the token is dead output. The canvas carries only the *row-level* set: `faostat_commodity_profile`'s own pre-aggregated summaries — the top-N rankings and the per-year trend — are bounded by `top_n` and the domain's year span, so they inline unconditionally rather than depending on a canvas the deployment may have turned off. Mirror and canvas coexist with distinct lifecycles: **mirror** = durable, cross-session, refreshed on a schedule (the corpus); **canvas** = ephemeral, per-session, the agent's working slice spilled from a query. The staged table schema is **explicit**, not inferred: the codes and `year` are `BIGINT`, the labels, `unit`, and `flag` are `VARCHAR`, `value` is `DOUBLE`, and profile tables add `domain` (`VARCHAR`). Inference would type each column from the rows already buffered for the inline preview, and rows stream oldest year first — a series whose early years are whole numbers would stage `value` as `BIGINT`, and DuckDB's appender would silently truncate every later fractional value.

**Why mirror *and* canvas, not canvas alone.** Canvas is per-session and in-memory — staging 4.2M QCL rows into a canvas on every cold session would re-download and re-parse a 33 MB ZIP each time. The mirror holds the corpus once, durably; the canvas holds only the *result* of a filtered query the agent wants to SQL further. The mirror answers "give me wheat production for India, 2000–2022" directly (indexed lookup); the canvas answers "now let me regroup and rank what came back" without another upstream hit.

**Code resolution as a dedicated tool, not a resource.** `idea.md` sketched `faostat_list_codes`; the truer verb is **resolve** (name → opaque integer is the dominant operation), though it also lists and filters. It's a tool (tool-only clients must reach it), backed by FTS5 over the bundled code lists in the mirror. It carries the country-vs-aggregate classification so the agent can avoid double-counting — the area-code duality is a correctness hazard, not a cosmetic detail.

**Aggregate exclusion default.** `faostat_query_observations` defaults `include_aggregates: false`. FAOSTAT puts World/continents/economic-groupings in the same `area` dimension as countries (codes ≥5000). A naive `SUM(value)` over an unfiltered result double-counts (World + every country). Safer default; the agent opts into aggregates explicitly when it wants the regional roll-up, which surfaces intent.

**Surface kept tight (7 tools, one opt-in).** A standalone `faostat_get_sync_status` tool was considered and folded into `faostat_list_domains` (per-domain `indexed` / `row_count` / `last_update` fields) — one tool answers both "what exists" and "what's queryable." `TM`-specific tooling, prices, and population domains are reachable via the generic cube tools once indexed; no per-domain tools.

## Error Contracts (per tool)

Domain failure modes to declare as typed contracts (`errors: [{ reason, code, when, recovery, retryable? }]`); baseline codes (`ServiceUnavailable`, `Timeout`, `ValidationError`, `InternalError`) bubble without declaration.

| Tool | reason | code | when | recovery |
|:-----|:-------|:-----|:-----|:---------|
| `faostat_list_domains` | — | — | (manifest fetch failures bubble status-mapped: a 403/404 fails on the first request as `Forbidden`/`NotFound`; 408/425/429/5xx other than 501 retry, then bubble as `Timeout`/`RateLimited`/`ServiceUnavailable`) | A failure that is not retried carries a hint to check `FAOSTAT_BULK_BASE_URL`. |
| `faostat_resolve_codes` | `unknown_domain` | `InvalidParams` | domain code not in the selected (indexed) set | Call faostat_list_domains to see valid, indexed domain codes. |
| | `index_not_ready` | `ServiceUnavailable` | dimension tables not yet populated (mirror cold) | Wait for the initial sync to finish or run the mirror init script; retry shortly. (retryable) |
| | `query_timeout` | `Timeout` | the item or element lookup's mirror read — queue wait plus execution — ran past the 45 s per-call ceiling | Retry in a few seconds — the lookup itself is fast; it waited behind slower reads from other calls. (retryable) |
| `faostat_query_observations` | `domain_not_indexed` | `NotFound` | domain is not in the local mirror's selected set, whether a valid FAOSTAT code or not | Pick an indexed domain (see faostat_list_domains indexed flag) or add it to FAOSTAT_DOMAINS and re-sync. |
| | `index_not_ready` | `ServiceUnavailable` | mirror cold — initial sync never completed | Wait for the initial sync to finish, or run the mirror init script; retry shortly. (retryable) |
| | `canvas_disabled` | `ServiceUnavailable` | result spilled but DataCanvas is off | Set CANVAS_PROVIDER_TYPE=duckdb to enable SQL on large result sets. |
| | `canvas_not_found` | `NotFound` | the result is large enough to stage and `canvas_id` does not resolve (unknown, expired, or another tenant's); a result that fits inline stages nothing and never consults it | Omit canvas_id to stage onto this session's canvas, or pass one returned within the 2-hour table TTL. |
| | `invalid_year_range` | `InvalidParams` | `year_start` is greater than `year_end` — a self-contradictory range that can never match | Pass year_start ≤ year_end, or omit one bound to leave that side of the range open. |
| | `query_timeout` | `Timeout` | the call's mirror reads — queue wait plus execution — ran past the 45 s per-call ceiling | Retry, or narrow the query with item_codes, element_codes, or a tighter year range so it reads fewer rows. (retryable) |
| `faostat_commodity_profile` | `no_match` | `NotFound` | item query resolved to nothing | Try faostat_resolve_codes with dimension=item to find the commodity code. |
| | `domain_not_indexed` | `NotFound` | the production domain (`QCL`) is not in the local mirror selection (`FAOSTAT_DOMAINS`) | This deployment's mirror must include the production domain: add QCL to FAOSTAT_DOMAINS and re-sync. Until then, faostat_query_observations answers on any indexed domain. |
| | `index_not_ready` | `ServiceUnavailable` | `QCL` is selected, but its mirror has never completed its initial sync | Wait for the initial sync to finish, or run the mirror init script; retry shortly. (retryable) |
| | `invalid_year_range` | `InvalidParams` | `year_start` is greater than `year_end`; the bounds reach the production, trade, and merged canvas-stream queries alike | Pass year_start ≤ year_end, or omit one bound to leave that side of the range open. |
| | `canvas_not_found` | `NotFound` | DataCanvas is enabled and `canvas_id` does not resolve (unknown, expired, or another tenant's) | Omit canvas_id to stage onto this session's canvas, or pass one returned within the 2-hour table TTL. |
| | `query_timeout` | `Timeout` | the profile's mirror reads (commodity resolution, rankings, trend, staging stream) — queue wait plus execution — ran past the 45 s per-call ceiling | Retry, or bound the profile with year_start/year_end or a more specific item_query so it reads fewer rows. (retryable) |
| `faostat_dataframe_query` | `canvas_disabled` | `ServiceUnavailable` | DataCanvas is not configured | Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable SQL on staged results. |
| | `canvas_not_found` | `NotFound` | an explicit `canvas_id` does not resolve (unknown, expired, or another tenant's) | Verify the canvas_id was returned by a prior faostat_query_observations / faostat_commodity_profile call, or omit canvas_id to fall back to the shared session canvas. |
| | `missing_table` | `NotFound` | the SQL references a `faostat_<id>` table that has expired or was never staged | Call faostat_dataframe_describe to list staged tables, or re-run the query that staged the data. |
| | `system_catalog_access` | `ValidationError` | the SQL references a denied system catalog (`information_schema`, `sqlite_master`, `duckdb_*`) | Query only faostat_<id> tables. Use faostat_dataframe_describe to list them. |
| | `invalid_sql` | `ValidationError` | a syntax or execution error, or anything but a single read-only SELECT | Use one read-only SELECT and verify column/table names against faostat_dataframe_describe. |
| `faostat_dataframe_describe` | `canvas_disabled` | `ServiceUnavailable` | DataCanvas is not configured | Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable staged tables. |
| | `canvas_not_found` | `NotFound` | an explicit `canvas_id` does not resolve (unknown, expired, or another tenant's) | Verify the canvas_id was returned by a prior faostat_query_observations / faostat_commodity_profile call, or omit canvas_id to fall back to the shared session canvas. |
| | `missing_table` | `NotFound` | a `name` filter matches no staged table on the resolved canvas | Call faostat_dataframe_describe without name to list all staged tables, or re-run the query that staged the data. |
| `faostat_dataframe_drop` | `canvas_disabled` | `ServiceUnavailable` | DataCanvas is not configured | Staged tables are off in this deployment, so nothing is staged to drop; set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable them. |
| | `canvas_not_found` | `NotFound` | an explicit `canvas_id` does not resolve (unknown, expired, or another tenant's) | Verify the canvas_id was returned by a prior faostat_query_observations / faostat_commodity_profile call, or omit canvas_id to fall back to the shared session canvas. |

Output schemas surface `canvas_id`, `table_name`, `spilled`, and a `preview` on the analytical tools (the agent's next action is SQL); `resolve_codes` returns `{ code, name, kind: 'country'|'aggregate'|null, cpc_code? }` per match plus truncation disclosure via `ctx.enrich.truncated`; `list_domains` returns a code-sorted page of the catalog with `indexed`/`row_count`/`last_update`, plus `totalCount` (whole catalog), `totalMatches` (the filtered set), and `truncated`/`nextOffset` so a capped page names its own continuation. Empty-result notices and query echoes go through `ctx.enrich` so they reach both client surfaces.

## Known Limitations

- **Mirror freshness lags FAO.** Data is as fresh as the last successful sync (`DateUpdate` per domain, surfaced in `list_domains`). FAOSTAT updates domains a few times a year, so a daily refresh is far more than enough — but a query reflects the mirror, not a live read.
- **Indexed subset.** Only domains in `FAOSTAT_DOMAINS` are queryable; `list_domains` shows the full catalog so the gap is visible. Expanding the set requires a re-sync (and disk/RAM for large domains like `TM`).
- **No sub-national data.** FAOSTAT is country-level (plus regional aggregates); no province/state granularity. For US sub-national, compose with `usda-mcp-server`; for EU, `eurostat-mcp-server`.
- **Imputed/estimated values.** A meaningful share of cells are flagged `E`/`I` (estimated/imputed). Flags are carried on every row; downstream rigor depends on the agent honoring them.
- **Workers-incompatible.** MirrorService (SQLite) and DataCanvas (DuckDB) are both native; this server runs on Node/Bun only.
- **Node exit waits for a running statement.** Neither SQLite driver can interrupt a statement once it starts. Under Node (the npm bin and the `.mcpb` bundle), process exit waits for any statement a read worker is still running, such as a read cut off at the ceiling or an in-flight statistics build. Under Bun (the Docker image), the process exits at once.

## API Reference

- **Manifest:** `GET {FAOSTAT_BULK_BASE_URL}/datasets_E.json` → `{ Datasets: { "-xmlns:xsi": "…", Dataset: [{ DatasetCode, DatasetName, Topic, DatasetDescription, Contact, Email, DateUpdate, CompressionFormat, FileType, FileSize, FileRows, FileLocation }] } }`. Lowercase filename is canonical (capitalized variant → 403). The `"-xmlns:xsi"` sibling key in `Datasets` is an XML-to-JSON artifact — access `d.Datasets.Dataset` directly; the key name contains a `-` so object-spread patterns skip it safely. `FileSize` is a string with units (`"33127KB"`, not a number). All 12 per-dataset fields listed above are present on every entry.
- **Domain ZIP:** `FileLocation` URL, e.g. `…/Production_Crops_Livestock_E_All_Data_(Normalized).zip`. `accept-ranges: bytes`, `last-modified` present. Bundles: `<Name>_E_All_Data_(Normalized).csv` (data) + `<Name>_E_AreaCodes.csv`, `<Name>_E_ItemCodes.csv`, `<Name>_E_Elements.csv`, `<Name>_E_Flags.csv` (dimension code lists). Survey-shaped domains bundle different dimension files (e.g. `_Surveys.csv`, `_Indicators.csv`).
- **Normalized data CSV columns (standard cube):** `Area Code, Area Code (M49), Area, Item Code, Item, Element Code, Element, Year Code, Year, Unit, Value, Flag, Note` (13 columns). `Year Code` duplicates `Year` for calendar-year domains (both `"1974"`); store only `Year` as `INTEGER` in the mirror. `Area Code (M49)` carries a leading apostrophe (`'004` for Afghanistan) — strip it when normalizing to the M49 numeric form. `Note` is frequently empty.
- **AreaCodes CSV:** `Area Code, M49 Code, Area` (note: space after comma in header — parse as CSV, not by char position). 243 individual-country codes (2–351), 68 aggregate-region codes (≥5000). World=5000, Africa=5100, continents `51xx`–`56xx`, economic groupings, plus excluded-intra-trade variants with a trailing-zero code (`51000` = "Africa (excluding intra-trade)"). The aggregate boundary is exactly ≥5000 — no country code reaches 5000 (largest confirmed: China=351).
- **Flags CSV:** `Flag, Description`. `A` Official figure · `B` Time-series break · `E` Estimated value · `I` Imputed by receiving agency · `X` External-org figure (full set in each domain's `_Flags.csv` — parse it at sync time; don't hardcode).
- **ItemCodes CSV:** `Item Code, CPC Code, Item`. `CPC Code` carries a `'` prefix (e.g. `'F3102`) — strip the apostrophe if storing raw CPC for crosswalks.
- **Elements CSV:** `Element Code, Element` (two columns only).
- **Compression ratio ~18×.** Stream-parse from the ZIP; never decompress the full CSV to memory.
