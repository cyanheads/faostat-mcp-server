/**
 * @fileoverview Asserts the FAOSTAT bulk fetches send an identifying User-Agent.
 * The FAO bulk host (`bulks-faostat.fao.org`) sits behind a WAF that rejects an
 * absent/empty User-Agent with HTTP 403; both the manifest fetch and every
 * per-domain ZIP download must carry one. Verified against the live host:
 * `curl -A ''` → 403, default UA → 200.
 * @module tests/services/http-headers
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FaostatMirror } from '@/services/faostat-mirror/faostat-mirror.js';
import { FAOSTAT_USER_AGENT } from '@/services/faostat-mirror/http.js';
import { fetchManifest } from '@/services/faostat-mirror/manifest.js';
import {
  buildDomainZip,
  chunkedResponse,
  FIXTURE_DOMAIN,
  fixtureDataset,
  fixtureManifestResponse,
} from '../fixtures/synthetic-domain.js';

/** Pull the headers passed to a fetch mock call as a case-insensitive lookup. */
function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? {});
}

describe('FAOSTAT bulk fetches carry an identifying User-Agent', () => {
  it('sends a non-empty User-Agent on the manifest fetch', async () => {
    const fetchSpy = vi.fn(async () => Response.json(fixtureManifestResponse()));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await fetchManifest('https://bulks-faostat.fao.org/production', new AbortController().signal);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const ua = headersOf(fetchSpy.mock.calls[0]?.[1]).get('user-agent');
      expect(ua).toBe(FAOSTAT_USER_AGENT);
      expect(ua).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends a non-empty User-Agent on the domain ZIP download', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'faostat-ua-'));
    const zip = buildDomainZip();
    const fetchSpy = vi.fn(async () => chunkedResponse(zip, 256));
    vi.stubGlobal('fetch', fetchSpy);
    const mirror = new FaostatMirror({ dir, domains: [FIXTURE_DOMAIN] });
    try {
      await mirror.runDomainSync(FIXTURE_DOMAIN, 'init', {
        signal: new AbortController().signal,
        dataset: fixtureDataset(),
      });
      // The ingester performs exactly one fetch — the ZIP download.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const ua = headersOf(fetchSpy.mock.calls[0]?.[1]).get('user-agent');
      expect(ua).toBe(FAOSTAT_USER_AGENT);
    } finally {
      await mirror.close();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
