/**
 * @fileoverview `faostat_dataframe_describe` provenance parity (#13) and resolved
 * column types (#15). Three defects shared the same tool:
 *
 * 1. Undefined-valued `query_params` keys diverged across surfaces —
 *    `structuredContent` drops them on JSON serialization while `content[]`
 *    rendered them literally as `key=undefined`. The fix strips undefined keys at
 *    the `stageObservations` write site, so both surfaces read one clean object.
 * 2. A name-filtered miss returned the unqualified `content[]` text "No active
 *    staged tables" even with other tables active. The fix throws a typed
 *    `missing_table` (NotFound) from the handler instead.
 * 3. `column_schema` reported every column as `VARCHAR` — `stageObservations`
 *    synthesized the type from the spill handle, which carries names only. The fix
 *    reads the resolved schema back from the canvas after the spill, so the
 *    reported contract matches what DuckDB registered — `value` DOUBLE included,
 *    since the staged schema is declared rather than inferred from the preview (#30).
 *
 * `faostat_commodity_profile` provenance records the caller's input names —
 * `year_start` / `year_end`, present only when supplied — not the internal
 * camelCase filter names (#32).
 *
 * Drives the real end-to-end path: a real domain sync into a temp SQLite mirror +
 * a real DuckDB canvas, staged via the tools, then described.
 * @module tests/tools/dataframe-describe-provenance
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { OBSERVATION_TABLE_SCHEMA, stageObservations } from '@/services/canvas-staging.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

let canvas: DataCanvas;

/**
 * A mock context carrying both contracts — every test here stages through
 * `faostat_query_observations` and reads back through
 * `faostat_dataframe_describe` on one context, since the staging layer resolves
 * the session canvas from `ctx.state`.
 */
const makeCtx = (tenantId: string) =>
  createMockContext({
    tenantId,
    errors: [...(queryObservationsTool.errors ?? []), ...(dataframeDescribeTool.errors ?? [])],
  });

beforeAll(() => {
  const cfg = parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' });
  const built = createCanvasService(cfg);
  if (!built) throw new Error('expected a DuckDB canvas to be constructed for the test');
  canvas = built;
  setCanvas(canvas);
});

afterAll(async () => {
  setCanvas(undefined);
  await canvas.shutdown(createMockContext({ tenantId: 'teardown' }));
});

describe('faostat_dataframe_describe provenance parity', () => {
  let dir: string;
  let mirror: FaostatMirror;

  /** Sync a synthetic domain of `countryCount` country rows into a fresh mirror. */
  async function syncDomain(countryCount: number): Promise<void> {
    const { zip } = buildMidSizeDomainZip({ countryCount });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 256)),
    );
    mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-provenance-'));
  });

  afterEach(async () => {
    await mirror?.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('omits undefined optional filters from query_params on both surfaces', async () => {
    // 1200 country rows overflow the inline budget, so the set spills and its
    // provenance is persisted for dataframe_describe to read back.
    await syncDomain(1200);
    const ctx = makeCtx('provenance');

    // ONLY domain — every optional filter (area/item/element codes, year range)
    // is omitted; the handler used to persist them as undefined-valued keys.
    const staged = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({ domain: FIXTURE_DOMAIN }),
      ctx,
    );
    expect(staged.spilled).toBe(true);

    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({}),
      ctx,
    );
    expect(described.tables).toHaveLength(1);

    // structuredContent: only the filters that were actually set survive.
    const params = described.tables[0]?.query_params ?? {};
    expect(Object.keys(params).sort()).toEqual(['domain', 'include_aggregates']);
    expect(params.domain).toBe(FIXTURE_DOMAIN);
    expect(params.include_aggregates).toBe(false);
    for (const omitted of ['area_codes', 'item_codes', 'element_codes', 'year_start', 'year_end']) {
      expect(Object.keys(params)).not.toContain(omitted);
    }

    // content[]: the rendered params must match — no `key=undefined` lines.
    const text = (dataframeDescribeTool.format?.(described) ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).not.toContain('=undefined');
    expect(text).toContain(`domain=${JSON.stringify(FIXTURE_DOMAIN)}`);
  });

  it('records the year bounds under their input names when supplied', async () => {
    await syncDomain(1200);
    const ctx = makeCtx('provenance-years');

    const staged = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({
        domain: FIXTURE_DOMAIN,
        year_start: 2020,
        year_end: 2020,
      }),
      ctx,
    );
    expect(staged.spilled).toBe(true);

    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({}),
      ctx,
    );
    expect(described.tables[0]?.query_params).toEqual({
      domain: FIXTURE_DOMAIN,
      year_start: 2020,
      year_end: 2020,
      include_aggregates: false,
    });
  });

  it('throws missing_table for a name miss while other tables are active', async () => {
    await syncDomain(1200);
    const ctx = makeCtx('name-miss');

    // Stage a real table so the canvas is NOT empty.
    const staged = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({ domain: FIXTURE_DOMAIN }),
      ctx,
    );
    expect(staged.spilled).toBe(true);

    // A name that matches nothing must not read as "the whole canvas is empty".
    await expect(
      dataframeDescribeTool.handler(
        dataframeDescribeTool.input.parse({ name: 'faostat_does_not_exist' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table' },
    });
  });

  it('reports the types DuckDB resolved, not VARCHAR for every column', async () => {
    await syncDomain(1200);
    const ctx = makeCtx('column-types');

    const staged = await queryObservationsTool.handler(
      queryObservationsTool.input.parse({ domain: FIXTURE_DOMAIN }),
      ctx,
    );
    expect(staged.spilled).toBe(true);
    const tableName = staged.table_name;
    const canvasId = staged.canvas_id;
    if (!tableName || !canvasId) throw new Error('expected the spill to report a canvas + table');

    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ name: tableName }),
      ctx,
    );
    const schema = described.tables[0]?.column_schema ?? [];
    expect(schema.length).toBeGreaterThan(0);
    const byName = Object.fromEntries(schema.map((c) => [c.name, c.type]));

    // The integer FAOSTAT codes and the year are not text — the pre-fix hardcode
    // reported VARCHAR for all seven, so a SQL caller wrote string comparisons.
    expect(byName.area_code).toBe('BIGINT');
    expect(byName.item_code).toBe('BIGINT');
    expect(byName.element_code).toBe('BIGINT');
    expect(byName.year).toBe('BIGINT');
    // Genuinely textual columns still read VARCHAR.
    expect(byName.area).toBe('VARCHAR');
    expect(byName.unit).toBe('VARCHAR');
    expect(byName.flag).toBe('VARCHAR');
    // The measure is DOUBLE even though every fixture value is a whole number — the
    // staged schema is explicit, not inferred from the preview rows (#30).
    expect(byName.value).toBe('DOUBLE');
    expect(schema.map((c) => c.name)).toEqual([
      'area_code',
      'area',
      'item_code',
      'item',
      'element_code',
      'element',
      'year',
      'unit',
      'value',
      'flag',
    ]);

    // Cross-check the whole schema against the engine itself: every reported type
    // must equal DuckDB's own typeof() for that column on the staged table.
    const instance = await canvas.acquire(canvasId, ctx);
    const probe = await instance.query(
      `SELECT ${schema.map((c) => `typeof(${c.name}) AS ${c.name}`).join(', ')} FROM ${tableName} LIMIT 1`,
    );
    expect(probe.rows[0]).toEqual(byName);

    // content[] carries the same resolved types, not a second (stale) rendering.
    const text = (dataframeDescribeTool.format?.(described) ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    for (const [name, type] of Object.entries(byName)) {
      expect(text).toContain(`${name}:${type}`);
    }
  });
});

describe('faostat_commodity_profile provenance names (#32)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  /** A commodity-profile context that can also describe the table it staged. */
  const makeProfileCtx = (tenantId: string) =>
    createMockContext({
      tenantId,
      errors: [...(commodityProfileTool.errors ?? []), ...(dataframeDescribeTool.errors ?? [])],
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-provenance-profile-'));
    // 500 countries × 4 years overflows the inline budget, so the profile spills.
    const { zip } = buildMidSizeDomainZip({ countryCount: 500, years: 4 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
  });

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Stage a profile for `input`; return the staged table's query_params + describe rendering. */
  async function describeProfile(tenantId: string, input: Record<string, unknown>) {
    const ctx = makeProfileCtx(tenantId);
    const result = await commodityProfileTool.handler(
      commodityProfileTool.input.parse({ item_query: 'wheat', ...input }),
      ctx,
    );
    expect(result.spilled).toBe(true);
    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ name: result.table_name }),
      ctx,
    );
    const text = (dataframeDescribeTool.format?.(described) ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    return { params: described.tables[0]?.query_params ?? {}, text };
  }

  it('names year_start / year_end as the tool input does, on both surfaces', async () => {
    const { params, text } = await describeProfile('profile-years', {
      year_start: 2020,
      year_end: 2022,
    });
    expect(params).toEqual({
      item_query: 'wheat',
      item_codes: [15],
      year_start: 2020,
      year_end: 2022,
    });
    expect(text).toContain('year_start=2020');
    expect(text).toContain('year_end=2022');
    expect(text).not.toMatch(/yearStart|yearEnd/);
  }, 30_000);

  it('records only the bound that was supplied', async () => {
    const { params } = await describeProfile('profile-year-start', { year_start: 2021 });
    expect(params).toEqual({ item_query: 'wheat', item_codes: [15], year_start: 2021 });
  }, 30_000);

  it('omits both year keys when the call had no year bound', async () => {
    const { params } = await describeProfile('profile-no-years', {});
    expect(params).toEqual({ item_query: 'wheat', item_codes: [15] });
  }, 30_000);
});

describe('staged column types come from the declared schema (#30)', () => {
  /** Enough rows to overflow the inline budget, every value a whole number. */
  function* wholeNumberRows(): Generator<Record<string, unknown>> {
    for (let i = 1; i <= 2000; i++) {
      yield { area_code: i, area: `Country ${i}`, value: 1000 + i, flag: 'A' };
    }
  }

  it('reports the declared types, whatever the rows hold', async () => {
    const ctx = makeCtx('declared-schema');
    const staged = await stageObservations(ctx, wholeNumberRows(), {
      sourceTool: 'faostat_query_observations',
      schema: OBSERVATION_TABLE_SCHEMA,
      queryParams: { domain: FIXTURE_DOMAIN },
    });
    expect(staged?.spilled).toBe(true);

    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ name: staged?.tableName }),
      ctx,
    );
    // Whole numbers would have inferred BIGINT; the declared DOUBLE is what DuckDB
    // registered and what describe reads back. Columns the rows lack are still
    // staged (as NULL), in the declared order.
    expect(described.tables[0]?.column_schema).toEqual(
      OBSERVATION_TABLE_SCHEMA.map(({ name, type }) => ({ name, type })),
    );
  });
});
