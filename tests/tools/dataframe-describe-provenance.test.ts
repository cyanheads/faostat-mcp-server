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
 *    reported contract matches what DuckDB registered.
 *
 * Drives the real end-to-end path: a real domain sync into a temp SQLite mirror +
 * a real DuckDB canvas, staged via `faostat_query_observations` with ONLY
 * `domain` set (every optional filter omitted), then described.
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
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { stageObservations } from '@/services/canvas-staging.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

let canvas: DataCanvas;

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
    const ctx = createMockContext({
      tenantId: 'provenance',
      errors: queryObservationsTool.errors,
    });

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
    const text = dataframeDescribeTool
      .format(described)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).not.toContain('=undefined');
    expect(text).toContain(`domain=${JSON.stringify(FIXTURE_DOMAIN)}`);
  });

  it('throws missing_table for a name miss while other tables are active', async () => {
    await syncDomain(1200);
    const ctx = createMockContext({
      tenantId: 'name-miss',
      errors: [...queryObservationsTool.errors, ...dataframeDescribeTool.errors],
    });

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
    const ctx = createMockContext({
      tenantId: 'column-types',
      errors: queryObservationsTool.errors,
    });

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

    // Cross-check the whole schema against the engine itself: every reported type
    // must equal DuckDB's own typeof() for that column on the staged table.
    const instance = await canvas.acquire(canvasId, ctx);
    const probe = await instance.query(
      `SELECT ${schema.map((c) => `typeof(${c.name}) AS ${c.name}`).join(', ')} FROM ${tableName} LIMIT 1`,
    );
    expect(probe.rows[0]).toEqual(byName);

    // content[] carries the same resolved types, not a second (stale) rendering.
    const text = dataframeDescribeTool
      .format(described)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    for (const [name, type] of Object.entries(byName)) {
      expect(text).toContain(`${name}:${type}`);
    }
  });
});

describe('staged column types for a non-integer measure', () => {
  /** Enough rows to overflow the inline budget, with a genuinely fractional value. */
  function* fractionalRows(): Generator<Record<string, unknown>> {
    for (let i = 1; i <= 2000; i++) {
      yield { area_code: i, area: `Country ${i}`, value: i + 0.5, flag: 'A' };
    }
  }

  it('resolves a fractional measure column to DOUBLE', async () => {
    const ctx = createMockContext({
      tenantId: 'double-column',
      errors: dataframeDescribeTool.errors,
    });
    const staged = await stageObservations(ctx, fractionalRows(), {
      sourceTool: 'faostat_query_observations',
      queryParams: { domain: FIXTURE_DOMAIN },
    });
    expect(staged?.spilled).toBe(true);

    const described = await dataframeDescribeTool.handler(
      dataframeDescribeTool.input.parse({ name: staged?.tableName }),
      ctx,
    );
    const byName = Object.fromEntries(
      (described.tables[0]?.column_schema ?? []).map((c) => [c.name, c.type]),
    );
    expect(byName).toEqual({
      area_code: 'BIGINT',
      area: 'VARCHAR',
      value: 'DOUBLE',
      flag: 'VARCHAR',
    });
  });
});
