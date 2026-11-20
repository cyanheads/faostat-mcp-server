/**
 * @fileoverview The dimension store's full-text search helpers (#67), run end to end
 * through `DimensionsStore.resolve` against real FAOSTAT labels, so each case pins what
 * a caller gets back rather than the MATCH string; `classifySearchQuery`, the one rule
 * both search tools read a query by; and `quoteSearchText`, the form the tools name a
 * caller's text in. The regression table holds the answers search gave before the
 * classifier existed; they must not move, and a repeated word changes neither the items
 * nor their order. Search time is linear in the query's length, and a long query returns
 * the items one FTS5 statement over the same words returns, in its order.
 * @module tests/services/fts-query
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { openSqliteHandle, type SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchDimension } from '@/services/faostat-mirror/dimension-search.js';
import {
  classifySearchQuery,
  DIMENSIONS_DB_FILE,
  DimensionsStore,
  quoteSearchText,
} from '@/services/faostat-mirror/dimensions-store.js';
import { ReadPool } from '@/services/faostat-mirror/read-pool.js';

/** Real QCL and FS item labels; the codes are only identities for the assertions. */
const ITEMS = [
  [15, 'Wheat'],
  [27, 'Rice'],
  [56, 'Maize (corn)'],
  [60, 'Oil of maize'],
  [89, 'Buckwheat'],
  [270, 'Rape or colza seed'],
  [372, 'Lettuce and chicory'],
  [446, 'Green corn (maize)'],
  [656, 'Coffee; green'],
  [657, 'Coffee; decaffeinated or roasted'],
  [
    675,
    'Green tea (not fermented); black tea (fermented) and partly fermented tea; in immediate packings of a content not exceeding 3 kg',
  ],
  [21032, 'Number of obese adults (18 years and older) (million)'],
  /** The shorter label ranks first on "beans", the longer one on the "b" prefix it holds twice. */
  [176, 'Beans; dry'],
  [203, 'Bambara beans; dry'],
] as const;

/** Real FAOSTAT area labels, diacritics and apostrophes included. */
const AREAS = [
  [107, "Côte d'Ivoire"],
  [213, 'Turkmenistan'],
  [223, 'Türkiye'],
  [224, 'Turks and Caicos Islands'],
] as const;

let dir: string;
let store: DimensionsStore;
const reads = new ReadPool();
/** A second connection to the store's database, for the single-statement answer. */
let raw: SqliteHandle;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'faostat-fts-query-'));
  store = new DimensionsStore(dir, reads);
  await store.upsertItems(
    ITEMS.map(([code, item]) => ({ item_code: code, item_code_text: null, item, cpc_code: null })),
  );
  await store.upsertAreas(
    AREAS.map(([code, area]) => ({ area_code: code, area_m49: null, area, kind: 'country' })),
  );
  raw = await openSqliteHandle(join(dir, DIMENSIONS_DB_FILE));
});

afterAll(async () => {
  raw.close();
  await reads.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('dispatches text searches off-thread and cancels queued and running jobs', async () => {
  const file = join(dir, DIMENSIONS_DB_FILE);
  const exact = new AbortController();
  const fallback = new AbortController();
  const queued = new AbortController();
  const jobs = [
    reads.resolveDimension(
      { file, dimension: 'item', options: { query: 'Wheat', preferExact: true, limit: 1 } },
      exact.signal,
    ),
    reads.resolveDimension(
      { file, dimension: 'item', options: { query: 'whe', preferExact: true, limit: 1 } },
      fallback.signal,
    ),
    reads.resolveDimension(
      { file, dimension: 'area', options: { query: 'turk', limit: 1 } },
      queued.signal,
    ),
  ];
  const settled = Promise.allSettled(jobs);
  await Promise.resolve();
  expect(reads.stats()).toMatchObject({ busy: 2, queued: 1 });
  queued.abort();
  exact.abort();
  fallback.abort();
  for (const outcome of await settled) {
    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: { code: JsonRpcErrorCode.RequestCancelled },
    });
  }
  await expect(
    store.resolve('item', { query: 'Wheat', preferExact: true, limit: 1 }),
  ).resolves.toMatchObject({ matches: [{ code: 15 }], total: 1 });
});

/** The codes a full-text query returns in one dimension, sorted. */
async function search(dimension: 'area' | 'item', query: string): Promise<number[]> {
  const { matches, total } = await store.resolve(dimension, { query, limit: 50 });
  expect(total).toBe(matches.length);
  return matches.map((match) => Number(match.code)).sort((a, b) => a - b);
}

/** The item codes a full-text query returns, in the order it returns them. */
async function ordered(query: string): Promise<(number | null)[]> {
  return (await store.resolve('item', { query, limit: 50 })).matches.map((match) => match.code);
}

/** Separator marks, one per base-36 digit. */
const MARKS = [..."!#$%&',-./:;<=>?@[\\]^_`{|}~+¡§¶·¿‐–—"];

/** The `i`th variant of `word`: it followed by separator marks. */
function spelling(word: string, i: number): string {
  return `${word}${[...(i + 1).toString(36)].map((digit) => MARKS[Number.parseInt(digit, 36)]).join('')}`;
}

/** The first `count` variants of `word`. */
function spellings(word: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => spelling(word, i));
}

/** Words joined by spaces until the text reaches `chars` characters. */
function wordsOf(chars: number, word: (i: number) => string): string {
  const words: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const next = word(i);
    words.push(next);
    length += next.length + 1;
  }
  return words.join(' ');
}

describe('full-text search answers (regression)', () => {
  it.each([
    ['?', []],
    ['-', []],
    ['_', []],
    ['​', []],
    ['rice*', [27]],
    ['(maize)', [56, 60, 446]],
    ['coffee, green', [656]],
    ['a', [372, 675, 21032]],
    ['1', [21032]],
    ['AND', [372, 675, 21032]],
    ['OR', [270, 657]],
    ['NOT', [675]],
    ['? wheat', [15]],
    ['-wheat', [15]],
    ['"wheat"', [15]],
    ['*wheat*', [15]],
    ['wheat​', [15]],
    ['小麦', []],
    ['wheat wheat WHEAT', [15]],
    ['coffee green Coffee GREEN', [656]],
    ['maize corn maize', [56, 446]],
  ] as const)('item query %j returns %j', async (query, codes) => {
    expect(await search('item', query)).toEqual(codes);
  });

  it.each([
    ["Côte d'Ivoire", [107]],
    ['Türkiye', [223]],
    ['turk', [213, 223, 224]],
  ] as const)('area query %j returns %j', async (query, codes) => {
    expect(await search('area', query)).toEqual(codes);
  });

  it.each([
    ['beans b B', 'beans b', [176, 203]],
    ['wheat wheat WHEAT', 'wheat', [15]],
    ['coffee green Coffee GREEN', 'coffee green', [656]],
    ['maize corn maize', 'maize corn', [56, 446]],
  ] as const)(
    'item query %j returns the items of %j, in its order: %j',
    async (query, distinct, codes) => {
      expect(await ordered(distinct)).toEqual(codes);
      expect(await ordered(query)).toEqual(codes);
    },
  );
});

describe('control characters in a search (#67)', () => {
  it.each([
    ['wheat\u0000', [15]],
    ['\u0000wheat', [15]],
    ['coffee\u0000green', [656]],
    ['rice\u0007', [27]],
    ['coffee\u001fgreen', [656]],
    ['wheat\u007f', [15]],
    ['(maize)\u0085', [56, 60, 446]],
  ] as const)('reads %j as separated words, returning %j', async (query, codes) => {
    expect(await search('item', query)).toEqual(codes);
  });

  it.each([
    ['\u0000'],
    ['\u0007'],
    ['\u001f'],
    ['\u007f'],
    ['\u0085'],
    ['\u0000\u0007'],
    ['(\u0007)'],
    ['*\u0000'],
    ['"\u0085"'],
  ])('answers a search of %j, which leaves no word, with no matches', async (query) => {
    for (const dimension of ['area', 'item'] as const)
      expect(await store.resolve(dimension, { query, limit: 50 })).toEqual({
        matches: [],
        total: 0,
      });
  });

  it('answers a search with no word with no matches beside name_contains and a scope', async () => {
    expect(
      await store.resolve('item', {
        query: '\u0007',
        nameContains: 'Wheat',
        domainCodes: [15, 89],
        limit: 50,
      }),
    ).toEqual({ matches: [], total: 0 });
  });
});

describe('classifySearchQuery (#67)', () => {
  it.each([[undefined], [''], [' '], ['\t\r\n'], [' 　'], ['*'], [' * '], ['\t*\n']])(
    'reads %j as omitted',
    (query) => {
      expect(classifySearchQuery(query)).toEqual({ kind: 'omitted' });
    },
  );

  it.each([['()'], ['""'], ['(*)'], ['**'], ['* *'], [' ( ) '], ['(\t)'], ['"\n"'], ['*　*']])(
    'rejects %j as invalid',
    (query) => {
      expect(classifySearchQuery(query)).toEqual({ kind: 'invalid', query });
    },
  );

  it.each([
    ['?'],
    ['-'],
    ['_'],
    ['​'],
    ['wheat'],
    ['  wheat  '],
    ['wheat\u0000'],
    ['"wheat"'],
    ['*wheat*'],
    ['(maize)'],
    ['a'],
    ['小麦'],
    ['\u0000'],
    ['\u0007'],
    ['\u001f'],
    ['\u007f'],
    ['\u0085'],
    ['*\u0000'],
    ['(\u0001)'],
    ['(\u0007)'],
    ['"\u0085"'],
  ])('searches %j as given', (query) => {
    expect(classifySearchQuery(query)).toEqual({ kind: 'search', query });
  });
});

describe('quoteSearchText', () => {
  it.each([
    ['wheat', '"wheat"'],
    ['coffee, green', '"coffee, green"'],
    ["Côte d'Ivoire", `"Côte d'Ivoire"`],
    ['小麦', '"小麦"'],
    ['​', '"​"'],
    ['()', '"()"'],
    ['""', '"\\"\\""'],
    ['a\\b', '"a\\\\b"'],
    ['\u0000', '"\\u0000"'],
    ['wheat\u0007', '"wheat\\u0007"'],
    ['\t\r\n', '"\\t\\r\\n"'],
    ['\u007f', '"\\u007f"'],
    ['\u0085', '"\\u0085"'],
    ['\u009f', '"\\u009f"'],
    ['"\u0085"', '"\\"\\u0085\\""'],
  ])('names %j as %s', (text, quoted) => {
    expect(quoteSearchText(text)).toBe(quoted);
  });

  it('leaves no control character in the quoted form', () => {
    const every = String.fromCharCode(...Array.from({ length: 0xa0 }, (_, code) => code));
    expect(quoteSearchText(every)).not.toMatch(/\p{Cc}/u);
  });
});

describe('long queries return the single-statement answer', () => {
  /** Item codes one FTS5 statement over every word returns, in its order. */
  function singleStatement(words: string[]): number[] {
    const match = words.map((word) => `"${word.toLowerCase()}"*`).join(' ');
    const code = raw.prepare<{ item_code: number }>('SELECT item_code FROM items WHERE id = ?');
    return raw
      .prepare<{ rowid: number }>(
        'SELECT rowid FROM items_fts WHERE items_fts MATCH ? ORDER BY rank, rowid',
      )
      .all(match)
      .map((row) => code.get(row.rowid)?.item_code ?? -1);
  }

  /** Wheat's words, then rice: no item is both. */
  const WHEAT_THEN_RICE = [...spellings('wheat', 64), 'rice'];
  /** Maize and corn match 56 and 446, then oil matches only 60: no item is all three. */
  const MAIZE_CORN_THEN_OIL = [...spellings('maize', 64), ...spellings('corn', 64), 'oil'];
  /** "green" is the first 64 words' last and "corn" the next word; each narrows the answer. */
  const FIRST_BOUNDARY = [...spellings('co', 63), 'green', 'corn'];
  /** The same two words on either side of the second 64-word boundary. */
  const SECOND_BOUNDARY = [...spellings('co', 127), 'green', 'corn'];
  /** "beans" alone puts 176 first; with every "b" word, 203 comes first. */
  const BEANS_THEN_B = [...spellings('beans', 64), ...spellings('b', 192)];

  it.each([
    ['maize', spellings('maize', 300)],
    ['maize + corn', [...spellings('maize', 120), ...spellings('corn', 120)]],
    ['corn + maize + green', [...spellings('corn', 100), ...spellings('maize', 100), 'green']],
    ['wheat + nothing', [...spellings('wheat', 150), 'zzz']],
    ['nothing + wheat', ['zzz', ...spellings('wheat', 150)]],
    ['tea', ['green', ...spellings('tea', 200), 'kg']],
    ['wheat + rice, none', WHEAT_THEN_RICE],
    ['maize + corn + oil, none', MAIZE_CORN_THEN_OIL],
    ['co + green + corn across the first boundary', FIRST_BOUNDARY],
    ['co + green + corn across the second boundary', SECOND_BOUNDARY],
    ['beans + b, the order beans alone reverses', BEANS_THEN_B],
  ])('returns the single-statement items, in order: %s', async (_label, words) => {
    const expected = singleStatement(words);
    const { matches, total } = await store.resolve('item', { query: words.join(' '), limit: 50 });
    expect(matches.map((match) => match.code)).toEqual(expected);
    expect(total).toBe(expected.length);
  });

  it('pins the single-statement answers the cases above compare against', () => {
    expect(singleStatement(spellings('maize', 300))).toHaveLength(3);
    expect(singleStatement([...spellings('maize', 120), ...spellings('corn', 120)])).toHaveLength(
      2,
    );
    expect(singleStatement(['green', ...spellings('tea', 200), 'kg'])).toEqual([675]);
    expect(singleStatement(WHEAT_THEN_RICE)).toEqual([]);
    expect(singleStatement(MAIZE_CORN_THEN_OIL)).toEqual([]);
    expect(singleStatement(FIRST_BOUNDARY)).toEqual([446]);
    expect(singleStatement(SECOND_BOUNDARY)).toEqual([446]);
    // Without "green", or without "corn", more items match.
    expect(singleStatement([...spellings('co', 63), 'corn'])).toEqual([56, 446]);
    expect(singleStatement([...spellings('co', 63), 'green'])).toEqual([656, 446, 675]);
    expect(singleStatement(spellings('beans', 64))).toEqual([176, 203]);
    expect(singleStatement(BEANS_THEN_B)).toEqual([203, 176]);
  });

  it('pages a long query over the same ordered answer', async () => {
    const query = spellings('maize', 300).join(' ');
    const all = await store.resolve('item', { query, limit: 50 });
    const pages = [0, 1, 2].map((offset) => store.resolve('item', { query, offset, limit: 1 }));
    expect((await Promise.all(pages)).flatMap((page) => page.matches)).toEqual(all.matches);
  });

  it('scopes a long query to the domain codes', async () => {
    const query = spellings('maize', 300).join(' ');
    expect(
      (await store.resolve('item', { query, domainCodes: [60, 15], limit: 50 })).matches.map(
        (match) => match.code,
      ),
    ).toEqual([60]);
  });
});

/** Smallest timed input; each case doubles from here across a 64-fold span. */
const BASE_CHARS = 5_000;
const MAX_CHARS = 320_000;
/** Measurements per size; the least is kept, since a pause only ever adds time. */
const ROUNDS = 3;

/** Least CPU one measurement spans (µs), so a fast call is timed over many timer ticks. */
const MIN_BATCH_MICROS = 2_000;

/** Thread CPU (µs) per call of `run(text)`, over a batch that doubles until it spans {@link MIN_BATCH_MICROS}. */
async function cpuPerCall(run: (text: string) => unknown, text: string): Promise<number> {
  for (let batch = 1; ; batch *= 2) {
    const start = process.threadCpuUsage();
    for (let i = 0; i < batch; i++) await run(text);
    const used = process.threadCpuUsage(start);
    const micros = used.user + used.system;
    if (micros >= MIN_BATCH_MICROS) return micros / batch;
  }
}

/**
 * Assert `run`'s thread CPU grows linearly with its input: at each doubled size the
 * least of {@link ROUNDS} measurements stays under `microsPerChar` per character
 * (checked before the next size runs), and the least growth over the base size,
 * re-timed beside each size, stays under four times the span.
 */
async function expectLinearCpu(
  run: (text: string) => unknown,
  shape: (chars: number) => string,
  microsPerChar: number,
  maxChars = MAX_CHARS,
): Promise<void> {
  const base = shape(BASE_CHARS);
  let growth = Number.POSITIVE_INFINITY;
  for (let size = BASE_CHARS * 2; size <= maxChars; size *= 2) {
    const text = shape(size);
    let least = Number.POSITIVE_INFINITY;
    growth = Number.POSITIVE_INFINITY;
    for (let round = 0; round < ROUNDS; round++) {
      const baseMicros = await cpuPerCall(run, base);
      const micros = await cpuPerCall(run, text);
      least = Math.min(least, micros);
      growth = Math.min(growth, micros / baseMicros);
    }
    expect(least, `${size} characters`).toBeLessThan(microsPerChar * text.length);
  }
  expect(growth).toBeLessThan((4 * maxChars) / BASE_CHARS);
}

/** Inputs for the linear-time cases; the last two carry the line-break shapes. */
const SHAPES: ((chars: number) => string)[] = [
  (chars) => 'wheat '.repeat(chars / 6),
  (chars) => wordsOf(chars, (i) => `zq${i.toString(36)}`),
  (chars) => wordsOf(chars, (i) => spelling('wheat', i)),
  (chars) => `${'§1 x'.repeat(chars / 4)}\ny`,
  (chars) => '  \r\n'.repeat(chars / 4),
];

/** {@link SHAPES} plus the two that scan the classifier's whole input. */
const TEXT_SHAPES: ((chars: number) => string)[] = [
  ...SHAPES,
  (chars) => `${'()'.repeat(chars / 2)}x`,
  (chars) => `${'(  \r\n'.repeat(chars / 5)})`,
];

/** Per-character CPU ceiling (µs) for one resolve call at any timed size, either runtime. */
const RESOLVE_MICROS_PER_CHAR = 3;

describe('search time is linear in the query length', () => {
  it.each(SHAPES.map((shape, i) => [i + 1, shape] as const))(
    'resolve, case %i',
    async (_case, shape) => {
      await expectLinearCpu(
        (query) => searchDimension(raw, 'item', { query, limit: 50 }),
        shape,
        RESOLVE_MICROS_PER_CHAR,
      );
    },
    0,
  );

  it.each(SHAPES.map((shape, i) => [i + 1, shape] as const))(
    'resolve preferring an exact label, case %i',
    async (_case, shape) => {
      await expectLinearCpu(
        (query) => searchDimension(raw, 'item', { query, preferExact: true, limit: 5 }),
        shape,
        RESOLVE_MICROS_PER_CHAR,
      );
    },
    0,
  );

  it.each(TEXT_SHAPES.map((shape, i) => [i + 1, shape] as const))(
    'classifySearchQuery and quoteSearchText, case %i',
    async (_case, shape) => {
      await expectLinearCpu((query) => classifySearchQuery(query), shape, 1);
      await expectLinearCpu((query) => quoteSearchText(query), shape, 1);
    },
    0,
  );
});
