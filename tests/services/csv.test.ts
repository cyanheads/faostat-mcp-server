/**
 * @fileoverview Tests for the streaming CSV helpers — quoted-field parsing with
 * embedded commas, the chunk-boundary record splitter, and apostrophe stripping.
 * @module tests/services/csv
 */

import { describe, expect, it } from 'vitest';
import { CsvRecordSplitter, parseCsvLine, stripApostrophe } from '@/services/faostat-mirror/csv.js';

describe('parseCsvLine', () => {
  it('parses plain comma-separated fields, trimming unquoted whitespace', () => {
    expect(parseCsvLine('Area Code, M49 Code, Area')).toEqual(['Area Code', 'M49 Code', 'Area']);
  });

  it('preserves commas inside quoted fields', () => {
    expect(parseCsvLine('351,China,"Official data, questionnaire",A')).toEqual([
      '351',
      'China',
      'Official data, questionnaire',
      'A',
    ]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvLine('1,"a ""quoted"" word",x')).toEqual(['1', 'a "quoted" word', 'x']);
  });

  it('returns a single empty field for undefined input', () => {
    expect(parseCsvLine(undefined)).toEqual(['']);
  });
});

describe('CsvRecordSplitter', () => {
  it('emits complete records across chunk boundaries', () => {
    const splitter = new CsvRecordSplitter();
    const out: string[] = [];
    out.push(...splitter.push('a,b,c\nd,'));
    out.push(...splitter.push('e,f\ng,h'));
    const last = splitter.flush();
    if (last) out.push(last);
    expect(out).toEqual(['a,b,c', 'd,e,f', 'g,h']);
  });

  it('does not split on a newline inside a quoted field', () => {
    const splitter = new CsvRecordSplitter();
    const out = splitter.push('1,"line one\nline two",x\n2,y,z\n');
    expect(out).toEqual(['1,"line one\nline two",x', '2,y,z']);
  });

  it('handles \\r\\n line endings', () => {
    const splitter = new CsvRecordSplitter();
    const out = splitter.push('a,b\r\nc,d\r\n');
    expect(out).toEqual(['a,b', 'c,d']);
  });
});

describe('stripApostrophe', () => {
  it('strips a leading apostrophe from M49 / CPC codes', () => {
    expect(stripApostrophe("'004")).toBe('004');
    expect(stripApostrophe("'F3102")).toBe('F3102');
  });

  it('returns null for empty / whitespace / undefined', () => {
    expect(stripApostrophe('')).toBeNull();
    expect(stripApostrophe('   ')).toBeNull();
    expect(stripApostrophe(undefined)).toBeNull();
  });

  it('leaves an un-prefixed value unchanged', () => {
    expect(stripApostrophe('156')).toBe('156');
  });
});
