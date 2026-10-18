/**
 * @fileoverview Single-item profile selection through real scoped SQLite resolution.
 * @module tests/tools/commodity-profile-selection
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { DimensionsStore } from '@/services/faostat-mirror/dimensions-store.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildExplicitDomainZip,
  chunkedResponse,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

let mirror: FaostatMirror;
let dir: string;
const call = (input: Record<string, unknown>) => runToolContract(commodityProfileTool, input);
const text = (wire: Awaited<ReturnType<typeof call>>) =>
  wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'faostat-selection-'));
  const records = Array.from({ length: 8 }, (_, i) => ({
    areaCode: 10,
    area: 'Alpha',
    itemCode: 100 + i,
    item: i === 7 ? 'Milk' : `Milk variant ${i}`,
    elementCode: 5510,
    element: 'Production',
    year: 2022,
    value: i + 1,
  }));
  records.push(
    ...Array.from({ length: 8 }, (_, i) => ({
      ...records[0]!,
      itemCode: 200 + i,
      item: i === 7 ? 'Whole milk' : 'Milk whole',
      value: 20 + i,
    })),
  );
  const zips = {
    QCL: buildExplicitDomainZip(records),
    TCL: buildExplicitDomainZip(
      [{ ...records[0]!, itemCode: 900, item: 'Other domain only' }],
      'TCL',
    ),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) =>
      chunkedResponse(String(url).includes('_TCL_') ? zips.TCL : zips.QCL, 1 << 16),
    ),
  );
  mirror = initFaostatMirror({ dir, domains: ['QCL', 'TCL'] });
  for (const domain of ['QCL', 'TCL'])
    await mirror.runDomainSync(domain, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(domain),
    });
});
afterEach(async () => {
  await mirror.close();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('single-item selection (#41)', () => {
  it('finds a normalized exact label beyond the first five relevance matches', async () => {
    const fts = await mirror.resolve('QCL', 'item', { query: 'whole milk', limit: 5 });
    expect(fts.total).toBe(8);
    expect(fts.matches.map((match) => match.code)).not.toContain(207);
    const wire = await call({ item_query: '  wHOLe \t mILk  ' });
    expect(wire.isError).toBeFalsy();
    expect(wire.structuredContent).toMatchObject({
      resolved_items: [{ code: 207, name: 'Whole milk' }],
      production_trend: [{ value: 27 }],
    });
    expect(text(wire)).toContain('Whole milk (207)');
    expect(text(wire)).toContain('| 2022 | 27 |');
  });

  it('supports code-only calls and code precedence while retaining a supplied query', async () => {
    for (const input of [{ item_code: 100 }, { item_code: 100, item_query: 'unrelated' }]) {
      const wire = await call(input);
      expect(wire.isError).toBeFalsy();
      expect(wire.structuredContent).toMatchObject({
        item_query: 'item_query' in input ? 'unrelated' : 'Milk variant 0',
        resolved_items: [{ code: 100, name: 'Milk variant 0' }],
        production_trend: [{ value: 1 }],
      });
      expect(text(wire)).toContain('Milk variant 0 (100)');
    }
  });

  it('accepts a unique FTS prefix and returns empty sections for an empty year range', async () => {
    const wire = await call({ item_query: 'variant 0', year_start: 2023, top_n: 1 });
    expect(wire.isError).toBeFalsy();
    expect(wire.structuredContent).toMatchObject({
      resolved_items: [{ code: 100 }],
      top_producers: [],
      production_trend: [],
      trend_points: 0,
    });
    expect(text(wire)).toContain('### Top producers\n_None._');
  });

  it('returns bounded ambiguity candidates and executable recovery on both surfaces', async () => {
    const wire = await call({ item_query: 'variant' });
    expect(wire.isError).toBe(true);
    expect(wire.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'ambiguous_item',
          recovery: { hint: expect.stringContaining('item_code') },
        },
      },
    });
    expect(text(wire)).toContain('showing 5 of 7; truncated');
    expect(text(wire)).toContain('100: Milk variant 0');
    expect(text(wire)).toContain('faostat_resolve_codes');
  });

  it('refuses duplicate normalized exact labels instead of picking the first code', async () => {
    const wire = await call({ item_query: 'milk whole' });
    expect(wire.structuredContent).toMatchObject({ error: { data: { reason: 'ambiguous_item' } } });
    expect(text(wire)).toContain('7 QCL items match');
  });

  it.each([
    { item_code: 900 },
    { item_code: 9999 },
    { item_query: 'Other domain only' },
    { item_query: 'absent' },
  ])('preserves no_match and QCL membership for %j', async (input) => {
    const wire = await call(input);
    expect(wire.isError).toBe(true);
    expect(wire.structuredContent).toMatchObject({ error: { data: { reason: 'no_match' } } });
    expect(text(wire)).toContain('domain QCL');
    expect(text(wire)).toContain('item_code');
  });

  it('requires selection and rejects invalid input bounds', async () => {
    const wire = await call({});
    expect(wire.structuredContent).toMatchObject({ error: { data: { reason: 'missing_item' } } });
    expect(text(wire)).toContain('Supply item_code or item_query');
    for (const input of [
      { item_code: 0 },
      { item_code: 1.5 },
      { item_query: '' },
      { item_code: 100, top_n: 51 },
    ])
      expect(commodityProfileTool.input.safeParse(input).success).toBe(false);
  });

  it('keeps exact resolution scoped and paged before slicing, including past-end', async () => {
    expect(
      await mirror.resolve('QCL', 'item', {
        query: 'milk',
        preferExact: true,
        limit: 1,
        offset: 1,
      }),
    ).toEqual({ matches: [], total: 1 });
    expect(
      await mirror.resolve('QCL', 'item', {
        query: 'variant',
        preferExact: true,
        limit: 2,
        offset: 2,
      }),
    ).toMatchObject({ total: 7, matches: [{ code: 102 }, { code: 103 }] });
    expect(
      await mirror.resolve('QCL', 'item', {
        query: 'variant',
        preferExact: true,
        limit: 2,
        offset: 7,
      }),
    ).toEqual({ matches: [], total: 7 });
  });

  it('stages only the selected item across production and trade', async () => {
    const production = Array.from({ length: 800 }, (_, i) => ({
      areaCode: (i % 100) + 1,
      area: `Country ${(i % 100) + 1}`,
      itemCode: i < 400 ? 100 : 101,
      item: i < 400 ? 'Milk of cattle' : 'Milk of goats',
      elementCode: 5510,
      element: 'Production',
      year: 2020 + (Math.floor(i / 100) % 4),
      value: i < 400 ? 1 : 900,
    }));
    const trade = production.map((row) => ({
      ...row,
      elementCode: 5910,
      element: 'Export quantity',
    }));
    const zips = {
      QCL: buildExplicitDomainZip(production),
      TCL: buildExplicitDomainZip(trade, 'TCL'),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        chunkedResponse(String(url).includes('_TCL_') ? zips.TCL : zips.QCL, 1 << 16),
      ),
    );
    for (const domain of ['QCL', 'TCL'])
      await mirror.runDomainSync(domain, 'refresh', {
        signal: new AbortController().signal,
        dataset: { ...fixtureDataset(domain), DateUpdate: '2026-01-01T00:00:00' },
      });
    const canvas = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
    if (!canvas) throw new Error('Expected canvas');
    const ctx = createMockContext({
      tenantId: 'selected-staging',
      errors: commodityProfileTool.errors,
    });
    setCanvas(canvas);
    try {
      const result = await commodityProfileTool.handler(
        commodityProfileTool.input.parse({ item_code: 100, item_query: 'milk', top_n: 1 }),
        ctx,
      );
      expect(result.spilled).toBe(true);
      expect(result.resolved_items).toEqual([{ code: 100, name: 'Milk of cattle' }]);
      expect(result.top_producers).toHaveLength(1);
      expect(result.top_producers[0]?.value).toBe(1);
      expect(result.top_exporters[0]?.value).toBe(1);
      expect(result.production_trend.map((point) => point.value)).toEqual([100, 100, 100, 100]);
      const instance = await canvas.acquire(result.canvas_id, ctx);
      const rows = await instance.query(
        `SELECT DISTINCT domain, CAST(item_code AS INTEGER) AS item_code FROM ${result.table_name} ORDER BY domain`,
      );
      expect(rows.rows).toEqual([
        { domain: 'QCL', item_code: 100 },
        { domain: 'TCL', item_code: 100 },
      ]);
      expect(commodityProfileTool.format?.(result)).toEqual([
        expect.objectContaining({ text: expect.stringContaining('Milk of cattle (100)') }),
      ]);
    } finally {
      setCanvas(undefined);
      await canvas.shutdown(ctx);
    }
  });

  it('propagates caller cancellation from selection', async () => {
    const controller = new AbortController();
    controller.abort();
    const wire = await runToolContract(
      commodityProfileTool,
      { item_code: 100 },
      { context: { signal: controller.signal } },
    );
    expect(wire.isError).toBe(true);
    expect(wire.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
  });

  it('bounds normalization CPU across a 64-fold input span', async () => {
    const store = new DimensionsStore(dir);
    try {
      for (const shape of [
        (n: number) => '1'.repeat(n),
        (n: number) => '<a'.repeat(n / 2),
        (n: number) => 'a\n'.repeat(n / 2),
      ]) {
        const samples: number[] = [];
        for (let size = 5000; size <= 320000; size *= 2) {
          const query = shape(size);
          await store.upsertItems([{ item_code: 999, item: query, cpc_code: null }]);
          const start = process.threadCpuUsage();
          const resolved = await store.resolve('item', {
            query,
            preferExact: true,
            domainCodes: [999],
            limit: 1,
          });
          const cpu = process.threadCpuUsage(start);
          const micros = cpu.user + cpu.system;
          expect(resolved.matches[0]?.code).toBe(999);
          expect(micros).toBeLessThan(250000);
          samples.push(micros);
        }
        expect(samples.at(-1)! / samples[0]!).toBeLessThan(256);
      }
    } finally {
      await store.close();
    }
  });
});
