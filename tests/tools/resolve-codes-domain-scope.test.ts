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
 * Also covers the #7 coupling: the domain scope is a SQL predicate applied BEFORE
 * the pagination window, so `totalMatches`/`nextOffset` reflect the domain-scoped
 * set — not the global vocabulary — and paging never leaks another domain's codes.
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

describe('faostat_resolve_codes domain-scoped resolution (#8)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-domain-scope-'));
    const zips: Record<string, Uint8Array> = {
      LND: buildDomainZip('LND', LND_VOCAB),
      FRT: buildDomainZip('FRT', FRT_VOCAB),
    };
    // Serve each domain's ZIP by the domain token in its bulk URL.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const domain = String(url).includes('_LND_') ? 'LND' : 'FRT';
        return chunkedResponse(zips[domain], 1 << 16);
      }),
    );
    mirror = initFaostatMirror({ dir, domains: ['LND', 'FRT'] });
    // Sync both so the shared dimension vocabulary is the union of the two domains.
    for (const code of ['LND', 'FRT']) {
      await mirror.runDomainSync(code, 'init', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(code),
      });
    }
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
