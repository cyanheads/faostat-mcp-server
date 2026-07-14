/**
 * @fileoverview Tests for the pure ingester parse helpers — column mapping off
 * the real header, M49/CPC apostrophe stripping, Year/Year-Code fallback,
 * aggregate-code classification, and the dimension code-list parsers.
 * @module tests/services/ingester-parse
 */

import { describe, expect, it } from 'vitest';
import { headerIndex, parseCsvLine } from '@/services/faostat-mirror/csv.js';
import {
  dataRowToObservation,
  parseAreaCodes,
  parseElementCodes,
  parseFlags,
  parseItemCodes,
} from '@/services/faostat-mirror/ingester.js';

const HEADER = headerIndex(
  parseCsvLine(
    'Area Code,Area Code (M49),Area,Item Code,Item,Element Code,Element,Year Code,Year,Unit,Value,Flag,Note',
  ),
);

describe('dataRowToObservation', () => {
  it('maps a standard cube row, stripping the M49 apostrophe and storing Year', () => {
    const fields = parseCsvLine(
      `2,'004,Afghanistan,15,Wheat,5510,Production,2020,2020,t,5000.000000,A,Official data`,
    );
    const obs = dataRowToObservation(fields, HEADER);
    expect(obs).toEqual({
      id: '2|15|5510|2020',
      area_code: 2,
      area_m49: '004',
      area: 'Afghanistan',
      item_code: 15,
      item: 'Wheat',
      element_code: 5510,
      element: 'Production',
      year: 2020,
      unit: 't',
      value: 5000,
      flag: 'A',
      note: 'Official data',
    });
  });

  it('preserves a quoted Note with an embedded comma and nulls an empty value', () => {
    const fields = parseCsvLine(
      `351,'156,China,15,Wheat,5510,Production,2020,2020,t,,A,"Official data, questionnaire"`,
    );
    const obs = dataRowToObservation(fields, HEADER);
    expect(obs?.value).toBeNull();
    expect(obs?.note).toBe('Official data, questionnaire');
  });

  it('returns null when a required code is non-numeric', () => {
    const fields = parseCsvLine(`x,'004,Afghanistan,15,Wheat,5510,Production,2020,2020,t,1,A,`);
    expect(dataRowToObservation(fields, HEADER)).toBeNull();
  });

  it('falls back to Year Code when Year is absent', () => {
    const header = headerIndex(
      parseCsvLine(
        'Area Code,Area Code (M49),Area,Item Code,Item,Element Code,Element,Year Code,Unit,Value,Flag',
      ),
    );
    const fields = parseCsvLine(`2,'004,Afghanistan,15,Wheat,5510,Production,1999,t,1,A`);
    expect(dataRowToObservation(fields, header)?.year).toBe(1999);
  });
});

describe('dimension code-list parsers', () => {
  it('parses AreaCodes and classifies country vs aggregate at the ≥5000 boundary', () => {
    const areas = parseAreaCodes("Area Code,M49 Code,Area\n2,'004,Afghanistan\n5000,'001,World");
    expect(areas).toEqual([
      { area_code: 2, area_m49: '004', area: 'Afghanistan', kind: 'country' },
      { area_code: 5000, area_m49: '001', area: 'World', kind: 'aggregate' },
    ]);
  });

  it('classifies sub-5000 roll-up areas (China 351 / 265) as aggregate via the deny-set', () => {
    // 351 "China" (mainland + Taiwan + HK + Macao) and 265 "China (excluding
    // intra-trade)" roll up members but sit below the numeric threshold — the
    // curated deny-set, not the >=5000 rule, must flag them aggregate so a default
    // query stays sum-safe (#4). 41 "China; mainland" is a real country alongside.
    const areas = parseAreaCodes(
      "Area Code,M49 Code,Area\n41,'156,China; mainland\n265,'159,China (excluding intra-trade)\n351,'159,China",
    );
    const byCode = new Map(areas.map((a) => [a.area_code, a.kind]));
    expect(byCode.get(41)).toBe('country');
    expect(byCode.get(265)).toBe('aggregate');
    expect(byCode.get(351)).toBe('aggregate');
  });

  it('parses ItemCodes and strips the CPC apostrophe', () => {
    const items = parseItemCodes("Item Code,CPC Code,Item\n15,'0111,Wheat");
    expect(items).toEqual([{ item_code: 15, cpc_code: '0111', item: 'Wheat' }]);
  });

  it('parses Elements de-duplicating repeated codes', () => {
    const els = parseElementCodes(
      'Element Code,Element\n5510,Production\n5510,Production\n5610,Import',
    );
    expect(els).toEqual([
      { element_code: 5510, element: 'Production' },
      { element_code: 5610, element: 'Import' },
    ]);
  });

  it('parses Flags', () => {
    const flags = parseFlags('Flag,Description\nA,Official figure\nE,Estimated value');
    expect(flags).toEqual([
      { flag: 'A', description: 'Official figure' },
      { flag: 'E', description: 'Estimated value' },
    ]);
  });
});
