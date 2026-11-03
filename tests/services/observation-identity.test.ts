/**
 * @fileoverview Regression coverage for bulk item, period and source identity.
 * @module tests/services/observation-identity
 */
import { describe, expect, it } from 'vitest';
import { headerIndex } from '@/services/faostat-mirror/csv.js';
import { dataRowToObservation, parseItemCodes } from '@/services/faostat-mirror/ingester.js';

const columns = headerIndex([
  'Area Code',
  'Item Code',
  'Element Code',
  'Year Code',
  'Year',
  'Value',
  'Flag',
  'Source Code',
  'Source',
]);
const row = (item = '15', year = '2020', value = '1', source = '', label = '') =>
  dataRowToObservation(
    ['231', item, '72254', '20002002', year, value, 'E', source, label],
    columns,
  );

describe('observation identity', () => {
  it('characterizes unchanged numeric annual keys and blank values', () => {
    expect(row()?.id).toBe('231|15|72254|2020');
    expect(row('15', '2020', '')?.value).toBeNull();
    expect(row('1e2')?.item_code).toBe(100);
  });
  it('preserves exact alpha item identities and period midpoints', () => {
    expect(row('210401F', '2000-2002', '<2.5')).toMatchObject({
      item_code: null,
      item_code_text: '210401F',
      year: 2001,
      period: '2000-2002',
      value: 2.5,
      value_qualifier: '<',
      flag: 'E',
    });
    expect(parseItemCodes('Item Code,Item\n210401F,Food')).toEqual([
      { item_code: null, item_code_text: '210401F', item: 'Food', cpc_code: null },
    ]);
  });
  it('keeps competing methodologies distinct with original numeric source codes', () => {
    const tier = row('960', '2020', '1195.8528', '3050', 'FAO TIER 1');
    const unfccc = row('960', '2020', '1397.9604', '3051', 'UNFCCC');
    expect(tier?.id).not.toBe(unfccc?.id);
    expect(tier).toMatchObject({ source_code: 3050, source: 'FAO TIER 1', value: 1195.8528 });
    expect(unfccc).toMatchObject({ source_code: 3051, source: 'UNFCCC', value: 1397.9604 });
  });
  it.each(['\n', '\r\n'])(
    'bounds malformed item and period scans with %j line endings',
    (linebreak) => {
      for (const size of [1_000, 10_000, 100_000]) {
        const started = process.cpuUsage();
        expect(row(`${'2'.repeat(size)}F${linebreak}!`)).toBeNull();
        expect(row('15', `${'2'.repeat(size)}${linebreak}!`)).toBeNull();
        const cpu = process.cpuUsage(started);
        process.stdout.write(
          `identity-scan size=${size} linebreak=${JSON.stringify(linebreak)} cpuUs=${cpu.user + cpu.system}\n`,
        );
      }
    },
  );
});
