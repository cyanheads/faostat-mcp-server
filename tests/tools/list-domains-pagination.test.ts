/**
 * @fileoverview Bounded catalog retrieval for `faostat_list_domains` (#16). The
 * tool returned the entire ~69-domain manifest — descriptions and all — on every
 * unfiltered call, which spends most of a small model's context before it has
 * asked a data question, and it offered no way to page or to pull one domain by
 * code. These lock the fix: `offset` + `limit` page the code-sorted match set,
 * `truncated` / `nextOffset` disclose the cap and the exact next retrieval input,
 * consecutive pages tile the catalog gap- and duplicate-free, an exact `code`
 * lookup is single-page and bypasses `topic` / `indexed_only`, and `totalCount`
 * keeps its shipped meaning (whole catalog) distinct from `totalMatches` (the
 * filtered set this page was cut from). Every field a caller had before survives
 * on both surfaces.
 * @module tests/tools/list-domains-pagination
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDomainsTool } from '@/mcp-server/tools/definitions/list-domains.tool.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import type { ManifestDataset } from '@/services/faostat-mirror/types.js';
import { fixtureManifestResponse } from '../fixtures/synthetic-domain.js';

/** Catalog codes, deliberately out of sort order so the tool's own sort is exercised. */
const CATALOG = [
  { code: 'TCL', name: 'Crops and livestock trade', topic: 'Trade' },
  { code: 'QCL', name: 'Crops and livestock products', topic: 'Production' },
  { code: 'RL', name: 'Land Use', topic: 'Land' },
  { code: 'FBS', name: 'Food Balances', topic: 'Food Balance' },
  { code: 'GLE', name: 'Livestock emissions', topic: 'Emissions' },
  { code: 'FS', name: 'Suite of Food Security Indicators', topic: 'Food Security' },
  { code: 'TM', name: 'Detailed trade matrix', topic: 'Trade' },
] as const;

/** Codes in the order the tool must return them (ascending, `localeCompare`). */
const SORTED_CODES = [...CATALOG.map((d) => d.code)].sort((a, b) => a.localeCompare(b));

/** Only this one is in FAOSTAT_DOMAINS for the tests below. */
const INDEXED_DOMAIN = 'QCL';

function catalogDatasets(): ManifestDataset[] {
  return CATALOG.map((d) => ({
    DatasetCode: d.code,
    DatasetName: d.name,
    Topic: d.topic,
    DatasetDescription: `Long description for ${d.code}.`,
    DateUpdate: '2025-12-31T00:00:00',
    CompressionFormat: 'zip',
    FileType: 'csv',
    FileSize: '77KB',
    FileRows: 1234,
    FileLocation: `https://bulks-faostat.fao.org/production/${d.code}.zip`,
  }));
}

describe('faostat_list_domains bounded retrieval (#16)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-list-domains-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(fixtureManifestResponse(catalogDatasets()))),
    );
    mirror = initFaostatMirror({ dir, domains: [INDEXED_DOMAIN] });
  });

  afterEach(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the tool with a fresh context; return the result plus its enrichment. */
  async function list(input: Record<string, unknown> = {}) {
    const ctx = createMockContext({ tenantId: 't' });
    const result = await listDomainsTool.handler(listDomainsTool.input.parse(input), ctx);
    return { result, enrichment: getEnrichment(ctx) };
  }

  it('pages the catalog with nextOffset and a continue notice, no gaps or duplicates', async () => {
    const page1 = await list({ limit: 3, offset: 0 });
    expect(page1.result.domains.map((d) => d.code)).toEqual(SORTED_CODES.slice(0, 3));
    expect(page1.enrichment.totalMatches).toBe(CATALOG.length);
    expect(page1.enrichment.truncated).toBe(true);
    expect(page1.enrichment.nextOffset).toBe(3);
    // The continue notice names the offset to resume at.
    expect(page1.enrichment.notice).toMatch(/offset 3/);
    expect(page1.enrichment.notice).toMatch(/next page/i);

    const page2 = await list({ limit: 3, offset: 3 });
    expect(page2.result.domains.map((d) => d.code)).toEqual(SORTED_CODES.slice(3, 6));
    expect(page2.enrichment.nextOffset).toBe(6);

    // The final page drains the tail and stops paging.
    const page3 = await list({ limit: 3, offset: 6 });
    expect(page3.result.domains.map((d) => d.code)).toEqual(SORTED_CODES.slice(6));
    expect(page3.enrichment.truncated).toBe(false);
    expect(page3.enrichment.nextOffset).toBeUndefined();

    // Consecutive pages tile the catalog exactly — no gaps, no duplicates.
    const all = [page1, page2, page3].flatMap((p) => p.result.domains.map((d) => d.code));
    expect(all).toEqual(SORTED_CODES);
    expect(new Set(all).size).toBe(all.length);
  });

  it('caps an unbounded browse call and discloses how to continue', async () => {
    // No limit passed — the default must bound the response rather than dumping
    // the whole catalog, and must say so.
    const { result, enrichment } = await list();
    expect(result.domains.length).toBeLessThanOrEqual(
      listDomainsTool.input.parse({}).limit as number,
    );
    expect(enrichment.totalCount).toBe(CATALOG.length);
    expect(enrichment.totalMatches).toBe(CATALOG.length);
    expect(typeof enrichment.truncated).toBe('boolean');
  });

  it('reports an offset past the end without pretending the catalog is empty', async () => {
    const { result, enrichment } = await list({ limit: 3, offset: 99 });
    expect(result.domains).toEqual([]);
    expect(enrichment.totalMatches).toBe(CATALOG.length);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toMatch(/Offset 99 is past the 7 matching domain\(s\)/);
  });

  it('keeps totalCount as whole-catalog size while topic narrows totalMatches', async () => {
    const { result, enrichment } = await list({ topic: 'trade', limit: 10 });
    expect(result.domains.map((d) => d.code)).toEqual(['TCL', 'TM']);
    // The two numbers must not collapse into one: totalCount is the catalog,
    // totalMatches is what the filter left.
    expect(enrichment.totalCount).toBe(CATALOG.length);
    expect(enrichment.totalMatches).toBe(2);
    expect(enrichment.truncated).toBe(false);
  });

  it('resolves an exact code to a single-page full record, case-insensitively', async () => {
    const { result, enrichment } = await list({ code: 'rl' });
    expect(result.domains).toHaveLength(1);
    const [domain] = result.domains;
    // Every field a paged listing carries is present on the exact lookup too.
    expect(domain).toMatchObject({
      code: 'RL',
      name: 'Land Use',
      topic: 'Land',
      description: 'Long description for RL.',
      last_update: '2025-12-31T00:00:00',
      upstream_row_count: 1234,
      file_size_in_bytes: 77_000,
      indexed: false,
      index_ready: false,
    });
    expect(enrichment.totalMatches).toBe(1);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.nextOffset).toBeUndefined();
  });

  it('lets an exact code outrank topic and indexed_only', async () => {
    // RL is neither indexed nor a "trade" domain — the lookup still returns it,
    // so "does this domain exist, and is it queryable?" is one call.
    const { result } = await list({ code: 'RL', topic: 'trade', indexed_only: true });
    expect(result.domains.map((d) => d.code)).toEqual(['RL']);
    expect(result.domains[0]?.indexed).toBe(false);
  });

  it('returns an actionable notice for a code that matches nothing', async () => {
    const { result, enrichment } = await list({ code: 'NOPE' });
    expect(result.domains).toEqual([]);
    expect(enrichment.totalMatches).toBe(0);
    expect(enrichment.notice).toMatch(/No domain matched code "NOPE"/);
  });

  it('still honors indexed_only alongside paging', async () => {
    const { result, enrichment } = await list({ indexed_only: true });
    expect(result.domains.map((d) => d.code)).toEqual([INDEXED_DOMAIN]);
    expect(enrichment.totalMatches).toBe(1);
    expect(enrichment.indexedCount).toBe(1);
    expect(enrichment.truncated).toBe(false);
  });

  it('renders every paged domain into content[] so both surfaces agree', async () => {
    const { result } = await list({ limit: 3, offset: 0 });
    const text = listDomainsTool
      .format(result)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toContain('**3 domain(s):**');
    for (const d of result.domains) {
      expect(text).toContain(`### ${d.code} — ${d.name}`);
      expect(text).toContain(`Long description for ${d.code}.`);
    }
    // Domains on later pages must not leak into this page's render.
    for (const code of SORTED_CODES.slice(3)) {
      expect(text).not.toContain(`### ${code} —`);
    }
  });
});
