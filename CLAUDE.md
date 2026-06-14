# Developer Protocol

**Server:** faostat-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.6`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Add tools** — scaffold new definitions using the `add-tool` / `add-app-tool` skills
2. **Add a domain to the mirror** — extend `FAOSTAT_DOMAINS`, then re-sync (`bun run mirror:refresh`) so `faostat_query_observations` can read it
3. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
4. **Field-test definitions** — exercise tools with real inputs using the `field-test` skill, get a report of issues and pain points
5. **Run `devcheck`** — lint, format, typecheck, and security audit
6. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
7. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
8. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use the typed `errors[]` contract + `ctx.fail()` (or factories like `notFound()`) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls (the mirror CLI scripts are the lone exception — they print progress to stdout outside a request).
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly. The canvas staging layer resolves the session canvas from `ctx.state`.
- **Secrets in env vars only** — never hardcoded. (This server is keyless; there are no secrets to manage.)
- **Carry the data-quality flag through.** Every FAOSTAT observation has a flag (`A`/`E`/`I`/`B`/`X`). Never drop it from output or `format()` — it's load-bearing for downstream rigor.
- **Aggregate exclusion is the safe default.** `faostat_query_observations` excludes area codes ≥ 5000 (World/continents/groupings) unless `include_aggregates: true`, so a naive `SUM` doesn't double-count. Preserve this.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

This server is **tools-only** — six tools, no resources, no prompts (the data behind every resource candidate is already reachable through the tools, and the one workflow worth structuring ships as `faostat_commodity_profile`). All definitions live in `src/mcp-server/tools/definitions/`.

### Tool

Real definitions: `list-domains`, `resolve-codes`, `query-observations`, `commodity-profile`, `dataframe-query`, `dataframe-describe`. The shape below — typed `errors[]` contract, `ctx.fail()`, `ctx.enrich`, and a `format()` that renders every field — is shared across them.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';

export const resolveCodesTool = tool('faostat_resolve_codes', {
  title: 'faostat-mcp-server: resolve codes',
  description: 'Resolve human terms to the opaque integer codes a query needs …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  // enrichment fields reach BOTH client surfaces via ctx.enrich (provenance,
  // truncation disclosure, empty-result guidance) — separate from output.
  enrichment: {
    totalMatches: z.number().describe('Total matches before the result cap.'),
    truncated: z.boolean().describe('True when matches were capped at the limit.'),
    notice: z.string().optional().describe('Guidance when nothing matched.'),
  },

  // Typed error contract — ctx.fail(reason, …) is checked against this union at
  // compile time; the linter enforces conformance; data.reason is auto-populated.
  errors: [
    { reason: 'unknown_domain', code: JsonRpcErrorCode.InvalidParams,
      when: 'The domain code is not a selected (indexed) FAOSTAT domain.',
      recovery: 'Call faostat_list_domains to see valid, indexed domain codes.' },
    { reason: 'index_not_ready', code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The dimension tables are not yet populated (mirror cold).', retryable: true,
      recovery: 'Run the mirror init script or wait for the initial sync, then retry.' },
  ],

  input: z.object({
    domain: z.string().min(1).describe('FAOSTAT domain code (e.g. "QCL").'),
    dimension: z.enum(['area', 'item', 'element']).describe('Which dimension to resolve.'),
    query: z.string().optional().describe('FTS5 search term ("wheat", "import quantity").'),
  }),
  output: z.object({ /* domain, dimension, matches[] with kind: country|aggregate */ }),

  async handler(input, ctx) {
    const mirror = getFaostatMirror();
    if (!mirror.isSelected(input.domain)) {
      throw ctx.fail('unknown_domain', `Domain "${input.domain}" is not indexed.`,
        ctx.recoveryFor('unknown_domain'));
    }
    const { matches, total } = await mirror.resolve(input.dimension, { /* … */ });
    ctx.enrich({ totalMatches: total, truncated: total > matches.length });
    return { domain: input.domain.toUpperCase(), dimension: input.dimension, matches };
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data, the flag included.
  format: (result) => [{ type: 'text', text: /* render every match + its kind */ }],
});
```

### Analytical tools — DataCanvas staging

`faostat_query_observations` and `faostat_commodity_profile` inline a small preview and **spill** large result sets to a DuckDB-backed canvas table via the staging helpers in `src/services/canvas-staging.ts`. The returned `canvas_id` + `table_name` are then queried by the mandatory `faostat_dataframe_query` / `faostat_dataframe_describe` pair — without that pair the spilled token is dead output. Guard with `canvasEnabled()` and surface `canvas_disabled` when staging is off.

```ts
import { canvasEnabled, stageObservations } from '@/services/canvas-staging.js';

if (shouldSpill && !canvasEnabled()) {
  throw ctx.fail('canvas_disabled', `Result has ${total} rows — too large to inline.`,
    ctx.recoveryFor('canvas_disabled'));
}
const staged = await stageObservations(ctx, mirror.streamObservations(code, filters), {
  sourceTool: 'faostat_query_observations',
  queryParams: { domain: code, /* … */ },
});
// staged.spilled, staged.canvasId, staged.tableName, staged.previewRows
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const DEFAULT_DOMAINS = 'QCL,TCL,FBS,FS,RL,GLE,RFN,QV';

const ServerConfigSchema = z.object({
  bulkBaseUrl: z.string().url().default('https://bulks-faostat.fao.org/production')
    .describe('FAOSTAT bulk-download service base URL (manifest + per-domain ZIPs).'),
  domains: z.string().default(DEFAULT_DOMAINS)
    .describe('Comma-separated FAOSTAT domain codes to index into the local mirror.'),
  mirrorPath: z.string().default('./.faostat-mirror')
    .describe('Directory holding the per-domain SQLite mirrors + shared dimension DB.'),
  refreshCron: z.string().optional()
    .describe('Cron for the in-process incremental refresh (HTTP transport only).'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    bulkBaseUrl: 'FAOSTAT_BULK_BASE_URL',
    domains: 'FAOSTAT_DOMAINS',
    mirrorPath: 'FAOSTAT_MIRROR_PATH',
    refreshCron: 'FAOSTAT_REFRESH_CRON',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`FAOSTAT_DOMAINS`) not the path (`domains`). Throws `ConfigurationError`, which the framework prints as a clean startup banner. `CANVAS_PROVIDER_TYPE` is a core var (already in `AppConfig`), not part of this schema; `src/index.ts` defaults it to `duckdb`.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
// src/index.ts — name + title are the machine name on every surface (never Title Case).
// description is NOT set here — it derives from package.json (the canonical source).
await createApp({
  name: 'faostat-mcp-server',
  title: 'faostat-mcp-server',
  tools: [listDomainsTool, resolveCodesTool, queryObservationsTool,
          commodityProfileTool, dataframeQueryTool, dataframeDescribeTool],
  instructions: 'Global food & agriculture statistics from the UN FAOSTAT … Workflow: ' +
    'faostat_list_domains → faostat_resolve_codes → faostat_query_observations …',
  setup(core) { /* wire canvas + mirror, schedule HTTP refresh */ },
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context — here it carries the discover → resolve → query workflow, the aggregate-exclusion default, the canvas spillover path, and the data-quality-flag reminder, so the guidance isn't duplicated across every tool description. The canonical in-code identity block is `name` + `title` only — never duplicate `description` into `createApp()` (it derives from `package.json`).

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, …)`. The canvas staging layer resolves the session canvas from here. |
| `ctx.enrich` | Attach enrichment fields (declared in `enrichment`) to both client surfaces — `ctx.enrich({ … })`, plus `.total(n)` and `.notice(msg)` shorthands for the common count/guidance fields. |
| `ctx.fail` | Throw a typed contract error — `ctx.fail(reason, message, recovery?)`, with `reason` checked against the tool's `errors[]` union. Pair with `ctx.recoveryFor(reason)`. |
| `ctx.signal` | `AbortSignal` for cancellation — threaded into manifest/ZIP fetches. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

`ctx.elicit` and `ctx.progress` aren't used — every tool is read-only and non-interactive.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() — registers tools, wires mirror+canvas in setup()
  config/
    server-config.ts                    # Server-specific env vars (Zod schema, parseEnvConfig)
  services/
    canvas-accessor.ts                  # Module-level getCanvas()/setCanvas() (core.canvas, wired in setup())
    canvas-staging.ts                   # spill / query / describe staging over the DataCanvas
    faostat-mirror/
      index.ts                          # initFaostatMirror() / getFaostatMirror() accessor + barrel
      faostat-mirror.ts                 # FaostatMirror — per-domain MirrorService + dimension store
      ingester.ts                       # Streaming bulk-ZIP → SQLite ingester
      manifest.ts                       # Bulk manifest fetch/parse (datasets_E.json)
      csv.ts, dimensions-store.ts, http.ts, types.ts
  mcp-server/
    tools/definitions/
      list-domains.tool.ts  resolve-codes.tool.ts  query-observations.tool.ts
      commodity-profile.tool.ts  dataframe-query.tool.ts  dataframe-describe.tool.ts
scripts/
  faostat-mirror-init.ts  faostat-mirror-refresh.ts  faostat-mirror-verify.ts  _mirror-context.ts
```

No `resources/` or `prompts/` definitions — this server is tools-only.

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `query-observations.tool.ts` |
| Tool names | snake_case, `faostat_` prefix | `faostat_query_observations` |
| Tool `title` | `faostat-mcp-server: <human label>` (machine name, never Title Case) | `faostat-mcp-server: query observations` |
| Directories | kebab-case | `src/services/faostat-mirror/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Query a FAOSTAT domain's data cube by area, item, element, year.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService: persistent local SQLite + FTS5 mirror of a bulk upstream dataset (`defineMirror` / `sqliteMirrorStore`) — the FAOSTAT data path |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `npm run build` | Compile TypeScript |
| `npm run rebuild` | Clean + build |
| `npm run clean` | Remove build artifacts |
| `npm run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `npm run tree` | Generate directory structure doc |
| `npm run format` | Auto-fix formatting (safe fixes only) |
| `npm run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `npm test` | Run tests |
| `npm run start:stdio` | Production mode (stdio) |
| `npm run start:http` | Production mode (HTTP) |
| `bun run mirror:init` | One-time bootstrap — download and index the `FAOSTAT_DOMAINS` set into the local mirror. Idempotent, resumable per domain. Required before the data tools answer queries. |
| `bun run mirror:refresh` | Re-sync domains whose upstream `DateUpdate` has advanced (skips unchanged). Run out-of-band on stdio; HTTP transport schedules it via `FAOSTAT_REFRESH_CRON`. |
| `bun run mirror:verify` | Report per-domain sync status, local row counts, and sample reads against the mirror. |
| `npm run lint:mcp` | Validate MCP tool definitions against the spec (format-parity, schema shape, naming). |
| `npm run lint:packaging` | Validate `manifest.json` ↔ `server.json` env-var consistency (run by devcheck). |
| `npm run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `npm run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `npm run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs (`node_modules/**` `skills/`, `.claude/`, `.agents/`, `SKILL.md`) that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias (resolves to ./src/*; ./dist/* in the Docker image)
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';
import { canvasEnabled, stageObservations } from '@/services/canvas-staging.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] FAOSTAT observations: the data-quality `flag` is carried through `output` and `format()` — never dropped
- [ ] `faostat_query_observations` keeps aggregate exclusion as the default (codes ≥ 5000 excluded unless `include_aggregates: true`)
- [ ] Query-path tools tested against a built mirror (`bun run mirror:init`) — the read tools surface `index_not_ready` until the first sync completes
- [ ] Registered in the `createApp()` `tools` array in `src/index.ts`
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` server name key matches `package.json` name (no API keys — FAOSTAT is keyless)
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with the server name key
- [ ] `npm run devcheck` passes
