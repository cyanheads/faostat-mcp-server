/**
 * @fileoverview Tests for the manifest field parsers. The live bulk manifest
 * emits `FileRows` as a JSON number and `FileSize` as a units string; an earlier
 * `.trim()` on `FileRows` crashed `faostat_list_domains` on every real call
 * (the field was typed `string`). These cover both the real number shape and the
 * legacy quoted-string shape so the boundary parse stays robust.
 * @module tests/services/manifest
 */

import { describe, expect, it } from 'vitest';
import {
  findDataset,
  parseFileRows,
  parseFileSizeBytes,
} from '@/services/faostat-mirror/manifest.js';
import type { ManifestDataset } from '@/services/faostat-mirror/types.js';

describe('parseFileRows', () => {
  it('parses a JSON number (the live manifest shape)', () => {
    expect(parseFileRows(413211)).toBe(413211);
  });

  it('parses a quoted-string count (legacy/defensive)', () => {
    expect(parseFileRows('413211')).toBe(413211);
    expect(parseFileRows('  241859  ')).toBe(241859);
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseFileRows(undefined)).toBeNull();
    expect(parseFileRows('not-a-number')).toBeNull();
    expect(parseFileRows(Number.NaN)).toBeNull();
  });
});

describe('parseFileSizeBytes', () => {
  it('parses unit-suffixed size strings (the live manifest shape)', () => {
    expect(parseFileSizeBytes('77KB')).toBe(77_000);
    expect(parseFileSizeBytes('271MB')).toBe(271_000_000);
    expect(parseFileSizeBytes('1.48GB')).toBe(1_480_000_000);
    expect(parseFileSizeBytes('512')).toBe(512); // bare number string → bytes
  });

  it('parses a bare number as bytes (defensive against upstream type drift)', () => {
    expect(parseFileSizeBytes(2_891_000)).toBe(2_891_000);
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseFileSizeBytes(undefined)).toBeNull();
    expect(parseFileSizeBytes('garbage')).toBeNull();
  });
});

describe('findDataset', () => {
  const datasets: ManifestDataset[] = [
    {
      DatasetCode: 'RL',
      DatasetName: 'Land Use',
      DateUpdate: '2025-11-14T00:00:00',
      FileLocation: 'x',
    },
    {
      DatasetCode: 'RFN',
      DatasetName: 'Fertilizers',
      DateUpdate: '2025-07-11T00:00:00',
      FileLocation: 'y',
    },
  ];

  it('matches a domain code case-insensitively', () => {
    expect(findDataset(datasets, 'rl')?.DatasetName).toBe('Land Use');
    expect(findDataset(datasets, 'RFN')?.DatasetName).toBe('Fertilizers');
  });

  it('returns undefined for an unknown code', () => {
    expect(findDataset(datasets, 'QCL')).toBeUndefined();
  });
});
