# faostat-mcp-server — Design

Global food and agriculture statistics from the UN's [FAOSTAT](https://www.fao.org/faostat/) — crop and livestock production, agricultural trade, food balances, food security, land use, fertilizer/pesticide use, and agri-emissions, for 245+ countries from 1961 to present.

Data path: FAOSTAT's keyless **bulk-download service** (per-domain zipped normalized CSVs), synced into a persistent local **MirrorService** (embedded SQLite + FTS5) and queried locally. The public REST query API requires authorization (401 keyless — see [Design Decisions](#design-decisions)), so the mirror is the data path, not an optimization. Analytical query results spill to a **DataCanvas** for ad-hoc SQL.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `faostat_list_domains` | Discover FAOSTAT statistical domains (production, trade, food balances, food security, land use, emissions, prices, population) with codes, descriptions, last-update date, row count, and local index status. Entry point — every query keys on a domain code. | `topic?` (filter), `indexed_only?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `faostat_resolve_codes` | Resolve human terms to the opaque codes a query needs, within a domain: areas (countries/regions), items (commodities), elements (metrics). "wheat" → item 15; "production" → element 5510. FAOSTAT is unqueryable without code resolution. Flags whether an area code is an individual country or an aggregate region. | `domain`, `dimension` (`area`\|`item`\|`element`), `query?`, `name_contains?`, `code?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `faostat_query_observations` | Query a domain's data cube by area(s), item(s), element(s), and year range. Returns observations (area, item, element, year, value, unit, data-quality flag). Inline preview for small results; large result sets spill to a DataCanvas table for SQL aggregation via `faostat_dataframe_query`. | `domain`, `area_codes?`, `item_codes?`, `element_codes?`, `year_start?`, `year_end?`, `include_aggregates?`, `canvas_id?` | `readOnlyHint`, `openWorldHint:false` |
| `faostat_commodity_profile` | Workflow: assemble a global profile for one commodity — top producers, the multi-decade production trend, and trade flows (top importers/exporters) — from the production and trade domains in one call. Convenience over chaining `resolve_codes` + multiple `query_observations`. | `item_query`, `year_start?`, `year_end?`, `top_n?`, `canvas_id?` | `readOnlyHint`, `openWorldHint:false` |
| `faostat_dataframe_query` | Run a read-only SQL SELECT against tables staged on a DataCanvas by `faostat_query_observations` or `faostat_commodity_profile`. Use for cross-country/cross-item aggregation, grouping, joins, and time-series analysis over the full result set. | `canvas_id`, `sql` | `readOnlyHint`, `openWorldHint:false` |
| `faostat_dataframe_describe` | List DataCanvas tables and columns staged by a prior query call — each table's name, row count, and column schema. Call before `faostat_dataframe_query` to discover table/column names for SQL. | `canvas_id` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |

**Surface count: 6 tools.** No resources, no prompts (see below).

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
- **Analytical SQL surface.** Cube queries are inherently `GROUP BY country/item/year` analytical workloads → DataCanvas spillover + a mandatory `faostat_dataframe_query`/`dataframe_describe` pair.
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
| canvas accessor | `core.canvas` (DataCanvas, DuckDB) — module-level `getCanvas()` accessor wired in `setup()` | `query_observations`, `commodity_profile`, `dataframe_*` |

**Mirror service shape.** One `MirrorService` instance per indexed domain (each domain is its own table + FTS index over the dimension labels), plus shared dimension tables (`areas`, `items`, `elements`, `flags`) populated from the bundled code-list CSVs. The `sync` ingester:

1. Fetches the manifest (`datasets_E.json`); for each selected domain compares `DateUpdate` / `Last-Modified` against the stored checkpoint — skip unchanged domains.
2. Streams the domain ZIP, parses the bundled code-list CSVs into the shared dimension tables, then stream-parses the normalized data CSV → row objects keyed by the declared columns.
3. Yields pages of `{ records, checkpoint: DateUpdate }`. `checkpoint` is the domain's ISO `DateUpdate` (lexicographically monotonic); no intra-run `cursor` needed (a domain ZIP is one atomic unit — re-fetch on interrupt rather than resume mid-file).

**Schema (per-domain table):** `area_code INTEGER, area_m49 TEXT, area TEXT, item_code INTEGER, item TEXT, element_code INTEGER, element TEXT, year INTEGER, unit TEXT, value DOUBLE, flag TEXT, note TEXT`. Indexes on `(area_code)`, `(item_code)`, `(element_code)`, `(year)`. FTS5 over `area`, `item`, `element` (drives `resolve_codes`). The ingester maps columns off the **actual CSV header per domain** (not a hardcoded order) so a non-standard domain fails loudly rather than mis-mapping.

**Resilience.** `fetchWithTimeout` + `withRetry` from `/utils` wrap manifest and ZIP fetches (base delay ~1–2s, the service is occasionally slow/degraded); `httpErrorFromResponse` maps non-OK status. Parse failures on a malformed ZIP throw transient errors, not `SerializationError`, so a refresh retries.

**Readiness.** Read path gates on `await mirror.ready()` per domain. Cold (never-completed init) → `faostat_query_observations` throws `index_not_ready` with a recovery hint to run the init or wait. Mid-refresh stays queryable (transactional).

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `FAOSTAT_BULK_BASE_URL` | no | Bulk service base. Default `https://bulks-faostat.fao.org/production`. |
| `FAOSTAT_DOMAINS` | no | Comma-separated domain codes to index. Default `QCL,TCL,FBS,FS,RL,GLE,RFN,QV`. |
| `FAOSTAT_MIRROR_PATH` | no | SQLite mirror file path. Default `./.faostat-mirror/faostat.db`. |
| `FAOSTAT_REFRESH_CRON` | no | Cron for incremental refresh (HTTP transport only). Default daily off-peak. |
| `CANVAS_PROVIDER_TYPE` | yes (for analysis) | Set `duckdb` to enable the DataCanvas SQL surface. `dataframe_*` tools and observation spillover require it. |

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
| 2 | Top producers | `QCL` mirror table, element=Production, GROUP BY area ORDER BY value | Ranked producer list (countries only, aggregates excluded) |
| 3 | Multi-decade trend | `QCL`, the resolved top areas, all years in range | Time series for the chart/analysis |
| 4 | Trade flows | `TCL` mirror table, Import/Export quantity, top areas | Top importers/exporters |
| 5 | Stage full set on canvas | `spillover()` → canvas table | Escape hatch for `faostat_dataframe_query` |

Design questions the table surfaces: the profile runs 3 mirror queries (production rank, trend, trade) and merges them; it inlines a compact summary (top-N + headline trend) and spills the union to one canvas table so the agent can drill in. No elicit (read-only, idempotent). If a domain in the chain isn't indexed, the profile returns a partial result with a `notice` naming the missing domain rather than failing — production without trade is still useful.

## Design Decisions

**Data path — bulk CSV, not REST (verified 2026-06-13).** Every `faostatservices.fao.org/api/v1/` endpoint (`/data`, `/domains`, `/definitions`, `/codes`, `/dimensions`) returns `HTTP 401 "Missing Authorization Header"` keyless, with default and browser UA; the legacy `fenixservices` host times out. The bulk service (`bulks-faostat.fao.org/production/datasets_E.json` + per-domain ZIPs) is HTTP 200, keyless, and machine-readable (68 datasets with size, row count, update date, and exact ZIP URL). Each ZIP bundles the data CSV **and its dimension code lists**, so the bulk path supplies both the cube and the vocabularies — no API needed. Full probe log: `docs/data-source-verification.md`. **Decision: build entirely on the bulk service; do not implement a REST client.** If FAO restores keyless REST later, it could back a live fallback for un-indexed domains — noted, not built.

**Storage backend — MirrorService (embedded SQLite + FTS5).** Corpus sizing decides the tier per the framework's guidance (in-memory ≲10⁴; MirrorService 10⁴–10⁷; external ≳10⁸). The full corpus is ~170M rows / 1.48 GB compressed, but it's skewed: trade matrices dominate (`TM` 52M, `TCL` 17M) while the core analytical domains are 10⁴–10⁷ each (`QCL` 4.2M, `FBS` 4.8M, `GLE` 6.7M, `RL` 0.41M). In-memory is wrong (4.2M QCL rows won't fit comfortably and vanish on restart); an external store is overkill for a single-process public-data server. MirrorService gives durable, cross-session, FTS-indexed local query with a self-refresh state machine — exactly the "mirror a bulk upstream instead of paginating it live" pattern. `TM` (52M) is deferred from the default set on size; it can be opted in via `FAOSTAT_DOMAINS` where the deployment has the disk/RAM.

`TCL` (17.3M rows, 271 MB compressed) slightly exceeds the 10⁷ guide — it is included in the default set because it shares the standard normalized cube schema, SQLite handles it well with the declared `(item_code, element_code, year)` indexes, and dropping it eliminates trade flows from the default commodity profile workflow. Deployments constrained on RAM or startup time can remove it from `FAOSTAT_DOMAINS`; the design's `domain_not_indexed` error path surfaces the gap clearly.

**DataCanvas — yes (both gates pass).** (1) *Analytical, not just large:* the workload is `SELECT element, area, year, SUM/AVG(value) … GROUP BY …` — cross-country comparison, multi-decade trends, producer rankings. An agent absolutely writes `GROUP BY` against this. (2) *Too big to inline:* a single area×item×element×year slice across 245 countries × 60+ years easily exceeds any context budget. So `faostat_query_observations` and `faostat_commodity_profile` inline a preview and spill the full set to a canvas table, and — per the framework's hard rule — the `canvas_id` is paired with `faostat_dataframe_query` (+ `faostat_dataframe_describe`) in the same surface. Without the query pair the token is dead output. Mirror and canvas coexist with distinct lifecycles: **mirror** = durable, cross-session, refreshed on a schedule (the corpus); **canvas** = ephemeral, per-session, the agent's working slice spilled from a query.

**Why mirror *and* canvas, not canvas alone.** Canvas is per-session and in-memory — staging 4.2M QCL rows into a canvas on every cold session would re-download and re-parse a 33 MB ZIP each time. The mirror holds the corpus once, durably; the canvas holds only the *result* of a filtered query the agent wants to SQL further. The mirror answers "give me wheat production for India, 2000–2022" directly (indexed lookup); the canvas answers "now let me regroup and rank what came back" without another upstream hit.

**Code resolution as a dedicated tool, not a resource.** `idea.md` sketched `faostat_list_codes`; the truer verb is **resolve** (name → opaque integer is the dominant operation), though it also lists and filters. It's a tool (tool-only clients must reach it), backed by FTS5 over the bundled code lists in the mirror. It carries the country-vs-aggregate classification so the agent can avoid double-counting — the area-code duality is a correctness hazard, not a cosmetic detail.

**Aggregate exclusion default.** `faostat_query_observations` defaults `include_aggregates: false`. FAOSTAT puts World/continents/economic-groupings in the same `area` dimension as countries (codes ≥5000). A naive `SUM(value)` over an unfiltered result double-counts (World + every country). Safer default; the agent opts into aggregates explicitly when it wants the regional roll-up, which surfaces intent.

**Surface kept tight (6 tools).** A standalone `faostat_get_sync_status` tool was considered and folded into `faostat_list_domains` (per-domain `indexed` / `row_count` / `last_update` fields) — one tool answers both "what exists" and "what's queryable." `TM`-specific tooling, prices, and population domains are reachable via the generic cube tools once indexed; no per-domain tools.

## Error Contracts (per tool)

Domain failure modes to declare as typed contracts (`errors: [{ reason, code, when, recovery, retryable? }]`); baseline codes (`ServiceUnavailable`, `Timeout`, `ValidationError`, `InternalError`) bubble without declaration.

| Tool | reason | code | when | recovery |
|:-----|:-------|:-----|:-----|:---------|
| `faostat_list_domains` | — | — | (manifest fetch failures bubble as `ServiceUnavailable`) | — |
| `faostat_resolve_codes` | `unknown_domain` | `InvalidParams` | domain code not in catalog | Call faostat_list_domains to see valid domain codes. |
| | `index_not_ready` | `ServiceUnavailable` | dimension tables not yet populated (mirror cold) | Wait for the initial sync to finish or run the mirror init script; retry shortly. (retryable) |
| | `no_match` | `NotFound` | no code matched the query in this dimension | Broaden the query, check spelling, or omit query to list all codes in the dimension. |
| `faostat_query_observations` | `unknown_domain` | `InvalidParams` | domain code not in catalog | Call faostat_list_domains for valid codes. |
| | `domain_not_indexed` | `NotFound` | domain is in catalog but not in the local mirror's selected set | Pick an indexed domain (see faostat_list_domains indexed flag) or add it to FAOSTAT_DOMAINS and re-sync. |
| | `index_not_ready` | `ServiceUnavailable` | mirror cold — initial sync never completed | Wait for the initial sync to finish, or run the mirror init script; retry shortly. (retryable) |
| | `empty_result` | `NotFound` | filters valid but no observation matched | Widen the year range, relax filters, or verify codes with faostat_resolve_codes. |
| | `canvas_disabled` | `ServiceUnavailable` | result spilled but DataCanvas is off | Set CANVAS_PROVIDER_TYPE=duckdb to enable SQL on large result sets. |
| `faostat_commodity_profile` | `no_match` | `NotFound` | item query resolved to nothing | Try faostat_resolve_codes with dimension=item to find the commodity code. |
| | `index_not_ready` | `ServiceUnavailable` | required domain mirror cold | Wait for sync or run the init script; retry shortly. (retryable) |
| `faostat_dataframe_query` | `missing_table` | `NotFound` | canvas table expired/dropped/mistyped | Re-run the query that staged the data, or call faostat_dataframe_describe to list live tables. |
| | (read-only SQL violations) | `ValidationError` | non-SELECT or file-reading SQL | Use a single read-only SELECT against staged tables. |

Output schemas surface `canvas_id`, `table_name`, `spilled`, and a `preview` on the analytical tools (the agent's next action is SQL); `resolve_codes` returns `{ code, name, kind: 'country'|'aggregate'|null, cpc_code? }` per match plus truncation disclosure via `ctx.enrich.truncated`; `list_domains` returns the full catalog with `indexed`/`row_count`/`last_update`. Empty-result notices and query echoes go through `ctx.enrich` so they reach both client surfaces.

## Known Limitations

- **Mirror freshness lags FAO.** Data is as fresh as the last successful sync (`DateUpdate` per domain, surfaced in `list_domains`). FAOSTAT updates domains a few times a year, so a daily refresh is far more than enough — but a query reflects the mirror, not a live read.
- **Indexed subset.** Only domains in `FAOSTAT_DOMAINS` are queryable; `list_domains` shows the full catalog so the gap is visible. Expanding the set requires a re-sync (and disk/RAM for large domains like `TM`).
- **No sub-national data.** FAOSTAT is country-level (plus regional aggregates); no province/state granularity. For US sub-national, compose with `usda-mcp-server`; for EU, `eurostat-mcp-server`.
- **Imputed/estimated values.** A meaningful share of cells are flagged `E`/`I` (estimated/imputed). Flags are carried on every row; downstream rigor depends on the agent honoring them.
- **Workers-incompatible.** MirrorService (SQLite) and DataCanvas (DuckDB) are both native; this server runs on Node/Bun only.

## API Reference

- **Manifest:** `GET {FAOSTAT_BULK_BASE_URL}/datasets_E.json` → `{ Datasets: { "-xmlns:xsi": "…", Dataset: [{ DatasetCode, DatasetName, Topic, DatasetDescription, Contact, Email, DateUpdate, CompressionFormat, FileType, FileSize, FileRows, FileLocation }] } }`. Lowercase filename is canonical (capitalized variant → 403). The `"-xmlns:xsi"` sibling key in `Datasets` is an XML-to-JSON artifact — access `d.Datasets.Dataset` directly; the key name contains a `-` so object-spread patterns skip it safely. `FileSize` is a string with units (`"33127KB"`, not a number). All 12 per-dataset fields listed above are present on every entry.
- **Domain ZIP:** `FileLocation` URL, e.g. `…/Production_Crops_Livestock_E_All_Data_(Normalized).zip`. `accept-ranges: bytes`, `last-modified` present. Bundles: `<Name>_E_All_Data_(Normalized).csv` (data) + `<Name>_E_AreaCodes.csv`, `<Name>_E_ItemCodes.csv`, `<Name>_E_Elements.csv`, `<Name>_E_Flags.csv` (dimension code lists). Survey-shaped domains bundle different dimension files (e.g. `_Surveys.csv`, `_Indicators.csv`).
- **Normalized data CSV columns (standard cube):** `Area Code, Area Code (M49), Area, Item Code, Item, Element Code, Element, Year Code, Year, Unit, Value, Flag, Note` (13 columns). `Year Code` duplicates `Year` for calendar-year domains (both `"1974"`); store only `Year` as `INTEGER` in the mirror. `Area Code (M49)` carries a leading apostrophe (`'004` for Afghanistan) — strip it when normalizing to the M49 numeric form. `Note` is frequently empty.
- **AreaCodes CSV:** `Area Code, M49 Code, Area` (note: space after comma in header — parse as CSV, not by char position). 243 individual-country codes (2–351), 68 aggregate-region codes (≥5000). World=5000, Africa=5100, continents `51xx`–`56xx`, economic groupings, plus excluded-intra-trade variants with a trailing-zero code (`51000` = "Africa (excluding intra-trade)"). The aggregate boundary is exactly ≥5000 — no country code reaches 5000 (largest confirmed: China=351).
- **Flags CSV:** `Flag, Description`. `A` Official figure · `B` Time-series break · `E` Estimated value · `I` Imputed by receiving agency · `X` External-org figure (full set in each domain's `_Flags.csv` — parse it at sync time; don't hardcode).
- **ItemCodes CSV:** `Item Code, CPC Code, Item`. `CPC Code` carries a `'` prefix (e.g. `'F3102`) — strip the apostrophe if storing raw CPC for crosswalks.
- **Elements CSV:** `Element Code, Element` (two columns only).
- **Compression ratio ~18×.** Stream-parse from the ZIP; never decompress the full CSV to memory.
