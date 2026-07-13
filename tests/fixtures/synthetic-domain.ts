/**
 * @fileoverview Synthetic FAOSTAT domain ZIP builder for offline tests. Produces
 * a real fflate ZIP with the standard normalized-cube data CSV plus the four
 * bundled dimension code-list CSVs, matching the verified FAOSTAT layout
 * (apostrophe-prefixed M49/CPC codes, the aggregate-region area codes ≥ 5000,
 * a quoted Note field containing a comma). Mock `fetch` to return it.
 * @module tests/fixtures/synthetic-domain
 */

import { strToU8, type Zippable, zipSync } from 'fflate';
import type { ManifestDataset } from '@/services/faostat-mirror/types.js';

/** Header for the standard normalized data CSV (13 columns). */
const DATA_HEADER =
  'Area Code,Area Code (M49),Area,Item Code,Item,Element Code,Element,Year Code,Year,Unit,Value,Flag,Note';

/**
 * Rows for a tiny QCL-shaped fixture: two countries (Afghanistan=2, China=351),
 * one aggregate (World=5000), one item (Wheat=15), one element (Production=5510),
 * two years. The China 2021 row carries a quoted Note with an embedded comma to
 * exercise the CSV splitter.
 */
const DATA_ROWS: string[] = [
  `2,'004,Afghanistan,15,Wheat,5510,Production,2020,2020,t,5000.000000,A,Official data`,
  `2,'004,Afghanistan,15,Wheat,5510,Production,2021,2021,t,5200.000000,E,Estimated value`,
  `351,'156,China,15,Wheat,5510,Production,2020,2020,t,134250.000000,A,"Official data, questionnaire"`,
  `351,'156,China,15,Wheat,5510,Production,2021,2021,t,136950.000000,A,Official data`,
  `5000,'001,World,15,Wheat,5510,Production,2020,2020,t,760000.000000,A,Aggregate`,
  `5000,'001,World,15,Wheat,5510,Production,2021,2021,t,770000.000000,A,Aggregate`,
];

const AREA_CODES_CSV = [
  'Area Code,M49 Code,Area',
  `2,'004,Afghanistan`,
  `351,'156,China`,
  `5000,'001,World`,
].join('\n');

const ITEM_CODES_CSV = ['Item Code,CPC Code,Item', `15,'0111,Wheat`].join('\n');

const ELEMENTS_CSV = ['Element Code,Element', '5510,Production', '5610,Import quantity'].join('\n');

const FLAGS_CSV = [
  'Flag,Description',
  'A,Official figure',
  'E,Estimated value',
  'I,Imputed value',
].join('\n');

/** The synthetic domain code used across tests. */
export const FIXTURE_DOMAIN = 'QCL';

/** Build the synthetic domain ZIP as a Uint8Array (real fflate ZIP). */
export function buildDomainZip(domain = FIXTURE_DOMAIN): Uint8Array {
  const base = `Production_Crops_Livestock_${domain}`;
  const files: Zippable = {
    [`${base}_E_All_Data_(Normalized).csv`]: strToU8([DATA_HEADER, ...DATA_ROWS].join('\n')),
    [`${base}_E_AreaCodes.csv`]: strToU8(AREA_CODES_CSV),
    [`${base}_E_ItemCodes.csv`]: strToU8(ITEM_CODES_CSV),
    [`${base}_E_Elements.csv`]: strToU8(ELEMENTS_CSV),
    [`${base}_E_Flags.csv`]: strToU8(FLAGS_CSV),
    'README.txt': strToU8('ignored non-cube entry'),
  };
  return zipSync(files);
}

/**
 * Build a mid-size synthetic domain: `countryCount` distinct country codes (area
 * codes 1..countryCount, all < 5000) plus `aggregateCount` aggregate-region codes
 * (codes 5000+), each emitted across `years` consecutive years starting 2020, for
 * one item (Wheat=15) / element (Production=5510). Sized for the spillover
 * dead-band test at `years: 1` — a few hundred rows serialize well under the
 * 100k-char inline budget yet exceed the inline-page `limit`. Raise `years` to
 * cross the 50,000-row staging cap using only country codes (< 5000), which the
 * country-only production path in commodity_profile and the default
 * aggregate-excluding query both require to reach truncation. Returns the ZIP plus
 * the exact row counts (`total = (countryCount + aggregateCount) * years`).
 */
export function buildMidSizeDomainZip(opts: {
  domain?: string;
  countryCount: number;
  aggregateCount?: number;
  years?: number;
}): { zip: Uint8Array; total: number; countryCount: number; aggregateCount: number } {
  const domain = opts.domain ?? FIXTURE_DOMAIN;
  const aggregateCount = opts.aggregateCount ?? 0;
  const years = opts.years ?? 1;
  const base = `Production_Crops_Livestock_${domain}`;

  const dataRows: string[] = [];
  const areaRows: string[] = ['Area Code,M49 Code,Area'];
  for (let i = 1; i <= opts.countryCount; i++) {
    const m49 = String(i).padStart(3, '0');
    const name = `Country ${i}`;
    const value = (1000 + i).toFixed(6);
    const flag = i % 3 === 0 ? 'I' : i % 3 === 1 ? 'A' : 'E';
    for (let y = 0; y < years; y++) {
      const year = 2020 + y;
      dataRows.push(
        `${i},'${m49},${name},15,Wheat,5510,Production,${year},${year},t,${value},${flag},Synth`,
      );
    }
    areaRows.push(`${i},'${m49},${name}`);
  }
  for (let a = 0; a < aggregateCount; a++) {
    const code = 5000 + a;
    const m49 = String(900 + a).padStart(3, '0');
    const name = `Region ${a}`;
    const value = (900000 + a).toFixed(6);
    for (let y = 0; y < years; y++) {
      const year = 2020 + y;
      dataRows.push(
        `${code},'${m49},${name},15,Wheat,5510,Production,${year},${year},t,${value},A,Aggregate`,
      );
    }
    areaRows.push(`${code},'${m49},${name}`);
  }

  const files: Zippable = {
    [`${base}_E_All_Data_(Normalized).csv`]: strToU8([DATA_HEADER, ...dataRows].join('\n')),
    [`${base}_E_AreaCodes.csv`]: strToU8(areaRows.join('\n')),
    [`${base}_E_ItemCodes.csv`]: strToU8(ITEM_CODES_CSV),
    [`${base}_E_Elements.csv`]: strToU8(ELEMENTS_CSV),
    [`${base}_E_Flags.csv`]: strToU8(FLAGS_CSV),
  };
  return {
    zip: zipSync(files),
    total: (opts.countryCount + aggregateCount) * years,
    countryCount: opts.countryCount,
    aggregateCount,
  };
}

/** A manifest dataset entry pointing at the fixture ZIP. */
export function fixtureDataset(domain = FIXTURE_DOMAIN): ManifestDataset {
  return {
    DatasetCode: domain,
    DatasetName: 'Production: Crops and livestock products',
    Topic: 'Production',
    DateUpdate: '2025-12-31T00:00:00',
    CompressionFormat: 'zip',
    FileType: 'csv',
    FileSize: '1KB',
    // Live manifest emits FileRows as a JSON number, not a quoted string.
    FileRows: 6,
    FileLocation: `https://bulks-faostat.fao.org/production/Production_Crops_Livestock_${domain}_E_All_Data_(Normalized).zip`,
  };
}

/** A manifest JSON response carrying the fixture dataset(s). */
export function fixtureManifestResponse(datasets = [fixtureDataset()]) {
  return { Datasets: { '-xmlns:xsi': 'http://example', Dataset: datasets } };
}

/** Wrap a byte buffer in a chunked `Response` (exercises the streaming path). */
export function chunkedResponse(bytes: Uint8Array, chunkSize = 64): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'last-modified': 'Wed, 31 Dec 2025 00:00:00 GMT' },
  });
}
