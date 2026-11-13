/**
 * @fileoverview Scoped element units and read-time item classification regressions.
 * @module tests/tools/resolve-elements
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withStrictCountInputs } from '@/mcp-server/tools/count-input.js';
import { queryObservationsTool } from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import {
  buildExplicitDomainZip,
  chunkedResponse,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

let dir: string;
let mirror: FaostatMirror;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'faostat-elements-'));
  const zip = buildExplicitDomainZip([
    {
      area: 'Afghanistan',
      areaCode: 2,
      item: 'Cattle',
      itemCode: 866,
      element: 'Stocks',
      elementCode: 5111,
      unit: 'An',
      year: 2020,
      value: 1,
    },
    {
      area: 'Afghanistan',
      areaCode: 2,
      item: 'Chickens',
      itemCode: 1057,
      element: 'Stocks',
      elementCode: 5112,
      unit: '1000 An',
      year: 2020,
      value: 2,
    },
    {
      area: 'Afghanistan',
      areaCode: 2,
      item: 'Cereals primary',
      itemCode: 1717,
      element: 'Production',
      elementCode: 5510,
      unit: 't',
      year: 2020,
      value: 3,
    },
  ]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => chunkedResponse(zip)),
  );
  mirror = initFaostatMirror({ dir, domains: ['QCL', 'GLE', 'TCL'] });
  await mirror.runDomainSync('QCL', 'init', {
    signal: new AbortController().signal,
    dataset: fixtureDataset(),
  });
});
afterEach(async () => {
  await mirror.close();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

it('characterizes shared areas and ready-domain zero matches and paging', async () => {
  const run = (args: object) =>
    resolveCodesTool.handler(
      resolveCodesTool.input.parse(args),
      createMockContext({ errors: resolveCodesTool.errors }),
    );
  expect((await run({ domain: 'GLE', dimension: 'area', code: 2 })).matches[0]?.name).toBe(
    'Afghanistan',
  );
  expect(await mirror.resolve('QCL', 'element', { code: 999, limit: 1 })).toEqual({
    matches: [],
    total: 0,
  });
  expect((await mirror.resolve('QCL', 'element', { limit: 1, offset: 1 })).matches[0]?.code).toBe(
    5112,
  );
});

it.each([
  { code: 5111 },
  { query: 'Stocks' },
  { query: 'Stocks', preferExact: true },
  { nameContains: 'tock' },
  {},
])('scopes before matching and paging: %j', async (selection) => {
  const result = await mirror.resolve('QCL', 'element', {
    ...selection,
    itemCodes: [866],
    limit: 1,
  });
  expect(result).toEqual({
    matches: [{ code: 5111, code_text: null, name: 'Stocks', kind: null, units: ['An'] }],
    total: 1,
  });
  expect(await mirror.resolve('QCL', 'element', { ...selection, itemCodes: [], limit: 1 })).toEqual(
    { matches: [], total: 0 },
  );
  expect(
    await mirror.resolve('QCL', 'element', { ...selection, itemCodes: [999], limit: 1 }),
  ).toEqual({ matches: [], total: 0 });
});

it('classifies verified QCL items at read time', async () => {
  expect((await mirror.resolve('QCL', 'item', { code: 1717, limit: 1 })).matches[0]?.kind).toBe(
    'aggregate',
  );
});

it('returns available item elements on both surfaces without claiming requested coverage', async () => {
  const output = await runToolContract(queryObservationsTool, {
    domain: 'QCL',
    item_codes: [866],
    element_codes: [5112],
    area_codes: [999],
    year_start: 1900,
  });
  expect(output.structuredContent).toMatchObject({
    available_elements: [{ code: 5111, name: 'Stocks', units: ['An'] }],
  });
  const text = JSON.stringify(output.content);
  expect(text).toContain('5111');
  expect(text).toContain('Stocks');
  expect(text).toContain('An');
  expect(text).toContain('area/year');
});

it('does not suggest source resolution for an empty source selection', async () => {
  const ctx = createMockContext({ errors: queryObservationsTool.errors });
  await queryObservationsTool.handler(
    queryObservationsTool.input.parse({ domain: 'QCL', source_codes: [] }),
    ctx,
  );
  expect(getEnrichment(ctx).notice).not.toContain('faostat_resolve_codes');
});

it.each(['item', 'element'] as const)(
  'returns retryable readiness and recovery on both surfaces for unsynced %s',
  async (dimension) => {
    const output = await runToolContract(resolveCodesTool, {
      domain: 'GLE',
      dimension,
      query: 'cattle',
    });
    expect(output.isError).toBe(true);
    expect(JSON.stringify(output.structuredContent)).toContain('index_not_ready');
    expect(JSON.stringify(output.structuredContent)).toContain('retry');
    expect(JSON.stringify(output.content)).toContain('sync');
  },
);

it.each([
  { dimension: 'item' as const, item_codes: [866] },
  { dimension: 'area' as const, item_codes_text: ['1806A'] },
  { dimension: 'element' as const, item_codes: [], item_codes_text: [] },
])('rejects invalid item scope with recovery on both surfaces: %j', async (selection) => {
  const output = await runToolContract(resolveCodesTool, { domain: 'QCL', ...selection });
  expect(output.isError).toBe(true);
  expect(JSON.stringify(output.structuredContent)).toContain('invalid_item_scope');
  expect(JSON.stringify(output.content)).toContain('dimension element');
});

it('exposes scoped units, cap pagination, and past-end guidance on both surfaces', async () => {
  const args = { domain: 'QCL', dimension: 'element' as const, item_codes: [866, 1057], limit: 1 };
  const first = await runToolContract(resolveCodesTool, args);
  expect(first.structuredContent).toMatchObject({
    matches: [{ code: 5111, units: ['An'] }],
    totalMatches: 2,
    truncated: true,
    nextOffset: 1,
  });
  expect(JSON.stringify(first.content)).toContain('units: An');
  const second = await runToolContract(resolveCodesTool, { ...args, offset: 1 });
  expect(second.structuredContent).toMatchObject({
    matches: [{ code: 5112, units: ['1000 An'] }],
    totalMatches: 2,
    truncated: false,
  });
  expect(JSON.stringify(second.content)).toContain('1000 An');
  const past = await runToolContract(resolveCodesTool, { ...args, offset: 2 });
  expect(past.structuredContent).toMatchObject({ matches: [], totalMatches: 2, truncated: false });
  expect(JSON.stringify(past.content)).toContain('Offset 2');
  // Served at the 200 cap by default; the FAOSTAT_CLAMP_LIMITS=false registration rejects it.
  expect(
    withStrictCountInputs(resolveCodesTool).input.safeParse({ ...args, limit: 201 }).success,
  ).toBe(false);
  expect(resolveCodesTool.input.safeParse({ ...args, offset: -1 }).success).toBe(false);
});

it.each([
  { code: 1717 },
  { query: 'Cereals' },
  { name_contains: 'Cereals' },
  { offset: 2, limit: 1 },
])('preserves aggregate marker across lookup paths and both surfaces: %j', async (selection) => {
  const output = await runToolContract(resolveCodesTool, {
    domain: 'QCL',
    dimension: 'item',
    ...selection,
  });
  expect(output.structuredContent).toMatchObject({ matches: [{ code: 1717, kind: 'aggregate' }] });
  expect(JSON.stringify(output.content)).toContain('[aggregate]');
  expect(
    (await mirror.resolve('QCL', 'item', { code: 866, limit: 1 })).matches[0]?.kind,
  ).toBeNull();
});

it('keeps exact text item scope, null units, and stable text pagination', async () => {
  const handle = await mirror.getMirror('QCL')!.raw();
  await mirror.dimensions.upsertItems([
    { item_code: null, item_code_text: '1806B', item: 'Text second', cpc_code: null },
    { item_code: null, item_code_text: '1806A', item: 'Text first', cpc_code: null },
  ]);
  for (const text of ['1806B', '1806A'])
    handle
      .prepare(
        'INSERT INTO obs_QCL(id,item_code,item_code_text,element_code,unit) VALUES (?,NULL,?,5111,NULL)',
      )
      .run(text, text);
  const scoped = await runToolContract(resolveCodesTool, {
    domain: 'QCL',
    dimension: 'element',
    item_codes_text: ['1806A'],
  });
  expect(scoped.structuredContent).toMatchObject({ matches: [{ code: 5111, units: [] }] });
  expect(JSON.stringify(scoped.content)).toContain('unspecified');
  const textPage = await mirror.resolve('QCL', 'item', {
    nameContains: 'Text',
    offset: 1,
    limit: 1,
  });
  expect(textPage.matches).toEqual([
    { code: null, code_text: '1806B', name: 'Text second', kind: null },
  ]);
  const miss = await runToolContract(resolveCodesTool, {
    domain: 'QCL',
    dimension: 'item',
    code_text: '1806C',
  });
  expect(JSON.stringify(miss.content)).toContain('1806C');
});

it('enumerates empty-query guidance beyond the first element page using the same deadline', async () => {
  const handle = await mirror.getMirror('QCL')!.raw();
  const insert = handle.prepare(
    'INSERT INTO obs_QCL(id,item_code,element_code,unit) VALUES (?,866,?,?)',
  );
  const records = Array.from({ length: 205 }, (_, i) => ({
    element_code: 6000 + i,
    element: `Metric ${i}`,
  }));
  await mirror.dimensions.upsertElements(records);
  for (const record of records)
    insert.run(`metric-${record.element_code}`, record.element_code, 'kg');
  const readSignal = vi.spyOn(mirror, 'readSignal');
  const resolve = vi.spyOn(mirror, 'resolve');
  const output = await runToolContract(queryObservationsTool, {
    domain: 'QCL',
    item_codes: [866],
    element_codes: [9999],
  });
  const data = output.structuredContent as {
    available_elements: { code: number; name: string; units: string[] }[];
  };
  expect(data.available_elements).toHaveLength(206);
  expect(data.available_elements[205]).toEqual({ code: 6204, name: 'Metric 204', units: ['kg'] });
  expect(JSON.stringify(output.content)).toContain('6204');
  expect(readSignal).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve.mock.calls[0]![2].signal).toBe(resolve.mock.calls[1]![2].signal);
});

it('classifies only verified per-domain positives and keeps ordinary/unknown items unclassified', async () => {
  const positives = [1717, 1720, 1723, 1730, 1735, 1738, 1780];
  const records = [...positives, 1739, 9999].map((code) => ({
    item_code: code,
    item_code_text: null,
    item: `Group ${code}`,
    cpc_code: `F${code}`,
  }));
  await mirror.dimensions.upsertItems(records);
  const handle = await mirror.getMirror('QCL')!.raw();
  for (const code of [...positives, 1739, 9999])
    handle
      .prepare('INSERT INTO obs_QCL(id,item_code,element_code) VALUES (?,?,5510)')
      .run(`group-${code}`, code);
  const classified = await mirror.resolve('QCL', 'item', { nameContains: 'Group', limit: 200 });
  expect(classified.matches.map(({ code, kind }) => [code, kind])).toEqual([
    [1717, 'aggregate'],
    [1720, 'aggregate'],
    [1723, 'aggregate'],
    [1730, 'aggregate'],
    [1735, 'aggregate'],
    [1738, 'aggregate'],
    [1739, null],
    [1780, 'aggregate'],
    [9999, null],
  ]);
  for (const domain of ['GLE', 'TCL']) {
    const zip = buildExplicitDomainZip(
      [
        {
          area: 'Afghanistan',
          areaCode: 2,
          item: 'Cereals primary',
          itemCode: 1717,
          element: 'Production',
          elementCode: 5510,
          unit: 't',
          year: 2020,
          value: 1,
        },
        {
          area: 'Afghanistan',
          areaCode: 2,
          item: 'Sugar crops',
          itemCode: 1723,
          element: 'Production',
          elementCode: 5510,
          unit: 't',
          year: 2020,
          value: 1,
        },
      ],
      domain,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip)),
    );
    await mirror.runDomainSync(domain, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(domain),
    });
  }
  expect((await mirror.resolve('GLE', 'item', { limit: 10 })).matches.map((m) => m.kind)).toEqual([
    null,
    null,
  ]);
  expect(
    (await mirror.resolve('TCL', 'item', { limit: 10 })).matches.map((m) => [m.code, m.kind]),
  ).toEqual([
    [1717, null],
    [1723, 'aggregate'],
  ]);
});

it('deduplicates non-null units within precisely the selected item union', async () => {
  const handle = await mirror.getMirror('QCL')!.raw();
  for (const [id, item, unit] of [
    ['a', 866, 'An'],
    ['b', 866, 'head'],
    ['c', 866, null],
    ['d', 1057, 'other'],
  ] as const)
    handle
      .prepare('INSERT INTO obs_QCL(id,item_code,element_code,unit) VALUES (?,?,5111,?)')
      .run(id, item, unit);
  expect(
    (await mirror.resolve('QCL', 'element', { itemCodes: [866], limit: 10 })).matches[0]?.units,
  ).toEqual(['An', 'head']);
  expect(
    (await mirror.resolve('QCL', 'element', { itemCodes: [866, 1057], code: 5111, limit: 10 }))
      .matches[0]?.units,
  ).toEqual(['An', 'head', 'other']);
});
