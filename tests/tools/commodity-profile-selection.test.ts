/**
 * @fileoverview Single-item profile selection through real scoped SQLite resolution,
 * and the trade item a `trade_item_code` selects in TCL (#66).
 * @module tests/tools/commodity-profile-selection
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';
import { createCanvasService } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withStrictCountInputs } from '@/mcp-server/tools/count-input.js';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { searchDimension } from '@/services/faostat-mirror/dimension-search.js';
import { DIMENSIONS_DB_FILE } from '@/services/faostat-mirror/dimensions-store.js';
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
    // The heading still names the element; no row in the bounds gives it a unit.
    expect(text(wire)).toContain('### Top producers — Production 5510\n_None._');
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
    expect(wire.structuredContent).toMatchObject({
      error: { message: 'Supply item_code or item_query.', data: { reason: 'missing_item' } },
    });
    expect(text(wire)).toContain('Supply item_code or item_query');
    // With no item_query at all, the message says nothing about one.
    expect(text(wire)).not.toContain('names no commodity');
    for (const input of [{ item_code: 0 }, { item_code: 1.5 }, { item_query: '' }])
      expect(commodityProfileTool.input.safeParse(input).success).toBe(false);
  });

  it.each(['*', ' * ', '   '])(
    'reads item_query %j as omitted: missing_item on both surfaces (#67)',
    async (query) => {
      const wire = await call({ item_query: query });
      expect(wire.isError).toBe(true);
      const recovery = commodityProfileTool.errors?.find(
        (entry) => entry.reason === 'missing_item',
      )?.recovery;
      expect(wire.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message:
            'item_query is whitespace-only or "*", which names no commodity. Supply item_code or item_query.',
          data: { reason: 'missing_item', recovery: { hint: recovery } },
        },
      });
      expect(text(wire)).toContain('Supply item_code or item_query');
      // The message names the query it read as omitted; the recovery never says this.
      expect(text(wire)).toContain('which names no commodity');
      expect(text(wire)).toContain(recovery);
    },
  );

  it.each([
    ['()', '"()"'],
    ['""', '"\\"\\""'],
    ['(*)', '"(*)"'],
    ['**', '"**"'],
    ['* *', '"* *"'],
  ])(
    'fails item_query %j with invalid_query on both surfaces, naming it as %s (#67)',
    async (query, quoted) => {
      const wire = await call({ item_query: query });
      expect(wire.isError).toBe(true);
      const recovery = commodityProfileTool.errors?.find(
        (entry) => entry.reason === 'invalid_query',
      )?.recovery;
      expect(wire.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: `item_query ${quoted} holds no search term: it is made only of quotes, parentheses, asterisks, and whitespace.`,
          data: { reason: 'invalid_query', recovery: { hint: recovery } },
        },
      });
      // content[] carries the message markdown-escaped.
      expect(text(wire)).toContain('holds no search term');
      expect(text(wire)).toContain('quotes, parentheses, asterisks, and whitespace');
      expect(text(wire)).toContain(recovery);
    },
  );

  it.each(['()', '*'])('lets item_code win over item_query %j, unread (#67)', async (query) => {
    const wire = await call({ item_code: 100, item_query: query });
    expect(wire.isError).toBeFalsy();
    expect(wire.structuredContent).toMatchObject({
      item_query: query,
      resolved_items: [{ code: 100, name: 'Milk variant 0' }],
    });
  });

  it.each(['?', '-', '​', '小麦'])(
    'keeps a search with no indexed word a no_match: %j (#67)',
    async (query) => {
      const wire = await call({ item_query: query });
      expect(wire.structuredContent).toMatchObject({ error: { data: { reason: 'no_match' } } });
    },
  );

  it.each([
    ['\u0000', '"\\u0000"'],
    ['\u0007', '"\\u0007"'],
    ['\u0085', '"\\u0085"'],
    ['(\u0007)', '"(\\u0007)"'],
    ['?', '"?"'],
  ])(
    'answers item_query %j, which leaves no word, with no_match on both surfaces, naming it as %s (#67)',
    async (query, quoted) => {
      const wire = await call({ item_query: query });
      expect(wire.isError).toBe(true);
      expect(wire.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_match' } },
      });
      expect(text(wire)).toContain(`No QCL item matched ${quoted}.`);
      expect(text(wire).replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    },
  );

  it('names an ambiguous item_query escaped on both surfaces', async () => {
    const wire = await call({ item_query: 'variant\u0007' });
    expect(wire.structuredContent).toMatchObject({ error: { data: { reason: 'ambiguous_item' } } });
    expect(text(wire)).toContain('7 QCL items match "variant\\u0007". Candidates');
    expect(text(wire).replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
  });

  it('serves a top_n above its cap at 50 rows per ranking, with the clamp on both surfaces (#56)', async () => {
    // 60 countries in every ranking, so each one has more rows than the cap.
    const production = Array.from({ length: 60 }, (_, i) => ({
      areaCode: i + 1,
      area: `Country ${i + 1}`,
      itemCode: 100,
      item: 'Milk variant 0',
      elementCode: 5510,
      element: 'Production',
      year: 2022,
      value: i + 1,
    }));
    const trade = production.flatMap((row) => [
      { ...row, elementCode: 5910, element: 'Export quantity' },
      { ...row, elementCode: 5610, element: 'Import quantity' },
    ]);
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

    const clamped = await call({ item_code: 100, top_n: 80 });
    expect(clamped.isError).toBeFalsy();
    const structured = clamped.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ requestedTopN: 80, effectiveTopN: 50 });
    expect(structured.notice).toMatch(/^top_n 80 is above the 50 cap; returned up to 50\. /);
    for (const ranking of ['top_producers', 'top_exporters', 'top_importers'])
      expect(structured[ranking]).toHaveLength(50);
    expect(text(clamped)).toContain('**requestedTopN:** 80');
    expect(text(clamped)).toContain(`> ${structured.notice}`);

    const atCap = await call({ item_code: 100, top_n: 50 });
    const unclamped = atCap.structuredContent as Record<string, unknown>;
    expect(unclamped).not.toHaveProperty('requestedTopN');
    expect(unclamped).not.toHaveProperty('effectiveTopN');
    expect(unclamped.notice).not.toMatch(/above the 50 cap/);
    expect(unclamped.top_producers).toHaveLength(50);
  });

  it('advertises top_n without a maximum, and with it in strict mode (#56)', () => {
    const props = (d: AnyToolDefinition) =>
      (z.toJSONSchema(d.input, { io: 'input' }) as { properties: Record<string, unknown> })
        .properties;
    expect(props(commodityProfileTool).top_n).toEqual({
      type: 'integer',
      minimum: 1,
      default: 10,
      description: expect.stringContaining('at most 50 per call'),
    });
    expect(props(withStrictCountInputs(commodityProfileTool)).top_n).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 10,
    });
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

  it('compares ";" and "," as one character in the exact-label preference', async () => {
    const labels = [
      [187, 'Peas; dry'],
      [417, 'Peas; green'],
      [191, 'Chick peas; dry'],
      [195, 'Cow peas; dry'],
    ] as const;
    const zips = {
      QCL: buildExplicitDomainZip(
        labels.map(([itemCode, item], i) => ({
          areaCode: 10,
          area: 'Alpha',
          itemCode,
          item,
          elementCode: 5510,
          element: 'Production',
          year: 2022,
          value: i + 1,
        })),
      ),
      TCL: buildExplicitDomainZip(
        [
          {
            areaCode: 10,
            area: 'Alpha',
            itemCode: 900,
            item: 'Other domain only',
            elementCode: 5910,
            element: 'Export quantity',
            year: 2022,
            value: 1,
          },
        ],
        'TCL',
      ),
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

    for (const [query, code, name] of [
      ['Peas, dry', 187, 'Peas; dry'],
      ['Peas; dry', 187, 'Peas; dry'],
      ['  peas,   DRY ', 187, 'Peas; dry'],
      // A control character separates words here as it does in the search (#67).
      ['Peas,\u0007dry', 187, 'Peas; dry'],
      ['Peas; dry\u0000', 187, 'Peas; dry'],
      ['Peas, green', 417, 'Peas; green'],
      ['Chick peas, dry', 191, 'Chick peas; dry'],
    ] as const) {
      const wire = await call({ item_query: query });
      expect(wire.isError).toBeFalsy();
      expect(wire.structuredContent).toMatchObject({
        item_query: query,
        resolved_items: [{ code, name }],
      });
      expect(text(wire)).toContain(`${name} (${code})`);
    }
    // No exact label: the relevance search still has to pick one item.
    const broad = await call({ item_query: 'peas dry' });
    expect(broad.structuredContent).toMatchObject({
      error: { data: { reason: 'ambiguous_item' } },
    });
    expect(text(broad)).toContain('3 QCL items match');
  });

  it('bounds normalization CPU across a 64-fold input span', async () => {
    const handle = await openSqliteHandle(join(dir, DIMENSIONS_DB_FILE));
    try {
      for (const shape of [
        (n: number) => '1'.repeat(n),
        (n: number) => '<a'.repeat(n / 2),
        (n: number) => 'a\n'.repeat(n / 2),
      ]) {
        const samples: number[] = [];
        for (let size = 5000; size <= 320000; size *= 2) {
          const query = shape(size);
          await mirror.dimensions.upsertItems([
            { item_code: 999, item_code_text: null, item: query, cpc_code: null },
          ]);
          const start = process.threadCpuUsage();
          const resolved = searchDimension(handle, 'item', {
            query,
            preferExact: true,
            domainCodes: [999],
            limit: 1,
          });
          const cpu = process.threadCpuUsage(start);
          const micros = cpu.user + cpu.system;
          expect(resolved.rows[0]?.item_code).toBe(999);
          expect(micros).toBeLessThan(250000);
          samples.push(micros);
        }
        expect(samples.at(-1)! / samples[0]!).toBeLessThan(256);
      }
    } finally {
      handle.close();
    }
  });
});

describe('profile heading for a query with a control character (#67)', () => {
  /** QCL: Wheat and Peas; dry, so a control character in either query still selects one item. */
  beforeEach(async () => {
    const qcl = buildExplicitDomainZip(
      (
        [
          [15, 'Wheat'],
          [187, 'Peas; dry'],
        ] as const
      ).map(([itemCode, item]) => ({
        areaCode: 10,
        area: 'Alpha',
        itemCode,
        item,
        elementCode: 5510,
        element: 'Production',
        year: 2022,
        value: 1,
      })),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(qcl, 1 << 16)),
    );
    await mirror.runDomainSync('QCL', 'refresh', {
      signal: new AbortController().signal,
      dataset: { ...fixtureDataset('QCL'), DateUpdate: '2026-01-01T00:00:00' },
    });
  });

  /** The first line of the `format()` block, `content[0]`. */
  const headingOf = (wire: Awaited<ReturnType<typeof call>>) => {
    const [first] = wire.content;
    return (first?.type === 'text' ? first.text : '').split('\n')[0];
  };

  it.each([
    ['wheat\u0000', '"wheat\\u0000"', 'Wheat (15)'],
    ['Peas,\u0007dry', '"Peas,\\u0007dry"', 'Peas; dry (187)'],
  ])(
    'renders item_query %j in the heading as %s, and keeps it raw in structuredContent',
    async (query, quoted, resolved) => {
      const wire = await call({ item_query: query });
      expect(wire.isError).toBeFalsy();
      expect(wire.structuredContent).toMatchObject({ item_query: query });
      expect(headingOf(wire)).toBe(`## Commodity profile: ${quoted}`);
      expect(text(wire)).toContain(`Resolved to: ${resolved}`);
      expect(text(wire).replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    },
  );

  it.each([
    [{ item_query: 'wheat' }, 'wheat'],
    [{ item_query: '"wheat"' }, '"wheat"'],
    [{ item_query: 'Peas, dry' }, 'Peas, dry'],
    [{ item_code: 15 }, 'Wheat'],
  ])('keeps the heading for %j as the text itself: %s', async (input, shown) => {
    const wire = await call(input);
    expect(wire.isError).toBeFalsy();
    expect(headingOf(wire)).toBe(`## Commodity profile: ${shown}`);
  });
});

describe('trade item selection (#66)', () => {
  const alpha = { areaCode: 10, area: 'Alpha', year: 2022 };
  const bravo = { areaCode: 20, area: 'Bravo', year: 2022 };
  const production = { elementCode: 5510, element: 'Production' };
  const exports = { elementCode: 5910, element: 'Export quantity' };
  const imports = { elementCode: 5610, element: 'Import quantity' };
  const milk = { itemCode: 100, item: 'Milk variant 0' };
  const goats = { itemCode: 101, item: 'Milk of goats' };
  const sugar = { itemCode: 1723, item: 'Sugar and sweeteners' };

  /** QCL: two Production items. TCL: trade rows for the first and for a curated group item. */
  beforeEach(async () => {
    const zips = {
      QCL: buildExplicitDomainZip([
        { ...alpha, ...milk, ...production, value: 5 },
        { ...bravo, ...milk, ...production, value: 9 },
        { ...alpha, ...goats, ...production, value: 3 },
      ]),
      TCL: buildExplicitDomainZip(
        [
          { ...alpha, ...milk, ...exports, value: 4 },
          { ...bravo, ...milk, ...imports, value: 2 },
          { ...bravo, ...sugar, ...exports, value: 70 },
          { ...alpha, ...sugar, ...exports, value: 30 },
        ],
        'TCL',
      ),
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
  });

  it('takes the item_code schema: positive integers only', () => {
    const props = (
      z.toJSONSchema(commodityProfileTool.input, { io: 'input' }) as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties;
    const { description: tradeDescription, ...trade } = props.trade_item_code ?? {};
    const { description: _itemDescription, ...item } = props.item_code ?? {};
    expect(trade).toEqual(item);
    expect(tradeDescription).toEqual(expect.stringContaining('faostat_resolve_codes'));
    expect(
      commodityProfileTool.input.safeParse({ item_code: 100, trade_item_code: 30 }).success,
    ).toBe(true);
    for (const trade_item_code of [0, -1, 1.5])
      expect(
        commodityProfileTool.input.safeParse({ item_code: 100, trade_item_code }).success,
      ).toBe(false);
  });

  it.each([
    ['absent from every domain', 9999],
    ['present in QCL alone', goats.itemCode],
  ])(
    'fails a trade_item_code %s with trade_item_not_found before any ranking read',
    async (_case, code) => {
      const reads = vi.spyOn(mirror.reads, 'all');
      let wire: Awaited<ReturnType<typeof call>>;
      try {
        wire = await call({ item_code: milk.itemCode, trade_item_code: code });
        // Item resolution, then the QCL and TCL element reads; no ranking, trend, or staging read.
        expect(reads).toHaveBeenCalledTimes(3);
      } finally {
        reads.mockRestore();
      }
      const recovery = commodityProfileTool.errors?.find(
        (entry) => entry.reason === 'trade_item_not_found',
      )?.recovery;
      expect(recovery).toBe(
        'Call faostat_resolve_codes with domain TCL, dimension item, and a query naming the traded product, then pass a returned code as trade_item_code.',
      );
      expect(wire.isError).toBe(true);
      expect(wire.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: `trade_item_code ${code} names no item with rows in TCL.`,
          data: { reason: 'trade_item_not_found', recovery: { hint: recovery } },
        },
      });
      expect(text(wire)).toContain(`trade_item_code ${code} names no item with rows in TCL.`);
      expect(text(wire)).toContain(recovery);
    },
  );

  it('ranks a trade_item_code equal to item_code exactly as when it is omitted', async () => {
    const omitted = await call({ item_code: milk.itemCode });
    const same = await call({ item_code: milk.itemCode, trade_item_code: milk.itemCode });
    expect(same.isError).toBeFalsy();
    const { trade_item, ...rest } = same.structuredContent as Record<string, unknown>;
    expect(trade_item).toEqual({ code: 100, name: 'Milk variant 0' });
    expect(rest).toEqual(omitted.structuredContent);
    expect(rest).toMatchObject({
      top_exporters: [{ area_code: 10, value: 4 }],
      top_importers: [{ area_code: 20, value: 2 }],
    });
    expect(text(same)).toContain('Trade item: Milk variant 0 (100)');
    expect(text(same)).toContain(
      '### Top exporters of Milk variant 0 (100) — Export quantity 5910 (t)',
    );
    expect(text(omitted)).not.toContain('Trade item:');
    expect(text(omitted)).toContain('### Top exporters — Export quantity 5910 (t)');
  });

  it('accepts a curated TCL group item as the trade item', async () => {
    const wire = await call({ item_code: milk.itemCode, trade_item_code: sugar.itemCode });
    expect(wire.isError).toBeFalsy();
    expect(wire.structuredContent).toMatchObject({
      resolved_items: [{ code: 100, name: 'Milk variant 0' }],
      trade_item: { code: 1723, name: 'Sugar and sweeteners' },
      top_producers: [
        { area_code: 20, value: 9 },
        { area_code: 10, value: 5 },
      ],
      top_exporters: [
        { area_code: 20, value: 70 },
        { area_code: 10, value: 30 },
      ],
      top_importers: [],
    });
  });
});
