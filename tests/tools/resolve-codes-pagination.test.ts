/**
 * @fileoverview Pagination for `faostat_resolve_codes` (#7). The tool capped
 * matches at `limit` and disclosed `truncated`/`totalMatches` but exposed no
 * cursor, so an agent could not enumerate the omitted tail of a large
 * area/item/element listing. These lock the fix: an optional zero-based `offset`
 * pages every branch, `nextOffset` is returned (in both client surfaces via
 * enrichment) whenever more remain, consecutive pages are gap- and
 * duplicate-free, an FTS query pages stably across calls, and an exact-code
 * lookup stays single-page. Areas (unscoped by #8) exercise the pure pagination
 * path; a mid-size synthetic domain supplies enough codes to truncate.
 * @module tests/tools/resolve-codes-pagination
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildMidSizeDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** Seven country areas (codes 1–7, all named "Country N") — enough to page at limit 3. */
const COUNTRY_COUNT = 7;

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
    expect(result.matches).toEqual([{ code: 5, name: 'Country 5', kind: 'country' }]);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.nextOffset).toBeUndefined();
  });
});
