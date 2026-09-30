/**
 * @fileoverview Domain-scoped resolution (#8). `faostat_resolve_codes` resolved
 * item/element terms against one shared dimension vocabulary — a union across
 * every indexed domain — so it could surface a code absent from the requested
 * domain (e.g. a fertilizer item under a land-use domain), presenting it as
 * queryable and dead-looping the caller against a zero-row query. These lock the
 * fix: item and element matches are scoped to the codes actually present in the
 * requested domain's cube, both by `query` and by list-all, and the shared area
 * vocabulary stays unscoped. Two synthetic domains with genuinely distinct
 * item/element vocab (built via the fixture's vocab override) reproduce the leak.
 *
 * Also covers the #7 coupling: the domain scope is applied BEFORE the pagination
 * window, so `totalMatches`/`nextOffset` reflect the domain-scoped set — not the
 * global vocabulary — and paging never leaks another domain's codes.
 *
 * And #36: better-sqlite3 (the Node driver) binds a JS number as REAL, and FTS5
 * drops a REAL `rowid =` constraint beside MATCH without re-checking it — so under
 * Node, a domain whose cube carries a single item or element code leaked every FTS
 * match. The single-code cases pin the scope on every branch. They can only fail
 * in the Node test lane (`bun run test:node`): bun:sqlite binds integers as INTEGER.
 * @module tests/tools/resolve-codes-domain-scope
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCodesTool } from '@/mcp-server/tools/definitions/resolve-codes.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildDomainZip,
  chunkedResponse,
  type DomainVocab,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

/** Land-use-shaped domain: three land items, one element. Analog of FAOSTAT RL. */
const LND_VOCAB: DomainVocab = {
  items: [
    { code: 6600, name: 'Land area' },
    { code: 6601, name: 'Cropland' },
    { code: 6620, name: 'Forest land' },
  ],
  elements: [{ code: 5110, name: 'Area' }],
};

/** Fertilizer-shaped domain: three nutrient items, two elements. Analog of FAOSTAT RFN. */
const FRT_VOCAB: DomainVocab = {
  items: [
    { code: 3102, name: 'Nutrient nitrogen N (total)' },
    { code: 3103, name: 'Nutrient phosphate P2O5 (total)' },
    { code: 3104, name: 'Nutrient potash K2O (total)' },
  ],
  elements: [
    { code: 5510, name: 'Production' },
    { code: 5157, name: 'Agricultural Use' },
  ],
};

/** Grain-shaped domain: four items sharing the FTS token "grain", two elements. */
const GRA_VOCAB: DomainVocab = {
  items: [
    { code: 101, name: 'Grain' },
    { code: 103, name: 'Grain maize' },
    { code: 105, name: 'Grain sorghum' },
    { code: 107, name: 'Mixed grain' },
  ],
  elements: [
    { code: 5510, name: 'Production' },
    { code: 5312, name: 'Area harvested' },
  ],
};

/** A domain whose cube carries exactly one item and one element — the #36 shape. */
const GRB_VOCAB: DomainVocab = {
  items: [{ code: 102, name: 'Grain barley' }],
  elements: [{ code: 5419, name: 'Yield' }],
};

/**
 * Stub the bulk fetch to serve each domain's ZIP by the `_<CODE>_` token in its
 * URL, then init-sync every domain so the shared dimension vocabulary is the union.
 */
async function syncDomains(dir: string, vocabs: Record<string, DomainVocab>) {
  const zips = new Map(Object.entries(vocabs).map(([code, v]) => [code, buildDomainZip(code, v)]));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const code = [...zips.keys()].find((c) => String(url).includes(`_${c}_`));
      const zip = code ? zips.get(code) : undefined;
      if (!zip) throw new Error(`No fixture ZIP for ${String(url)}`);
      return chunkedResponse(zip, 1 << 16);
    }),
  );
  const mirror = initFaostatMirror({ dir, domains: [...zips.keys()] });
  for (const code of zips.keys()) {
    await mirror.runDomainSync(code, 'init', {
      signal: new AbortController().signal,
      dataset: fixtureDataset(code),
    });
  }
  return mirror;
}

/** Run the tool with a fresh context; return the result plus its enrichment. */
async function resolve(input: Record<string, unknown>) {
  const ctx = createMockContext({ tenantId: 't', errors: resolveCodesTool.errors });
  const result = await resolveCodesTool.handler(resolveCodesTool.input.parse(input), ctx);
  return { result, enrichment: getEnrichment(ctx) };
}

describe('faostat_resolve_codes domain-scoped resolution (#8)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-domain-scope-'));
    mirror = await syncDomains(dir, { LND: LND_VOCAB, FRT: FRT_VOCAB });
  });

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes an item present only in another domain from a query resolution', async () => {
    // Item 3102 ("nitrogen") lives in FRT's cube and the shared vocabulary, never LND's.
    const lnd = await resolve({ domain: 'LND', dimension: 'item', query: 'nitrogen' });
    expect(lnd.result.matches).toEqual([]);
    expect(lnd.enrichment.totalMatches).toBe(0);
    expect(lnd.enrichment.notice).toMatch(/No item matched/i);

    // The same query against FRT — the domain that owns the code — resolves it.
    const frt = await resolve({ domain: 'FRT', dimension: 'item', query: 'nitrogen' });
    expect(frt.result.matches.map((m) => m.code)).toContain(3102);
  });

  it('excludes another domain’s item from a list-all resolution and scopes the total', async () => {
    const lnd = await resolve({ domain: 'LND', dimension: 'item', limit: 200 });
    const codes = lnd.result.matches.map((m) => m.code);
    // Only LND's own items, and none of FRT's nutrient codes.
    expect(codes).toEqual([6600, 6601, 6620]);
    expect(codes).not.toContain(3102);
    // The total is the domain-scoped count (3), not the shared vocabulary's 6.
    expect(lnd.enrichment.totalMatches).toBe(3);
  });

  it('scopes element resolution to the domain, by query and by list-all', async () => {
    // Element 5510 ("Production") is in FRT's cube + the shared vocabulary, not LND's.
    const lndProd = await resolve({ domain: 'LND', dimension: 'element', query: 'production' });
    expect(lndProd.result.matches).toEqual([]);

    const lndAll = await resolve({ domain: 'LND', dimension: 'element', limit: 200 });
    expect(lndAll.result.matches.map((m) => m.code)).toEqual([5110]);

    // FRT — the owner — resolves 5510.
    const frtProd = await resolve({ domain: 'FRT', dimension: 'element', query: 'production' });
    expect(frtProd.result.matches.map((m) => m.code)).toContain(5510);
  });

  it('resolves an exact code only within the domain that carries it', async () => {
    // 3102 exists globally but not in LND → treated as absent.
    const lnd = await resolve({ domain: 'LND', dimension: 'item', code: 3102 });
    expect(lnd.result.matches).toEqual([]);
    // In FRT the exact lookup returns it, single-page (no pagination fields).
    const frt = await resolve({ domain: 'FRT', dimension: 'item', code: 3102 });
    expect(frt.result.matches).toHaveLength(1);
    expect(frt.result.matches[0]).toMatchObject({
      code: 3102,
      name: 'Nutrient nitrogen N (total)',
    });
    expect(frt.enrichment.truncated).toBe(false);
    expect(frt.enrichment.nextOffset).toBeUndefined();
  });

  it('composes the domain scope with the pagination window (total + pages stay scoped)', async () => {
    // LND has 3 items; the shared vocabulary has 6. Paging the scoped set at limit 2
    // must report total 3 and window LND's items only — never leak FRT codes. This
    // is the #7/#8 coupling: the scope is applied before the LIMIT/offset window.
    const page1 = await resolve({ domain: 'LND', dimension: 'item', limit: 2, offset: 0 });
    expect(page1.result.matches.map((m) => m.code)).toEqual([6600, 6601]);
    expect(page1.enrichment.totalMatches).toBe(3);
    expect(page1.enrichment.truncated).toBe(true);
    expect(page1.enrichment.nextOffset).toBe(2);

    const page2 = await resolve({ domain: 'LND', dimension: 'item', limit: 2, offset: 2 });
    expect(page2.result.matches.map((m) => m.code)).toEqual([6620]);
    expect(page2.enrichment.truncated).toBe(false);
    expect(page2.enrichment.nextOffset).toBeUndefined();

    // The union across pages is exactly LND's item set — contiguous, no leak.
    const paged = [...page1.result.matches, ...page2.result.matches].map((m) => m.code);
    expect(paged).toEqual([6600, 6601, 6620]);
    expect(paged).not.toContain(3102);
  });
});

describe('faostat_resolve_codes single-code and paged domain scope (#36)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-domain-scope-36-'));
    mirror = await syncDomains(dir, { GRA: GRA_VOCAB, GRB: GRB_VOCAB });
  });

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scopes a query to a domain whose cube carries a single code', async () => {
    // "grain" matches all five items in the shared vocabulary; GRB's cube has only 102.
    const item = await resolve({ domain: 'GRB', dimension: 'item', query: 'grain' });
    expect(item.result.matches.map((m) => m.code)).toEqual([102]);
    expect(item.enrichment.totalMatches).toBe(1);
    expect(item.enrichment.truncated).toBe(false);

    // A term only another domain's code carries resolves to nothing.
    const maize = await resolve({ domain: 'GRB', dimension: 'item', query: 'maize' });
    expect(maize.result.matches).toEqual([]);
    expect(maize.enrichment.totalMatches).toBe(0);
    expect(maize.enrichment.notice).toMatch(/No item matched query "maize" in domain GRB/);

    const element = await resolve({ domain: 'GRB', dimension: 'element', query: 'production' });
    expect(element.result.matches).toEqual([]);
    expect(element.enrichment.totalMatches).toBe(0);
  });

  it('scopes name_contains, list-all, and an exact code to a single-code domain', async () => {
    const like = await resolve({ domain: 'GRB', dimension: 'item', name_contains: 'grain' });
    expect(like.result.matches.map((m) => m.code)).toEqual([102]);
    expect(like.enrichment.totalMatches).toBe(1);

    const likeElement = await resolve({
      domain: 'GRB',
      dimension: 'element',
      name_contains: 'prod',
    });
    expect(likeElement.result.matches).toEqual([]);
    expect(likeElement.enrichment.totalMatches).toBe(0);

    const all = await resolve({ domain: 'GRB', dimension: 'item', limit: 200 });
    expect(all.result.matches.map((m) => m.code)).toEqual([102]);
    expect(all.enrichment.totalMatches).toBe(1);

    const foreign = await resolve({ domain: 'GRB', dimension: 'item', code: 101 });
    expect(foreign.result.matches).toEqual([]);
    const own = await resolve({ domain: 'GRB', dimension: 'item', code: 102 });
    expect(own.result.matches.map((m) => m.code)).toEqual([102]);
  });

  it('pages a scoped query in rank-then-code order with an exact total', async () => {
    // GRA's four "grain" items; GRB's 102 also matches and must never appear. The
    // one-word label ranks first; the two-word labels tie on rank and fall back to
    // code order, so the pages tile the scoped set with no gap or overlap.
    const query = { domain: 'GRA', dimension: 'item', query: 'grain', limit: 2 };
    const page1 = await resolve(query);
    expect(page1.result.matches.map((m) => m.code)).toEqual([101, 103]);
    expect(page1.enrichment.totalMatches).toBe(4);
    expect(page1.enrichment.truncated).toBe(true);
    expect(page1.enrichment.nextOffset).toBe(2);

    const page2 = await resolve({ ...query, offset: 2 });
    expect(page2.result.matches.map((m) => m.code)).toEqual([105, 107]);
    expect(page2.enrichment.totalMatches).toBe(4);
    expect(page2.enrichment.truncated).toBe(false);
    expect(page2.enrichment.nextOffset).toBeUndefined();

    // Past the end of the scoped set: an empty page that still reports the scoped total.
    const past = await resolve({ ...query, offset: 4 });
    expect(past.result.matches).toEqual([]);
    expect(past.enrichment.totalMatches).toBe(4);
    expect(past.enrichment.notice).toMatch(/Offset 4 is past the 4 item match\(es\)/);
  });

  it('pages a scoped name_contains in code order with an exact total', async () => {
    const page1 = await resolve({
      domain: 'GRA',
      dimension: 'item',
      name_contains: 'grain',
      limit: 3,
    });
    expect(page1.result.matches.map((m) => m.code)).toEqual([101, 103, 105]);
    expect(page1.enrichment.totalMatches).toBe(4);
    expect(page1.enrichment.nextOffset).toBe(3);
  });
});
