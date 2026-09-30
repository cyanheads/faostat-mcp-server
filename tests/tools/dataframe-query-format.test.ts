/**
 * @fileoverview `faostat_dataframe_query` Markdown-cell escaping (#26,
 * CodeQL `js/incomplete-sanitization`). The formatter used to escape `|` while
 * leaving `\` alone, so a cell value carrying a backslash before a pipe emitted
 * `\\|` — which a Markdown renderer reads as a literal backslash followed by an
 * UNESCAPED cell separator. The row then splits at a value-controlled point and
 * every later column shifts. A raw newline in a text value ended the row outright.
 *
 * The contract these lock: what a renderer displays in a cell equals the value
 * the tool returned, and one result row renders as exactly one table row with
 * exactly `columns.length` cells. Both consumption paths are covered —
 * `structuredContent` (the handler's `rows`, which must stay raw and unescaped)
 * and `content[]` (`format()`, which must escape).
 * @module tests/tools/dataframe-query-format
 */

import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { renderCell, splitRow } from '../helpers/markdown-table.js';

/** The rendered data rows of the table `format()` produced. */
function dataRows(text: string): string[] {
  const lines = text.split('\n').filter((l) => l.startsWith('|'));
  // Header row, then the `| --- |` delimiter, then the data rows.
  return lines.slice(2);
}

describe('faostat_dataframe_query markdown cell escaping', () => {
  const render = (columns: string[], rows: Record<string, unknown>[]) =>
    (
      dataframeQueryTool.format?.({
        columns,
        row_count: rows.length,
        rows,
        truncated: false,
      }) ?? []
    )
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');

  it('keeps a backslash-then-pipe value inside one cell and renders it verbatim', () => {
    // Characters: x \ | y — the sequence the old `|`-only escape turned into `\\|`.
    const value = 'x\\|y';
    const text = render(['a', 'b'], [{ a: value, b: 'tail' }]);
    const rows = dataRows(text);

    expect(rows).toHaveLength(1);
    const cells = splitRow(rows[0] ?? '');
    // The row must not have split: two columns in, two cells out, `tail` still last.
    expect(cells).toHaveLength(2);
    expect(renderCell(cells[0] ?? '')).toBe(value);
    expect(renderCell(cells[1] ?? '')).toBe('tail');
  });

  it('renders a lone backslash verbatim', () => {
    const value = 'C:\\Users\\data';
    const text = render(['path'], [{ path: value }]);
    const cells = splitRow(dataRows(text)[0] ?? '');
    expect(cells).toHaveLength(1);
    expect(renderCell(cells[0] ?? '')).toBe(value);
  });

  it('escapes an object cell so the serialized JSON survives rendering', () => {
    const value = { note: 'a\\|b' };
    const json = JSON.stringify(value);
    const text = render(['meta', 'b'], [{ meta: value, b: 'tail' }]);
    const rows = dataRows(text);

    expect(rows).toHaveLength(1);
    const cells = splitRow(rows[0] ?? '');
    expect(cells).toHaveLength(2);
    expect(renderCell(cells[0] ?? '')).toBe(json);
    expect(renderCell(cells[1] ?? '')).toBe('tail');
  });

  it('keeps a newline-bearing value on one table row', () => {
    const text = render(['a', 'b'], [{ a: 'line1\nline2', b: 'tail' }]);
    const rows = dataRows(text);

    expect(rows).toHaveLength(1);
    const cells = splitRow(rows[0] ?? '');
    expect(cells).toHaveLength(2);
    expect(cells[0]).not.toContain('\n');
    expect(cells[1]).toBe('tail');
  });

  it('leaves null and numeric cells alone', () => {
    const text = render(['a', 'b', 'c'], [{ a: null, b: 1234, c: undefined }]);
    const cells = splitRow(dataRows(text)[0] ?? '');
    expect(cells).toEqual(['', '1234', '']);
  });

  it('escapes a column alias so the header row keeps its column count', () => {
    // A quoted SQL alias is caller-controlled text, same as a value.
    const alias = 'x\\|y';
    const text = render([alias, 'b'], [{ [alias]: 1, b: 2 }]);
    const header = text.split('\n').filter((l) => l.startsWith('|'))[0] ?? '';
    const cells = splitRow(header);
    expect(cells).toHaveLength(2);
    expect(renderCell(cells[0] ?? '')).toBe(alias);
    expect(renderCell(cells[1] ?? '')).toBe('b');
  });
});

describe('faostat_dataframe_query escaping end to end', () => {
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

  it('returns the raw value in structuredContent and the escaped value in content[]', async () => {
    const ctx = createMockContext({ tenantId: 'df-format', errors: dataframeQueryTool.errors });
    const instance = await canvas.acquire(undefined, ctx);
    await ctx.state.set('canvas-id', instance.canvasId);
    const value = 'x\\|y';
    const handle = await instance.registerTable('faostat_fmt_tbl', [{ area: value, flag: 'A' }], {
      schema: [
        { name: 'area', type: 'VARCHAR' },
        { name: 'flag', type: 'VARCHAR' },
      ],
    });

    const result = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({ sql: `SELECT area, flag FROM ${handle.tableName}` }),
      ctx,
    );

    // structuredContent carries the value untouched — escaping is a content[] concern.
    expect(result.rows[0]).toMatchObject({ area: value, flag: 'A' });

    const text = (dataframeQueryTool.format?.(result) ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    const cells = splitRow(dataRows(text)[0] ?? '');
    expect(cells).toHaveLength(2);
    expect(renderCell(cells[0] ?? '')).toBe(value);
    expect(renderCell(cells[1] ?? '')).toBe('A');
  });
});
