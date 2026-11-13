/**
 * @fileoverview `faostat_query_observations` paging (#52): `limit` is the page in
 * every state — DataCanvas on or off, match within or over `limit` — and `offset`
 * reaches every row past it. A first page (offset 0) whose match exceeds `limit`
 * also stages the whole match when the canvas is on; no later page stages. The
 * total is exact up to 50,000 and a disclosed floor beyond, and `nextOffset`
 * keeps advancing past it. Every offset a response names is fed back through the
 * tool's own input parse and called, so no notice names a call the caller cannot
 * make. `offset` is bounded at 100,000 in both count-input modes: a larger value is
 * rejected at argument validation, and a page whose next page would start past the
 * bound carries no `nextOffset` and a notice naming how to reach the rest. A
 * `limit` above its 1000 cap is served at the cap (#56): the clamp sentence
 * leads the call's one notice, and `offset` advances by the served limit. Cases run
 * through `runToolContract`, so each is read from
 * `structuredContent` and from the `content[]` the framework renders. A real
 * domain sync feeds a temp SQLite mirror, and a real DuckDB canvas backs the
 * canvas-on cases.
 * @module tests/tools/query-observations-paging
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasInstance,
  createCanvasService,
  type DataCanvas,
} from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withStrictCountInputs } from '@/mcp-server/tools/count-input.js';
import {
  OFFSET_CAP,
  queryObservationsTool,
  TOTAL_COUNT_CAP,
} from '@/mcp-server/tools/definitions/query-observations.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

type QueryInput = z.input<typeof queryObservationsTool.input>;

interface Observation {
  area_code: number;
  value: number | null;
  year: number;
}

/** Both client surfaces of one successful call. */
interface WireQuery {
  /** The `format()` block alone — `content[0]`, before the enrichment trailer. */
  formatted: string;
  notice: string | undefined;
  observations: Observation[];
  structured: Record<string, unknown>;
  /** Every `content[]` block joined, the enrichment trailer included. */
  text: string;
}

/** Real DuckDB canvas shared across the suite (lazy-loads `@duckdb/node-api`). */
let canvas: DataCanvas;

/** Every case selects the fixture's one series; codes 1..N include real roll-up codes, so aggregates stay in. */
const SERIES = {
  domain: FIXTURE_DOMAIN,
  item_codes: [15],
  element_codes: [5510],
  include_aggregates: true,
} satisfies QueryInput;

/** Run the query through its public contract and split out both surfaces. */
async function queryWire(tenantId: string, input: QueryInput): Promise<WireQuery> {
  const wire = await runToolContract(queryObservationsTool, input, { context: { tenantId } });
  expect(wire.isError).toBeFalsy();
  const blocks = wire.content.map((c) => (c.type === 'text' ? c.text : ''));
  const structured = wire.structuredContent as Record<string, unknown>;
  return {
    formatted: blocks[0] ?? '',
    notice: structured.notice as string | undefined,
    observations: structured.observations as Observation[],
    structured,
    text: blocks.join('\n'),
  };
}

/** Parse `offset` through the tool's own input schema — a call the caller can actually make. */
function parsedOffset(offset: number): number {
  return queryObservationsTool.input.parse({ ...SERIES, offset }).offset;
}

/** Every offset a notice names (`offset 100000`), each a call the caller would make. */
function namedOffsets(notice: string): number[] {
  return [...notice.matchAll(/offset (\d+)/g)].map((match) => Number(match[1]));
}

/** The input properties `tools/list` advertises for a definition. */
function advertisedInput(definition: AnyToolDefinition): Record<string, unknown> {
  return (
    z.toJSONSchema(definition.input, { io: 'input' }) as { properties: Record<string, unknown> }
  ).properties;
}

/** The page's row count, as `format()` states it on `content[]`. */
function formattedCount(wire: WireQuery): number {
  const match = /\*\*(\d+) observation\(s\)\*\*/.exec(wire.formatted);
  expect(match).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

/** Sync a synthetic domain into a fresh mirror; resolves to the row count written. */
async function syncDomain(
  dir: string,
  opts: Parameters<typeof buildMidSizeDomainZip>[0],
): Promise<{ mirror: FaostatMirror; total: number }> {
  const { zip, total } = buildMidSizeDomainZip(opts);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => chunkedResponse(zip, 1 << 16)),
  );
  const mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
  await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
    signal: new AbortController().signal,
    dataset: fixtureDataset(),
  });
  return { mirror, total };
}

beforeAll(() => {
  const built = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' }));
  if (!built) throw new Error('expected a DuckDB canvas to be constructed for the test');
  canvas = built;
  setCanvas(canvas);
});

afterAll(async () => {
  setCanvas(undefined);
  await canvas.shutdown(createMockContext({ tenantId: 'teardown' }));
});

describe('faostat_query_observations paging (#52)', () => {
  let dir: string;
  let mirror: FaostatMirror | undefined;

  /** Sync a fixture for this case. */
  async function sync(opts: Parameters<typeof buildMidSizeDomainZip>[0]): Promise<number> {
    const synced = await syncDomain(dir, opts);
    mirror = synced.mirror;
    return synced.total;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-paging-'));
  });

  afterEach(async () => {
    await mirror?.close();
    mirror = undefined;
    setCanvas(canvas);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('with DataCanvas off', () => {
    beforeEach(() => setCanvas(undefined));

    it('returns a match within limit whole, with no nextOffset and no notice', async () => {
      // The issue's first repro, 124 rows under limit 200, failed with canvas_disabled.
      expect(await sync({ countryCount: 124 })).toBe(124);
      const wire = await queryWire('paging-off-fits', { ...SERIES, limit: 200 });

      expect(wire.observations).toHaveLength(124);
      expect(wire.structured.totalCount).toBe(124);
      expect(wire.structured.spilled).toBe(false);
      expect(wire.structured).not.toHaveProperty('nextOffset');
      expect(wire.notice).toBeUndefined();
      expect(formattedCount(wire)).toBe(124);
      expect(wire.text).toContain('**124 total**');
      expect(wire.text).not.toContain('nextOffset');
    });

    it('returns exactly limit rows of a larger match, an exact total, and nextOffset', async () => {
      expect(await sync({ countryCount: 300 })).toBe(300);
      const wire = await queryWire('paging-off-overflow', { ...SERIES, limit: 200 });

      expect(wire.observations).toHaveLength(200);
      expect(wire.observations.map((o) => o.area_code)).toEqual(
        Array.from({ length: 200 }, (_, i) => i + 1),
      );
      expect(wire.structured.totalCount).toBe(300);
      expect(wire.structured).not.toHaveProperty('totalCountIsFloor');
      expect(wire.structured.nextOffset).toBe(200);
      expect(wire.structured.spilled).toBe(false);
      expect(wire.notice).toBe(
        'Showing observations 1–200 of 300. Continue with offset 200 for the next page.',
      );
      expect(wire.notice).not.toMatch(/faostat_dataframe|canvas/i);
      expect(formattedCount(wire)).toBe(200);
      expect(wire.text).toContain('**nextOffset:** 200');
      expect(wire.text).toContain(`> ${wire.notice}`);
    });

    it('walks first, middle, last, and past-the-end pages to one large read, row for row', async () => {
      // 146 areas × 3 years; every value is distinct, so a repeated or skipped row
      // across a page boundary cannot hide behind an equal neighbor.
      expect(
        await sync({ countryCount: 146, years: 3, value: (a, y) => a * 1000 + (y - 2019) }),
      ).toBe(438);
      const whole = await queryWire('paging-off-walk', { ...SERIES, limit: 1000 });
      expect(whole.observations).toHaveLength(438);
      expect(new Set(whole.observations.map((o) => o.value)).size).toBe(438);

      const first = await queryWire('paging-off-walk', { ...SERIES, limit: 200 });
      expect(first.observations).toHaveLength(200);
      expect(first.structured.totalCount).toBe(438);
      expect(first.structured.nextOffset).toBe(200);

      const second = await queryWire('paging-off-walk', {
        ...SERIES,
        limit: 200,
        offset: parsedOffset(first.structured.nextOffset as number),
      });
      expect(second.observations).toHaveLength(200);
      expect(second.structured.totalCount).toBe(438);
      expect(second.structured.nextOffset).toBe(400);
      expect(second.notice).toBe(
        'Showing observations 201–400 of 438. Continue with offset 400 for the next page.',
      );

      const last = await queryWire('paging-off-walk', {
        ...SERIES,
        limit: 200,
        offset: parsedOffset(second.structured.nextOffset as number),
      });
      expect(last.observations).toHaveLength(38);
      expect(last.structured.totalCount).toBe(438);
      expect(last.structured).not.toHaveProperty('nextOffset');
      expect(last.notice).toBeUndefined();
      expect(formattedCount(last)).toBe(38);

      expect([...first.observations, ...second.observations, ...last.observations]).toEqual(
        whole.observations,
      );

      const pastEnd = await queryWire('paging-off-walk', { ...SERIES, limit: 200, offset: 600 });
      expect(pastEnd.observations).toEqual([]);
      expect(pastEnd.structured.totalCount).toBe(438);
      expect(pastEnd.structured).not.toHaveProperty('totalCountIsFloor');
      expect(pastEnd.structured).not.toHaveProperty('nextOffset');
      expect(pastEnd.notice).toBe(
        'Offset 600 is past the end of the 438 matching observations, so this page is empty. Call again with offset 400 for the last page.',
      );
      expect(pastEnd.text).toContain(`> ${pastEnd.notice}`);
      expect(pastEnd.formatted).toContain('_No observations._');

      // The offset the notice names is a real call: it returns the last page.
      const named = Number(/offset (\d+) for the last page/.exec(pastEnd.notice as string)?.[1]);
      const lastAgain = await queryWire('paging-off-walk', {
        ...SERIES,
        limit: 200,
        offset: parsedOffset(named),
      });
      expect(lastAgain.observations).toEqual(last.observations);
    });

    it('takes the no-match path, not the past-the-end path, for an empty match at offset > 0', async () => {
      await sync({ countryCount: 300 });
      const wire = await queryWire('paging-off-no-match', {
        ...SERIES,
        year_start: 1700,
        year_end: 1701,
        offset: 400,
      });

      expect(wire.observations).toEqual([]);
      expect(wire.structured.totalCount).toBe(0);
      expect(wire.structured).not.toHaveProperty('nextOffset');
      expect(wire.notice).toMatch(/^No observations matched in QCL\./);
      expect(wire.notice).not.toMatch(/past the end|offset/i);
    });
  });

  describe('with DataCanvas on', () => {
    it('returns exactly limit rows when the page itself is over the preview budget, and stages the whole match', async () => {
      // The issue's second repro: limit 1000 came back as the 398 rows that fit the
      // staging helper's 100,000-character preview.
      expect(await sync({ countryCount: 1200 })).toBe(1200);
      const wire = await queryWire('paging-on-char-page', { ...SERIES, limit: 1000 });

      expect(wire.observations).toHaveLength(1000);
      expect(JSON.stringify(wire.observations).length).toBeGreaterThan(100_000);
      expect(wire.observations.map((o) => o.area_code)).toEqual(
        Array.from({ length: 1000 }, (_, i) => i + 1),
      );
      expect(wire.structured.spilled).toBe(true);
      expect(wire.structured.truncated).toBe(false);
      expect(wire.structured.staged_row_count).toBe(1200);
      expect(wire.structured.totalCount).toBe(1200);
      expect(wire.structured.nextOffset).toBe(1000);
      expect(wire.notice).toContain('the first 1000 are shown inline');
      expect(wire.notice).toContain('continue with offset 1000 for the next page');
      expect(formattedCount(wire)).toBe(1000);
      expect(wire.text).toContain('**nextOffset:** 1000');

      const ctx = createMockContext({ tenantId: 'paging-on-char-page' });
      const instance = await canvas.acquire(wire.structured.canvas_id as string, ctx);
      const staged = await instance.query(
        `SELECT COUNT(*) AS n, MIN(area_code) AS lo, MAX(area_code) AS hi FROM ${wire.structured.table_name}`,
        { rowLimit: 1, denySystemCatalogs: true },
      );
      expect(Number(staged.rows[0]?.n)).toBe(1200);
      expect(Number(staged.rows[0]?.lo)).toBe(1);
      expect(Number(staged.rows[0]?.hi)).toBe(1200);
    });

    it('returns a match within limit whole and stages nothing, even over the preview budget', async () => {
      expect(await sync({ countryCount: 1000 })).toBe(1000);
      const tenantId = 'paging-on-fits';
      const wire = await queryWire(tenantId, { ...SERIES, limit: 1000 });

      expect(wire.observations).toHaveLength(1000);
      expect(JSON.stringify(wire.observations).length).toBeGreaterThan(100_000);
      expect(wire.structured.spilled).toBe(false);
      expect(wire.structured).not.toHaveProperty('canvas_id');
      expect(wire.structured).not.toHaveProperty('table_name');
      expect(wire.structured).not.toHaveProperty('nextOffset');
      expect(wire.structured.totalCount).toBe(1000);
      expect(wire.notice).toBeUndefined();
      expect(canvas.countForTenant(createMockContext({ tenantId }))).toBe(0);
    });

    it('never stages a page past the first, nor consults its canvas_id', async () => {
      // limit 50 makes the page at offset 200 overflow, so only the offset decides
      // that nothing stages; the dead canvas_id would fail the call if consulted.
      await sync({ countryCount: 300 });
      const tenantId = 'paging-on-offset';
      const wire = await queryWire(tenantId, {
        ...SERIES,
        limit: 50,
        offset: 200,
        canvas_id: 'zzzzzzzzzz',
      });

      expect(wire.observations.map((o) => o.area_code)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 201),
      );
      expect(wire.structured.spilled).toBe(false);
      expect(wire.structured).not.toHaveProperty('canvas_id');
      expect(wire.structured).not.toHaveProperty('table_name');
      expect(wire.structured).not.toHaveProperty('staged_row_count');
      expect(wire.structured.totalCount).toBe(300);
      expect(wire.structured.nextOffset).toBe(250);
      expect(wire.notice).toBe(
        'Showing observations 201–250 of 300. Continue with offset 250 for the next page.',
      );
      expect(wire.text).not.toMatch(/faostat_dataframe/);
      expect(wire.formatted).toContain('no canvas table was staged for this result');
      expect(canvas.countForTenant(createMockContext({ tenantId }))).toBe(0);
    });

    it('settles a cancellation during table registration as RequestCancelled, never the staging-failed page', async () => {
      // 300 rows drain under the preview budget, so the staging layer registers the
      // buffered set itself; the caller abandons the call while it does.
      await sync({ countryCount: 300 });
      const controller = new AbortController();
      const registerTable = vi
        .spyOn(CanvasInstance.prototype, 'registerTable')
        .mockImplementationOnce(async () => {
          controller.abort();
          throw new DOMException('The operation was aborted.', 'AbortError');
        });

      const wire = await runToolContract(
        queryObservationsTool,
        { ...SERIES, limit: 200 },
        { context: { tenantId: 'paging-on-cancel', signal: controller.signal } },
      );

      expect(registerTable).toHaveBeenCalledTimes(1);
      expect(wire.isError).toBe(true);
      expect((wire.structuredContent as { error: { code: number } }).error.code).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
      const text = wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).not.toMatch(
        /staging the full set to a canvas table failed|Showing observations/i,
      );
    });
  });
});

describe('faostat_query_observations past the 50,000-row total cap (#52)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  // 260 areas × 200 years = 52,000 rows, each value distinct (area × 1000 + year index).
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-paging-cap-'));
    const synced = await syncDomain(dir, {
      countryCount: 260,
      years: 200,
      value: (a, y) => a * 1000 + (y - 2019),
    });
    expect(synced.total).toBe(52_000);
    mirror = synced.mirror;
  }, 60_000);

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => setCanvas(canvas));

  it('pins the total cap at 50,000', () => {
    expect(TOTAL_COUNT_CAP).toBe(50_000);
  });

  it('reports 50,000 as a disclosed floor and keeps nextOffset advancing past it, canvas off', async () => {
    setCanvas(undefined);
    const first = await queryWire('paging-cap-off', { ...SERIES, limit: 1000 });
    expect(first.observations).toHaveLength(1000);
    expect(first.structured.totalCount).toBe(50_000);
    expect(first.structured.totalCountIsFloor).toBe(true);
    expect(first.text).toContain('**totalCountIsFloor:** true');
    expect(first.structured.nextOffset).toBe(1000);
    expect(first.notice).toBe(
      'Showing observations 1–1000 of more than 50000 (totalCount 50000 is a floor). Continue with offset 1000 for the next page.',
    );
    expect(first.text).toContain('**50000 total**');

    const atCap = await queryWire('paging-cap-off', {
      ...SERIES,
      limit: 1000,
      offset: parsedOffset(50_000),
    });
    expect(atCap.observations).toHaveLength(1000);
    expect(atCap.structured.totalCount).toBe(50_000);
    expect(atCap.structured.totalCountIsFloor).toBe(true);
    expect(atCap.structured.nextOffset).toBe(51_000);

    const last = await queryWire('paging-cap-off', {
      ...SERIES,
      limit: 1000,
      offset: parsedOffset(atCap.structured.nextOffset as number),
    });
    expect(last.observations).toHaveLength(1000);
    expect(last.structured.totalCount).toBe(52_000);
    expect(last.structured).not.toHaveProperty('totalCountIsFloor');
    expect(last.structured).not.toHaveProperty('nextOffset');
    expect(last.notice).toBeUndefined();

    const pastEnd = await queryWire('paging-cap-off', { ...SERIES, limit: 1000, offset: 60_000 });
    expect(pastEnd.observations).toEqual([]);
    expect(pastEnd.structured.totalCount).toBe(50_000);
    expect(pastEnd.structured.totalCountIsFloor).toBe(true);
    expect(pastEnd.structured).not.toHaveProperty('nextOffset');
    expect(pastEnd.notice).toBe(
      'Offset 60000 is past the end of the match, so this page is empty; more than 50000 observations matched (totalCount 50000 is a floor). Call again with a lower offset — offset 50000 still returns rows.',
    );
    // The offset the notice names is the atCap call above, which returned 1000 rows.
    const named = Number(/offset (\d+) still returns rows/.exec(pastEnd.notice as string)?.[1]);
    expect(parsedOffset(named)).toBe(50_000);
  }, 60_000);

  it('reports a match of exactly 50,000 as exact, not a floor, canvas off', async () => {
    setCanvas(undefined);
    // Areas 1–250 of the 260 hold 250 × 200 = 50,000 rows: the cap itself, still exact.
    const atCap = { ...SERIES, area_codes: Array.from({ length: 250 }, (_, i) => i + 1) };
    const first = await queryWire('paging-cap-exact', { ...atCap, limit: 1000 });
    expect(first.observations).toHaveLength(1000);
    expect(first.structured.totalCount).toBe(50_000);
    expect(first.structured).not.toHaveProperty('totalCountIsFloor');
    expect(first.structured.nextOffset).toBe(1000);
    expect(first.notice).toBe(
      'Showing observations 1–1000 of 50000. Continue with offset 1000 for the next page.',
    );

    const pastEnd = await queryWire('paging-cap-exact', { ...atCap, limit: 1000, offset: 60_000 });
    expect(pastEnd.observations).toEqual([]);
    expect(pastEnd.structured.totalCount).toBe(50_000);
    expect(pastEnd.structured).not.toHaveProperty('totalCountIsFloor');
    expect(pastEnd.notice).toBe(
      'Offset 60000 is past the end of the 50000 matching observations, so this page is empty. Call again with offset 49000 for the last page.',
    );
  }, 60_000);

  it('names the first unstaged row when the staged table is a truncated prefix, canvas on', async () => {
    const wire = await queryWire('paging-cap-on', { ...SERIES, limit: 1000 });
    expect(wire.structured.spilled).toBe(true);
    expect(wire.structured.truncated).toBe(true);
    expect(wire.structured.staged_row_count).toBe(50_000);
    expect(wire.structured.totalCount).toBe(50_000);
    expect(wire.structured.totalCountIsFloor).toBe(true);
    expect(wire.structured.nextOffset).toBe(1000);
    expect(wire.notice).toContain(
      'call again with offset 50000 (the first row past the staged prefix) and follow nextOffset',
    );
    expect(wire.formatted).toContain('call again with offset 50000 to page past the staged prefix');

    // Offset 50000 is exactly where the table ends: the row before it is staged, its own row is not.
    const before = await queryWire('paging-cap-on', {
      ...SERIES,
      limit: 1,
      offset: parsedOffset(49_999),
    });
    const after = await queryWire('paging-cap-on', {
      ...SERIES,
      limit: 1,
      offset: parsedOffset(50_000),
    });
    const instance = await canvas.acquire(
      wire.structured.canvas_id as string,
      createMockContext({ tenantId: 'paging-cap-on' }),
    );
    const staged = async (value: number | null) =>
      Number(
        (
          await instance.query(
            `SELECT COUNT(*) AS n FROM ${wire.structured.table_name} WHERE value = ${value}`,
            { rowLimit: 1, denySystemCatalogs: true },
          )
        ).rows[0]?.n,
      );
    expect(await staged(before.observations[0]?.value ?? null)).toBe(1);
    expect(await staged(after.observations[0]?.value ?? null)).toBe(0);
  }, 60_000);
});

describe('faostat_query_observations at the offset bound', () => {
  const PAST_BOUND =
    'Offset paging ends here: the next page would start past offset 100000, the deepest offset this tool accepts.';
  let dir: string;
  let mirror: FaostatMirror;

  // 101,001 areas in one year: the page at offset 100000 (limit 1000) ends one row
  // before the match does, so rows remain past the deepest page offset paging reaches.
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-paging-bound-'));
    const synced = await syncDomain(dir, { countryCount: 101_001 });
    expect(synced.total).toBe(101_001);
    mirror = synced.mirror;
  }, 60_000);

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  // Pages past the first never stage, so the canvas plays no part here.
  beforeEach(() => setCanvas(undefined));
  afterEach(() => setCanvas(canvas));

  it('offers nextOffset up to the bound, then ends offset paging with a notice naming the way forward', async () => {
    const before = await queryWire('paging-bound', {
      ...SERIES,
      limit: 1000,
      offset: parsedOffset(99_000),
    });
    expect(before.observations).toHaveLength(1000);
    expect(before.structured.totalCount).toBe(50_000);
    expect(before.structured.totalCountIsFloor).toBe(true);
    expect(before.structured.nextOffset).toBe(100_000);
    expect(before.notice).toBe(
      'Showing observations 99001–100000 of more than 50000 (totalCount 50000 is a floor). Continue with offset 100000 for the next page.',
    );
    expect(before.text).toContain('**nextOffset:** 100000');

    const end = await queryWire('paging-bound', {
      ...SERIES,
      limit: 1000,
      offset: parsedOffset(before.structured.nextOffset as number),
    });
    expect(end.observations.map((o) => o.area_code)).toEqual(
      Array.from({ length: 1000 }, (_, i) => i + 100_001),
    );
    expect(end.structured.totalCount).toBe(50_000);
    expect(end.structured.totalCountIsFloor).toBe(true);
    expect(end.structured).not.toHaveProperty('nextOffset');
    expect(end.notice).toBe(
      `Showing observations 100001–101000 of more than 50000 (totalCount 50000 is a floor). ${PAST_BOUND} To reach the rows past it, partition the query by year (year_start/year_end) or with narrower area_codes, item_codes, or element_codes, and page each part from offset 0.`,
    );
    expect(formattedCount(end)).toBe(1000);
    expect(end.text).toContain(`> ${end.notice}`);
    expect(end.text).toContain('**totalCountIsFloor:** true');
    expect(end.text).not.toContain('nextOffset');

    // Every offset either notice names is one the tool accepts (parse throws otherwise).
    const named = [...namedOffsets(before.notice as string), ...namedOffsets(end.notice as string)];
    expect(named).toEqual([100_000, 100_000, 0]);
    for (const offset of named) expect(parsedOffset(offset)).toBe(offset);
  }, 60_000);

  it('leaves the year partition out of the way forward when the query is already one year', async () => {
    const end = await queryWire('paging-bound-one-year', {
      ...SERIES,
      year_start: 2020,
      year_end: 2020,
      limit: 1000,
      offset: parsedOffset(100_000),
    });
    expect(end.observations).toHaveLength(1000);
    expect(end.structured).not.toHaveProperty('nextOffset');
    expect(end.notice).toBe(
      `Showing observations 100001–101000 of more than 50000 (totalCount 50000 is a floor). ${PAST_BOUND} To reach the rows past it, partition the query with narrower area_codes, item_codes, or element_codes, and page each part from offset 0.`,
    );
    expect(end.text).toContain(`> ${end.notice}`);
  }, 60_000);
});

describe('faostat_query_observations offset input (#52)', () => {
  it.each([
    [-1, 'too_small'],
    [1.5, 'invalid_type'],
  ])('rejects offset %s', (offset, code) => {
    const parsed = queryObservationsTool.input.safeParse({ domain: FIXTURE_DOMAIN, offset });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ code, path: ['offset'] })]);
  });

  it('defaults offset to 0', () => {
    expect(queryObservationsTool.input.parse({ domain: FIXTURE_DOMAIN }).offset).toBe(0);
  });

  it('pins the offset bound at 100,000', () => {
    expect(OFFSET_CAP).toBe(100_000);
  });

  // offset is a position, not a count: FAOSTAT_CLAMP_LIMITS never serves it at the
  // bound, so both registrations reject past it and advertise it the same way.
  describe.each([
    ['clamp', queryObservationsTool],
    ['strict', withStrictCountInputs(queryObservationsTool)],
  ] as const)('%s mode', (_mode, definition) => {
    it('rejects offset 100001 with the bound and the way forward on both surfaces', async () => {
      const wire = await runToolContract(definition, { ...SERIES, offset: 100_001 });
      expect(wire.isError).toBe(true);
      const { error } = wire.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason: string; recovery: { hint: string } };
        };
      };
      const stated =
        'offset: Send 100000 or less. Offset paging reaches at most 100000 rows into a match, so narrow the query with year_start/year_end, area_codes, item_codes, or element_codes until the rows you need fall inside that range, then page from offset 0.';
      expect(error.code).toBe(-32602);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(error.data.recovery.hint).toBe(stated);
      expect(error.message).toContain(stated);
      expect(wire.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')).toContain(
        stated,
      );
    });

    it('accepts offset 100000', () => {
      expect(definition.input.safeParse({ ...SERIES, offset: 100_000 }).success).toBe(true);
    });

    it('advertises the bound as the offset maximum in tools/list', () => {
      expect(advertisedInput(definition).offset).toMatchObject({
        type: 'integer',
        minimum: 0,
        maximum: 100_000,
        default: 0,
      });
    });
  });
});

describe('faostat_query_observations limit clamp (#56)', () => {
  const CLAMP = 'limit 5000 is above the 1000 cap; returned up to 1000.';
  let dir: string;
  let mirror: FaostatMirror;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-paging-clamp-'));
    const synced = await syncDomain(dir, { countryCount: 1200 });
    expect(synced.total).toBe(1200);
    mirror = synced.mirror;
  });

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => setCanvas(canvas));

  it('serves limit 5000 at the 1000 cap, leads the notice with the clamp, and advances offset by 1000', async () => {
    setCanvas(undefined);
    const wire = await queryWire('clamp-off', { ...SERIES, limit: 5000 });

    expect(wire.observations).toHaveLength(1000);
    expect(wire.structured.requestedLimit).toBe(5000);
    expect(wire.structured.effectiveLimit).toBe(1000);
    expect(wire.structured.totalCount).toBe(1200);
    expect(wire.structured.nextOffset).toBe(1000);
    expect(wire.notice).toBe(
      `${CLAMP} Showing observations 1–1000 of 1200. Continue with offset 1000 for the next page.`,
    );
    expect(formattedCount(wire)).toBe(1000);
    expect(wire.text).toContain('**requestedLimit:** 5000');
    expect(wire.text).toContain('**effectiveLimit:** 1000');
    expect(wire.text).toContain(`> ${wire.notice}`);
  });

  it('names no next call on the last page of a clamped call', async () => {
    setCanvas(undefined);
    const wire = await queryWire('clamp-off-last', {
      ...SERIES,
      limit: 5000,
      offset: parsedOffset(1000),
    });

    expect(wire.observations).toHaveLength(200);
    expect(wire.structured).not.toHaveProperty('nextOffset');
    expect(wire.structured.totalCount).toBe(1200);
    expect(wire.notice).toBe(CLAMP);
  });

  it('names the last page by the served limit when a clamped offset is past the end', async () => {
    setCanvas(undefined);
    const wire = await queryWire('clamp-off-past-end', { ...SERIES, limit: 5000, offset: 5000 });

    expect(wire.observations).toEqual([]);
    expect(wire.notice).toBe(
      `${CLAMP} Offset 5000 is past the end of the 1200 matching observations, so this page is empty. Call again with offset 1000 for the last page.`,
    );
  });

  it('leads a staged first page’s notice with the clamp, canvas on', async () => {
    const wire = await queryWire('clamp-on', { ...SERIES, limit: 5000 });

    expect(wire.observations).toHaveLength(1000);
    expect(wire.structured.spilled).toBe(true);
    expect(wire.structured.staged_row_count).toBe(1200);
    expect(wire.structured.nextOffset).toBe(1000);
    expect(
      wire.notice?.startsWith(`${CLAMP} Result of 1200 observations staged on canvas table`),
    ).toBe(true);
    expect(wire.notice).toContain('continue with offset 1000 for the next page');
  });

  it('records nothing for a limit at the cap', async () => {
    setCanvas(undefined);
    const wire = await queryWire('clamp-at-cap', { ...SERIES, limit: 1000 });

    expect(wire.observations).toHaveLength(1000);
    expect(wire.structured).not.toHaveProperty('requestedLimit');
    expect(wire.structured).not.toHaveProperty('effectiveLimit');
    expect(wire.notice).toBe(
      'Showing observations 1–1000 of 1200. Continue with offset 1000 for the next page.',
    );
    expect(wire.text).not.toMatch(/requestedLimit|effectiveLimit|above the 1000 cap/);
  });

  it('advertises limit without a maximum in clamp mode and with the cap in strict mode', () => {
    const strict = withStrictCountInputs(queryObservationsTool);

    expect(advertisedInput(queryObservationsTool).limit).toEqual({
      type: 'integer',
      minimum: 1,
      default: 200,
      description: expect.stringContaining('at most 1000 per call'),
    });
    expect(advertisedInput(strict).limit).toMatchObject({
      maximum: 1000,
      minimum: 1,
      default: 200,
    });
    expect(strict.input.safeParse({ domain: FIXTURE_DOMAIN, limit: 1001 }).success).toBe(false);
    // offset keeps its own bounds in both modes.
    expect(advertisedInput(strict).offset).toEqual(advertisedInput(queryObservationsTool).offset);
  });
});
