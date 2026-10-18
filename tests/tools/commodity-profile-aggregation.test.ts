/**
 * @fileoverview `faostat_commodity_profile` ranking/trend correctness regressions
 * (#5/#41). Covers selection of one commodity, latest year computed per country
 * rather than once globally, disclosure of ambiguous candidate truncation, the
 * inline annual trend on both client surfaces, and empty ranking sections
 * rendered explicitly instead of omitted.
 * @module tests/tools/commodity-profile-aggregation
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildExplicitDomainZip,
  chunkedResponse,
  type ExplicitObservation,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

const PRODUCTION = { elementCode: 5510, element: 'Production' } as const;
const CATTLE = { itemCode: 100, item: 'Milk of cattle' } as const;
const GOATS = { itemCode: 101, item: 'Milk of goats' } as const;
const ALPHA = { areaCode: 10, area: 'Alpha' } as const;
const BRAVO = { areaCode: 20, area: 'Bravo' } as const;

let mirror: FaostatMirror | undefined;
let dir: string | undefined;

/** Sync a mirror holding exactly `observations`, and return the tool's result. */
async function profile(
  observations: ExplicitObservation[],
  input: Record<string, unknown> = { item_query: 'Milk of cattle' },
) {
  dir = mkdtempSync(join(tmpdir(), 'faostat-profile-agg-'));
  const zip = buildExplicitDomainZip(observations);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => chunkedResponse(zip, 1 << 16)),
  );
  mirror = initFaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
  await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
    signal: new AbortController().signal,
    dataset: fixtureDataset(),
  });
  const ctx = createMockContext({ tenantId: 'profile-agg', errors: commodityProfileTool.errors });
  const parsed = commodityProfileTool.input.parse(input);
  return { ctx, result: await commodityProfileTool.handler(parsed, ctx) };
}

afterEach(async () => {
  await mirror?.close();
  mirror = undefined;
  vi.unstubAllGlobals();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('faostat_commodity_profile per-country aggregation (#5a)', () => {
  it('characterizes exact single-item output, flags, and empty trade sections', async () => {
    const { result } = await profile(
      [{ ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2021, value: 60, flag: 'E' }],
      { item_query: 'Milk of cattle' },
    );
    expect(result.resolved_items).toEqual([{ code: 100, name: 'Milk of cattle' }]);
    expect(result.top_producers[0]).toMatchObject({ value: 60, year: 2021, flags: 'E' });
    expect(result.production_trend[0]).toMatchObject({ value: 60, flags: 'E' });
    expect(commodityProfileTool.format?.(result)).toEqual([
      expect.objectContaining({ text: expect.stringContaining('### Top exporters\n_None._') }),
    ]);
  });

  it('rejects related commodities instead of adding their production', async () => {
    await expect(
      profile(
        [
          { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2022, value: 60 },
          { ...ALPHA, ...GOATS, ...PRODUCTION, year: 2022, value: 55 },
        ],
        { item_query: 'milk' },
      ),
    ).rejects.toMatchObject({ data: { reason: 'ambiguous_item' } });
  });
  it('ranks only the selected item without adding related commodities', async () => {
    /** Related commodities would invert the ranking if their values were added. */
    const { result } = await profile([
      { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2022, value: 60, flag: 'A' },
      { ...ALPHA, ...GOATS, ...PRODUCTION, year: 2022, value: 55, flag: 'E' },
      { ...BRAVO, ...CATTLE, ...PRODUCTION, year: 2022, value: 100, flag: 'A' },
      { ...BRAVO, ...GOATS, ...PRODUCTION, year: 2022, value: 5, flag: 'A' },
    ]);

    expect(result.resolved_items).toHaveLength(1);
    expect(result.top_producers).toHaveLength(2);
    expect(result.top_producers[0]).toMatchObject({
      area: 'Bravo',
      area_code: 20,
      value: 100,
      observations: 1,
      year: 2022,
      unit: 't',
    });
    expect(result.top_producers[1]).toMatchObject({
      area: 'Alpha',
      area_code: 10,
      value: 60,
      observations: 1,
    });
    // The unrelated goat estimate must not contaminate the cattle flag.
    expect(result.top_producers[0]?.flags).toBe('A');
    expect(result.top_producers[1]?.flags).toBe('A');
  });

  it('keeps units apart rather than summing incomparable quantities', async () => {
    const { ctx, result } = await profile([
      { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2021, value: 60, unit: 't' },
      { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2022, value: 55, unit: 'No' },
    ]);

    expect(result.top_producers.map((r) => [r.unit, r.value])).toEqual([
      ['t', 60],
      ['No', 55],
    ]);
    expect(getEnrichment(ctx).notice as string).toMatch(/more than one unit/);
  });
});

describe('faostat_commodity_profile per-country latest year (#5b, #5d)', () => {
  it('ranks each country at its own latest year rather than one global max', async () => {
    /*
     * Alpha reports through 2022, Bravo stops at 2021. A single global
     * latestYear = 2022 keeps only Alpha's 2022 row and drops Bravo entirely.
     * Alpha's 2020-only goat series is deliberately NOT folded into its 2022
     * total — mixing vintages inside one row would silently inflate it.
     */
    const { result } = await profile([
      { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2021, value: 10 },
      { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2022, value: 30 },
      { ...ALPHA, ...GOATS, ...PRODUCTION, year: 2020, value: 1000 },
      { ...BRAVO, ...CATTLE, ...PRODUCTION, year: 2020, value: 100 },
      { ...BRAVO, ...CATTLE, ...PRODUCTION, year: 2021, value: 90 },
    ]);

    expect(result.resolved_items).toHaveLength(1);
    expect(result.top_producers).toHaveLength(2);
    expect(result.top_producers[0]).toMatchObject({ area: 'Bravo', value: 90, year: 2021 });
    expect(result.top_producers[1]).toMatchObject({
      area: 'Alpha',
      value: 30,
      year: 2022,
      observations: 1,
    });
  });

  it('returns the annual trend on both client surfaces (#5e)', async () => {
    const { result } = await profile([
      { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2021, value: 10, flag: 'E' },
      { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2022, value: 30 },
      { ...ALPHA, ...GOATS, ...PRODUCTION, year: 2020, value: 1000 },
      { ...BRAVO, ...CATTLE, ...PRODUCTION, year: 2020, value: 100 },
      { ...BRAVO, ...CATTLE, ...PRODUCTION, year: 2021, value: 90 },
    ]);

    expect(result.production_trend).toEqual([
      { year: 2020, value: 100, observations: 1, unit: 't', flags: 'A' },
      { year: 2021, value: 100, observations: 2, unit: 't', flags: 'A, E' },
      { year: 2022, value: 30, observations: 1, unit: 't', flags: 'A' },
    ]);
    expect(result.trend_points).toBe(4);

    // content[]-only clients must see the same year/value pairs, not just a count.
    const text = (commodityProfileTool.format?.(result) ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toContain('| 2020 | 100 | t | 1 | A |');
    expect(text).toContain('| 2021 | 100 | t | 2 | A, E |');
    expect(text).toContain('| 2022 | 30 | t | 1 | A |');
  });
});

describe('faostat_commodity_profile item-resolution disclosure (#5c)', () => {
  it('discloses when ambiguity guidance cannot show every candidate', async () => {
    const observations: ExplicitObservation[] = [];
    for (let i = 0; i < 8; i++) {
      observations.push({
        ...ALPHA,
        ...PRODUCTION,
        itemCode: 100 + i,
        item: `Milk variant ${i}`,
        year: 2022,
        value: 10 + i,
      });
    }
    await expect(profile(observations, { item_query: 'milk' })).rejects.toMatchObject({
      data: { reason: 'ambiguous_item' },
      message: expect.stringContaining('showing 5 of 8; truncated'),
    });
  });

  it('does not claim truncation when every match fits', async () => {
    const { ctx } = await profile([
      { ...ALPHA, ...CATTLE, ...PRODUCTION, year: 2022, value: 60 },
      { ...ALPHA, ...GOATS, ...PRODUCTION, year: 2022, value: 55 },
    ]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.resolvedItemMatches).toBe(1);
    expect(enrichment.itemsTruncated).toBe(false);
    expect((enrichment.notice as string | undefined) ?? '').not.toMatch(/matched 2 items/);
  });
});

describe('faostat_commodity_profile empty ranking sections (#5f)', () => {
  it('renders every ranking heading, so empty is distinguishable from not returned', () => {
    const text = (
      commodityProfileTool.format?.({
        item_query: 'wheat',
        resolved_items: [{ code: 15, name: 'Wheat' }],
        top_producers: [
          {
            area_code: 10,
            area: 'Alpha',
            value: 60,
            observations: 1,
            unit: 't',
            year: 2022,
            flags: 'A',
          },
        ],
        top_exporters: [],
        top_importers: [],
        production_trend: [],
        trend_points: 0,
        spilled: false,
        truncated: false,
      }) ?? []
    )
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');

    expect(text).toContain('### Top producers');
    expect(text).toContain('### Top exporters');
    expect(text).toContain('### Top importers');
    expect(text).toContain('### Production trend');
    // The two empty rankings and the empty trend each say so explicitly.
    expect(text.match(/_None\._/g)).toHaveLength(3);
  });
});
