/**
 * @fileoverview Pagination for `faostat_resolve_codes` (#7). The tool capped
 * matches at `limit` and disclosed `truncated`/`totalMatches` but exposed no
 * cursor, so an agent could not enumerate the omitted tail of a large
 * area/item/element listing. These lock the fix: an optional zero-based `offset`
 * pages every branch, `nextOffset` is returned (in both client surfaces via
 * enrichment) whenever more remain, consecutive pages are gap- and
 * duplicate-free, an FTS query pages stably across calls, and an exact-code
 * lookup stays single-page. Areas (unscoped by #8) exercise the pure pagination
 * path; a mid-size synthetic domain supplies enough codes to truncate. A listing's
 * notices are worded as a listing; a blank or `*` query lists, a query made only of
 * quotes, parentheses, asterisks, and whitespace fails `invalid_query`, and any other query that
 * leaves no word matches nothing (#67). Notices name the caller's text escaped.
 * Area matches carry their stored M49 code, and `m49_code` looks areas up by it:
 * zero-padded, exact, every match on one page, never beside `code` or `code_text`
 * or off the area dimension (#65).
 * @module tests/tools/resolve-codes-pagination
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withStrictCountInputs } from '@/mcp-server/tools/count-input.js';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
  fixtureM49,
} from '../fixtures/synthetic-domain.js';

/** Seven country areas (codes 1–7, all named "Country N") — enough to page at limit 3. */
const COUNTRY_COUNT = 7;

/** One call's two surfaces. */
async function wire(input: Omit<z.input<typeof resolveCodesTool.input>, 'domain'>) {
  const result = await runToolContract(resolveCodesTool, { domain: FIXTURE_DOMAIN, ...input });
  return {
    result,
    structured: result.structuredContent as Record<string, unknown> & {
      matches: { code: number | null; m49_code?: string }[];
    },
    text: result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
  };
}

describe('faostat_resolve_codes pagination (#7)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-resolve-page-'));
    const { zip } = buildMidSizeDomainZip({ countryCount: COUNTRY_COUNT });
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

  /** Run the tool with a fresh context; return the result plus its enrichment. */
  async function resolve(input: Record<string, unknown>) {
    const ctx = createMockContext({ tenantId: 't', errors: resolveCodesTool.errors });
    const result = await resolveCodesTool.handler(resolveCodesTool.input.parse(input), ctx);
    return { result, enrichment: getEnrichment(ctx) };
  }

  it('pages a capped list-all with nextOffset + a continue notice, no gaps or duplicates', async () => {
    const page1 = await resolve({ domain: FIXTURE_DOMAIN, dimension: 'area', limit: 3, offset: 0 });
    expect(page1.result.matches.map((m) => m.code)).toEqual([1, 2, 3]);
    expect(page1.enrichment.totalMatches).toBe(COUNTRY_COUNT);
    expect(page1.enrichment.truncated).toBe(true);
    expect(page1.enrichment.nextOffset).toBe(3);
    // The continue notice names the offset to resume at.
    expect(page1.enrichment.notice).toMatch(/offset 3/);
    expect(page1.enrichment.notice).toMatch(/next page/i);

    const page2 = await resolve({ domain: FIXTURE_DOMAIN, dimension: 'area', limit: 3, offset: 3 });
    expect(page2.result.matches.map((m) => m.code)).toEqual([4, 5, 6]);
    expect(page2.enrichment.nextOffset).toBe(6);

    // The final page drains the tail and stops paging.
    const page3 = await resolve({ domain: FIXTURE_DOMAIN, dimension: 'area', limit: 3, offset: 6 });
    expect(page3.result.matches.map((m) => m.code)).toEqual([7]);
    expect(page3.enrichment.truncated).toBe(false);
    expect(page3.enrichment.nextOffset).toBeUndefined();

    // Consecutive pages tile the full set exactly — no gaps, no duplicates.
    const all = [page1, page2, page3].flatMap((p) => p.result.matches.map((m) => m.code));
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('pages a capped FTS query stably across two calls', async () => {
    // "country" prefix-matches all seven area labels; rank ties break on rowid, so
    // the relevance order is stable and the windows do not overlap.
    const page1 = await resolve({
      domain: FIXTURE_DOMAIN,
      dimension: 'area',
      query: 'country',
      limit: 3,
      offset: 0,
    });
    expect(page1.result.matches).toHaveLength(3);
    expect(page1.enrichment.totalMatches).toBe(COUNTRY_COUNT);
    expect(page1.enrichment.truncated).toBe(true);
    expect(page1.enrichment.nextOffset).toBe(3);

    const page2 = await resolve({
      domain: FIXTURE_DOMAIN,
      dimension: 'area',
      query: 'country',
      limit: 3,
      offset: 3,
    });
    const p1 = page1.result.matches.map((m) => m.code);
    const p2 = page2.result.matches.map((m) => m.code);
    expect(p2).toHaveLength(3);
    // No code appears on both pages.
    expect(p1.filter((c) => p2.includes(c))).toEqual([]);
  });

  it('pages a capped name_contains (LIKE) query', async () => {
    const page1 = await resolve({
      domain: FIXTURE_DOMAIN,
      dimension: 'area',
      name_contains: 'Country',
      limit: 3,
      offset: 0,
    });
    expect(page1.result.matches.map((m) => m.code)).toEqual([1, 2, 3]);
    expect(page1.enrichment.nextOffset).toBe(3);

    const page2 = await resolve({
      domain: FIXTURE_DOMAIN,
      dimension: 'area',
      name_contains: 'Country',
      limit: 3,
      offset: 3,
    });
    expect(page2.result.matches.map((m) => m.code)).toEqual([4, 5, 6]);
  });

  it('keeps an exact-code lookup single-page (no pagination fields)', async () => {
    const { result, enrichment } = await resolve({
      domain: FIXTURE_DOMAIN,
      dimension: 'area',
      code: 5,
    });
    expect(result.matches).toEqual([
      { code: 5, code_text: null, name: 'Country 5', kind: 'country', m49_code: '005' },
    ]);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.nextOffset).toBeUndefined();
  });

  it.each([{ code: 999999 }, { name_contains: 'no-such-country' }, { offset: COUNTRY_COUNT }])(
    'renders empty results and precise retrieval guidance on both surfaces: %j',
    async (filter) => {
      const wire = await runToolContract(resolveCodesTool, {
        domain: FIXTURE_DOMAIN,
        dimension: 'area',
        ...filter,
      });
      expect(wire.isError).not.toBe(true);
      expect(wire.structuredContent).toMatchObject({ matches: [], truncated: false });
      const text = wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain('No area codes matched in QCL');
      expect(text).toContain('offset' in filter ? 'past the 7 area' : 'No area matched');
      if ('code' in filter) expect(text).toContain('code 999999');
      if ('name_contains' in filter) expect(text).toContain('name containing "no-such-country"');
    },
  );

  it('formats country kinds and item CPC crosswalks without changing raw matches', async () => {
    for (const dimension of ['area', 'item'] as const) {
      const wire = await runToolContract(resolveCodesTool, { domain: FIXTURE_DOMAIN, dimension });
      expect(wire.isError).not.toBe(true);
      const { matches } = wire.structuredContent as {
        matches: { code: number; name: string; kind: string | null; cpc_code?: string }[];
      };
      expect(matches.length).toBeGreaterThan(0);
      const text = wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      for (const match of matches) {
        expect(text).toContain(`**${match.code}** — ${match.name}`);
        if (dimension === 'area') expect(text).toContain('[country]');
        else {
          expect(match.kind).toBeNull();
          expect(match.cpc_code).toBeDefined();
          expect(text).toContain(`(CPC ${match.cpc_code})`);
        }
      }
    }
  });

  it('returns the declared index-not-ready recovery before a first sync', async () => {
    await mirror.close();
    mirror = initFaostatMirror({ dir: join(dir, 'cold'), domains: [FIXTURE_DOMAIN] });
    const wire = await runToolContract(resolveCodesTool, {
      domain: FIXTURE_DOMAIN,
      dimension: 'item',
    });
    expect(wire.isError).toBe(true);
    expect(wire.structuredContent).toMatchObject({
      error: { data: { reason: 'index_not_ready' } },
    });
    const text = wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(
      resolveCodesTool.errors?.find((entry) => entry.reason === 'index_not_ready')?.recovery,
    );
  });
});

describe('faostat_resolve_codes query reading (#67)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-resolve-query-'));
    const { zip } = buildMidSizeDomainZip({ countryCount: COUNTRY_COUNT });
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

  const invalidQuery = resolveCodesTool.errors?.find((entry) => entry.reason === 'invalid_query');

  it.each([
    ['area', '()', '"()"'],
    ['item', '()', '"()"'],
    ['element', '()', '"()"'],
    ['area', '""', '"\\"\\""'],
    ['item', '(*)', '"(*)"'],
    ['element', '**', '"**"'],
    ['item', '* *', '"* *"'],
  ] as const)(
    'fails a %s query of %j with invalid_query on both surfaces, naming it as %s',
    async (dimension, query, quoted) => {
      const { result, structured, text } = await wire({ dimension, query });
      expect(result.isError).toBe(true);
      expect(structured).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: `query ${quoted} holds no search term: it is made only of quotes, parentheses, asterisks, and whitespace.`,
          data: { reason: 'invalid_query', recovery: { hint: invalidQuery?.recovery } },
        },
      });
      // content[] carries the message markdown-escaped.
      expect(text).toContain('holds no search term');
      expect(text).toContain('quotes, parentheses, asterisks, and whitespace');
      expect(text).toContain(invalidQuery?.recovery);
      expect(text).toContain('invalid_query');
    },
  );

  it('fails an unusable query beside name_contains rather than filtering by name', async () => {
    const { result, structured } = await wire({
      dimension: 'area',
      query: '()',
      name_contains: 'Country',
    });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({ error: { data: { reason: 'invalid_query' } } });
  });

  it.each(['', '*', ' * ', '   '])(
    'lists the dimension for query %j with a notice worded as a listing',
    async (query) => {
      const { structured, text } = await wire({ dimension: 'area', query, limit: 3 });
      expect(structured.matches.map((m) => m.code)).toEqual([1, 2, 3]);
      const notice =
        'Listing area codes 1–3 of 7. Call again with offset 3 to fetch the next page.';
      expect(structured).toMatchObject({ totalMatches: COUNTRY_COUNT, nextOffset: 3, notice });
      expect(text).toContain(`> ${notice}`);
    },
  );

  it('keeps match wording for a query that searches', async () => {
    const { structured } = await wire({ dimension: 'area', query: 'country', limit: 3 });
    expect(structured.notice).toBe(
      'Showing area matches 1–3 of 7. Call again with offset 3 to fetch the next page.',
    );
  });

  it('words an offset past the end of a listing as a listing', async () => {
    const { structured, text } = await wire({ dimension: 'area', query: '*', offset: 7 });
    const notice =
      'Offset 7 is past the 7 area code(s) listed in domain QCL. Lower offset (0-based) to page back through the results.';
    expect(structured).toMatchObject({ matches: [], totalMatches: COUNTRY_COUNT, notice });
    expect(text).toContain(`> ${notice}`);
  });

  it('applies name_contains when query reads as omitted', async () => {
    const { structured } = await wire({
      dimension: 'area',
      query: '*',
      name_contains: 'Country 5',
    });
    expect(structured.matches.map((m) => m.code)).toEqual([5]);
  });

  it('lets an exact code win over an unusable query, unread', async () => {
    const { result, structured } = await wire({ dimension: 'area', code: 5, query: '()' });
    expect(result.isError).not.toBe(true);
    expect(structured.matches.map((m) => m.code)).toEqual([5]);
  });

  it.each([
    ['\u0000', '"\\u0000"'],
    ['\u0007', '"\\u0007"'],
    ['\u0085', '"\\u0085"'],
    ['(\u0007)', '"(\\u0007)"'],
  ])(
    'answers a query of %j, which leaves no word, with no matches on both surfaces, naming it as %s',
    async (query, quoted) => {
      const { result, structured, text } = await wire({ dimension: 'item', query });
      expect(result.isError).not.toBe(true);
      const notice = `No item matched query ${quoted} in domain QCL. Broaden the term, check spelling, or omit query to list all item codes.`;
      expect(structured).toMatchObject({ matches: [], totalMatches: 0, truncated: false, notice });
      expect(text).toContain('_No item codes matched in QCL._');
      expect(text).toContain(`> ${notice}`);
      expect(text.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    },
  );

  it('answers a query with no word beside name_contains with no matches', async () => {
    const { result, structured } = await wire({
      dimension: 'area',
      query: '\u0000',
      name_contains: 'Country',
    });
    expect(result.isError).not.toBe(true);
    expect(structured).toMatchObject({ matches: [], totalMatches: 0 });
  });

  it.each([
    [
      { name_contains: 'Country\u0007' },
      'No area matched name containing "Country\\u0007" in domain QCL. Broaden the term, check spelling, or omit name_contains to list all area codes.',
    ],
    [
      { query: 'country\u0085', offset: COUNTRY_COUNT },
      'Offset 7 is past the 7 area match(es) for query "country\\u0085" in domain QCL. Lower offset (0-based) to page back through the results.',
    ],
  ])(
    'names the caller’s text escaped in the notice on both surfaces: %j',
    async (input, notice) => {
      const { result, structured, text } = await wire({ dimension: 'area', ...input });
      expect(result.isError).not.toBe(true);
      expect(structured).toMatchObject({ matches: [], notice });
      expect(text).toContain(`> ${notice}`);
      expect(text.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    },
  );

  it.each<[Parameters<typeof wire>[0], string]>([
    [
      { dimension: 'area', code: 9999 },
      'No area matched code 9999 in domain QCL. Omit code to list all area codes, or search by name with query.',
    ],
    [
      { dimension: 'item', code_text: '210400x' },
      'No item matched code_text "210400X" in domain QCL. Omit code_text to list all item codes, or search by name with query.',
    ],
  ])(
    'names the exact selector a call used in its no-match recovery on both surfaces: %j',
    async (input, notice) => {
      const { result, structured, text } = await wire(input);
      expect(result.isError).not.toBe(true);
      expect(structured).toMatchObject({ matches: [], totalMatches: 0, notice });
      expect(text).toContain(`> ${notice}`);
    },
  );

  it('reads a control character in a query as a word separator on both surfaces', async () => {
    const { result, structured, text } = await wire({ dimension: 'item', query: 'wheat\u0000' });
    expect(result.isError).not.toBe(true);
    expect(structured.matches.map((m) => m.code)).toEqual([15]);
    expect(text).toContain('**15** — Wheat');
  });

  it.each([
    ['Country ', [1, 2, 3, 4, 5, 6, 7]],
    [' 5', [5]],
    ['  ', []],
  ])('keeps name_contains %j a literal substring filter', async (nameContains, codes) => {
    const { structured } = await wire({ dimension: 'area', name_contains: nameContains });
    expect(structured.matches.map((m) => m.code)).toEqual(codes);
  });
});

describe('faostat_resolve_codes M49 codes (#65)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  /** Areas beside the fixture's Country 1–7 (M49 001–007): real codes, a dotted one, a shared one, none. */
  const EXTRA_AREAS = [
    { area_code: 231, area_m49: '840', area: 'United States of America' },
    { area_code: 11, area_m49: '040', area: 'Austria' },
    { area_code: 51000, area_m49: '002.03', area: 'Africa (excluding intra-trade)' },
    { area_code: 9002, area_m49: '950', area: 'Shared B' },
    { area_code: 9001, area_m49: '950', area: 'Shared A' },
    { area_code: 8000, area_m49: null, area: 'Uncoded' },
  ];
  /** Every area's stored M49 code; Uncoded stores none. */
  const STORED = new Map<number, string | null>([
    ...Array.from({ length: COUNTRY_COUNT }, (_, i): [number, string] => [
      i + 1,
      fixtureM49(i + 1),
    ]),
    ...EXTRA_AREAS.map((a): [number, string | null] => [a.area_code, a.area_m49]),
  ]);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-resolve-m49-'));
    const { zip } = buildMidSizeDomainZip({ countryCount: COUNTRY_COUNT });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 1 << 16)),
    );
    mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(),
    });
    await mirror.dimensions.upsertAreas(
      EXTRA_AREAS.map((a) => ({ ...a, kind: 'country' as const })),
    );
  });

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const invalidM49 = resolveCodesTool.errors?.find(
    (entry) => entry.reason === 'invalid_m49_selector',
  );

  it.each([
    ['840', '840', [231]],
    ['40', '040', [11]],
    ['040', '040', [11]],
    ['5', '005', [5]],
    ['2.03', '002.03', [51000]],
    ['002.03', '002.03', [51000]],
    // Exact: the integer code never matches the dotted extension that starts with it.
    ['2', '002', [2]],
    // Every area carrying the code, in area-code order.
    ['950', '950', [9001, 9002]],
  ] as const)(
    'm49_code %j reads as %j and returns areas %j on both surfaces',
    async (m49, padded, codes) => {
      const { result, structured, text } = await wire({ dimension: 'area', m49_code: m49 });
      expect(result.isError).not.toBe(true);
      expect(structured.matches.map((m) => m.code)).toEqual(codes);
      expect(structured.matches.every((m) => m.m49_code === padded)).toBe(true);
      expect(structured).toMatchObject({ totalMatches: codes.length, truncated: false });
      expect(structured).not.toHaveProperty('nextOffset');
      expect(structured).not.toHaveProperty('notice');
      for (const code of codes)
        expect(text).toMatch(
          new RegExp(`\\*\\*${code}\\*\\* — .* \\(M49 ${padded.replace('.', '\\.')}\\)`),
        );
    },
  );

  it('answers an M49 code no area carries with no matches and a notice naming it', async () => {
    const { result, structured, text } = await wire({ dimension: 'area', m49_code: '99' });
    expect(result.isError).not.toBe(true);
    const notice =
      'No area matched m49_code "099" in domain QCL. List areas without m49_code, or search them by name with query, to read the m49_code each one carries.';
    expect(structured).toMatchObject({ matches: [], totalMatches: 0, truncated: false, notice });
    expect(text).toContain('_No area codes matched in QCL._');
    expect(text).toContain(`> ${notice}`);
  });

  it.each(['84a', '1234', '840.', '.5', ' 840', '840 ', '', '8-4', '+84', '١٢٣', '84.0a'])(
    'rejects m49_code %j at argument validation',
    async (m49) => {
      const parse = (code: string) =>
        resolveCodesTool.input.safeParse({
          domain: FIXTURE_DOMAIN,
          dimension: 'area',
          m49_code: code,
        }).success;
      // The field is accepted; this value's shape is what fails.
      expect(parse('840')).toBe(true);
      expect(parse(m49)).toBe(false);
      const { result, structured } = await wire({ dimension: 'area', m49_code: m49 });
      expect(result.isError).toBe(true);
      expect(structured).toMatchObject({ error: { code: JsonRpcErrorCode.InvalidParams } });
    },
  );

  it.each([
    { dimension: 'item', m49_code: '840' },
    { dimension: 'element', m49_code: '840' },
    { dimension: 'area', code: 231, m49_code: '840' },
    { dimension: 'area', code_text: '210400F', m49_code: '840' },
    { dimension: 'item', code_text: '210400F', m49_code: '840' },
  ] as const)('fails %j with invalid_m49_selector on both surfaces', async (input) => {
    const { result, structured, text } = await wire(input);
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        message:
          'm49_code requires dimension area and must not be combined with code or code_text.',
        data: { reason: 'invalid_m49_selector', recovery: { hint: invalidM49?.recovery } },
      },
    });
    expect(text).toContain('invalid_m49_selector');
    expect(text).toContain(invalidM49?.recovery);
  });

  it('declares invalid_m49_selector as an InvalidParams contract entry', () => {
    expect(invalidM49).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(invalidM49).not.toHaveProperty('retryable');
  });

  it.each([
    { query: 'country', name_contains: 'Country' },
    { query: '()' },
    { name_contains: 'Shared' },
  ])('lets m49_code win over %j, which stays unread', async (selectors) => {
    const { result, structured } = await wire({ dimension: 'area', m49_code: '40', ...selectors });
    expect(result.isError).not.toBe(true);
    expect(structured.matches.map((m) => m.code)).toEqual([11]);
  });

  it('answers on one page whatever limit and offset say, and never clamps limit', async () => {
    for (const paging of [{ limit: 1 }, { limit: 500 }, { offset: 9 }, { limit: 1, offset: 1 }]) {
      const { result, structured, text } = await wire({
        dimension: 'area',
        m49_code: '950',
        ...paging,
      });
      expect(result.isError).not.toBe(true);
      expect(structured.matches.map((m) => m.code)).toEqual([9001, 9002]);
      expect(structured).toMatchObject({ totalMatches: 2, truncated: false });
      for (const field of ['nextOffset', 'requestedLimit', 'effectiveLimit', 'notice'])
        expect(structured).not.toHaveProperty(field);
      expect(text).not.toContain('cap;');
    }
  });

  it.each([
    [{ code: 231 }, [231]],
    [{ query: 'austria' }, [11]],
    [{ name_contains: 'Country 5' }, [5]],
    [{ query: 'uncoded' }, [8000]],
  ] as const)(
    'carries each area match its stored M49 code on both surfaces: %j',
    async (selector, codes) => {
      const { structured, text } = await wire({ dimension: 'area', ...selector });
      expect(structured.matches.map((m) => m.code)).toEqual(codes);
      for (const match of structured.matches) {
        const stored = STORED.get(match.code as number);
        if (stored === null) {
          expect(match).not.toHaveProperty('m49_code');
          expect(text).not.toContain('(M49');
        } else {
          expect(match.m49_code).toBe(stored);
          expect(text).toContain(`(M49 ${stored})`);
        }
      }
    },
  );

  it('carries the M49 code on every page of a paged listing', async () => {
    const seen: { code: number | null; m49_code?: string }[] = [];
    const texts: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const { structured, text } = await wire({ dimension: 'area', limit: 5, offset });
      seen.push(...structured.matches);
      texts.push(text);
      offset = structured.nextOffset as number | undefined;
    }
    expect(texts).toHaveLength(3);
    expect(seen.map((m) => m.code)).toEqual([...STORED.keys()].sort((a, b) => a - b));
    for (const match of seen) {
      const stored = STORED.get(match.code as number);
      if (stored === null) expect(match).not.toHaveProperty('m49_code');
      else expect(match.m49_code).toBe(stored);
    }
    const lines = texts.join('\n').split('\n');
    expect(lines.filter((line) => line.includes('(M49 '))).toHaveLength(STORED.size - 1);
    expect(lines.find((line) => line.startsWith('- **8000**'))).toBe(
      '- **8000** — Uncoded [aggregate]',
    );
  });

  it('carries no M49 code on item or element matches', async () => {
    for (const dimension of ['item', 'element'] as const) {
      const { structured, text } = await wire({ dimension });
      expect(structured.matches.length).toBeGreaterThan(0);
      for (const match of structured.matches) expect(match).not.toHaveProperty('m49_code');
      expect(text).not.toContain('(M49');
    }
  });
});

describe('faostat_resolve_codes limit above the 200 cap (#56)', () => {
  /** More areas than the cap, so a page at the cap leaves another page behind. */
  const WIDE_COUNTRY_COUNT = 205;
  let dir: string;
  let mirror: FaostatMirror;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-resolve-clamp-'));
    const { zip } = buildMidSizeDomainZip({ countryCount: WIDE_COUNTRY_COUNT });
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

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The tool's result on both surfaces. */
  async function wire(limit: number) {
    const result = await runToolContract(resolveCodesTool, {
      domain: FIXTURE_DOMAIN,
      dimension: 'area',
      limit,
    });
    expect(result.isError).not.toBe(true);
    return {
      structured: result.structuredContent as Record<string, unknown> & { matches: unknown[] },
      text: result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
    };
  }

  it('serves limit 500 at 200 and names the next page on both surfaces', async () => {
    const { structured, text } = await wire(500);
    expect(structured.matches).toHaveLength(200);
    const notice =
      'limit 500 is above the 200 cap; returned up to 200. Listing area codes 1–200 of 205. Call again with offset 200 to fetch the next page.';
    expect(structured).toMatchObject({
      requestedLimit: 500,
      effectiveLimit: 200,
      totalMatches: WIDE_COUNTRY_COUNT,
      truncated: true,
      nextOffset: 200,
      notice,
    });
    expect(text).toContain('**200 area code(s) in QCL:**');
    expect(text).toContain('**requestedLimit:** 500');
    expect(text).toContain('**effectiveLimit:** 200');
    expect(text).toContain(`> ${notice}`);
  });

  it('carries no clamp fields at the cap', async () => {
    const { structured, text } = await wire(200);
    expect(structured.matches).toHaveLength(200);
    expect(structured).not.toHaveProperty('requestedLimit');
    expect(structured).not.toHaveProperty('effectiveLimit');
    expect(structured.notice).toBe(
      'Listing area codes 1–200 of 205. Call again with offset 200 to fetch the next page.',
    );
    expect(text).not.toContain('cap;');
  });

  it('does not clamp an exact-code lookup, where limit never binds', async () => {
    const result = await runToolContract(resolveCodesTool, {
      domain: FIXTURE_DOMAIN,
      dimension: 'area',
      code: 5,
      limit: 500,
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown> & {
      matches: { code: number }[];
    };
    expect(structured.matches.map((m) => m.code)).toEqual([5]);
    expect(structured).not.toHaveProperty('requestedLimit');
    expect(structured).not.toHaveProperty('effectiveLimit');
    expect(structured).not.toHaveProperty('notice');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).not.toContain('cap;');
  });

  it('advertises limit with no maximum, and with maximum 200 when registered strict', () => {
    const limitOf = (definition: AnyToolDefinition) =>
      z.toJSONSchema(definition.input, { io: 'input' }).properties?.limit;
    expect(limitOf(resolveCodesTool)).toEqual({
      type: 'integer',
      minimum: 1,
      default: 50,
      description: expect.stringContaining('at most 200 per call'),
    });
    expect(limitOf(withStrictCountInputs(resolveCodesTool))).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 50,
    });
  });
});
