/**
 * @fileoverview `faostat_commodity_profile` truthful-notice regression (#1). The
 * tool stages its merged production+trade set to a canvas table only when the
 * set overflows the inline char budget. When it fits, the rankings already cover
 * the full result — but the old notice/format told the caller to enable
 * `CANVAS_PROVIDER_TYPE=duckdb` even with the canvas on. This asserts the
 * canvas-on-but-fit path emits guidance that doesn't imply the canvas is off.
 * @module tests/tools/commodity-profile-notice
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commodityProfileTool } from '@/mcp-server/tools/definitions/commodity-profile.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { type FaostatMirror, initFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  buildDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
} from '../fixtures/synthetic-domain.js';

let canvas: DataCanvas;

beforeAll(() => {
  const cfg = parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb' });
  const built = createCanvasService(cfg);
  if (!built) throw new Error('expected a DuckDB canvas to be constructed for the test');
  canvas = built;
  setCanvas(canvas);
});

afterAll(async () => {
  setCanvas(undefined);
  await canvas.shutdown(createMockContext({ tenantId: 'teardown' }));
});

describe('faostat_commodity_profile notice (canvas on, merged set fits inline)', () => {
  let dir: string;
  let mirror: FaostatMirror;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'faostat-profile-'));
    const zip = buildDomainZip(); // QCL with Wheat (15) / Production (5510)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunkedResponse(zip, 64)),
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

  it('does not advise enabling an already-on canvas when the set fits inline', async () => {
    const ctx = createMockContext({ tenantId: 'profile', errors: commodityProfileTool.errors });
    const input = commodityProfileTool.input.parse({ item_query: 'wheat' });
    const result = await commodityProfileTool.handler(input, ctx);

    // Small fixture: the merged set fits under the char budget, so no table.
    expect(result.spilled).toBe(false);
    // canvas_id is still surfaced (the canvas is on) — the discriminator the
    // format() uses to avoid the misleading "enable canvas" line.
    expect(result.canvas_id).toBeDefined();
    expect(result.top_producers.length).toBeGreaterThan(0);

    const notice = getEnrichment(ctx).notice as string | undefined;
    if (notice !== undefined) {
      expect(notice).not.toMatch(/CANVAS_PROVIDER_TYPE/i);
      expect(notice).not.toMatch(/enable.*canvas/i);
    }

    // The content[] twin must not tell the caller to enable a canvas that is on.
    const formatted = commodityProfileTool.format(result);
    const text = formatted.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).not.toMatch(/CANVAS_PROVIDER_TYPE/i);
    expect(text).not.toMatch(/enable.*duckdb/i);
  });
});
