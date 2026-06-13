/**
 * @fileoverview Regression: the dataframe tools' `canvas_id` is optional. The
 * handlers resolve the session's shared canvas from `ctx.state`, so requiring
 * `canvas_id` only added friction and broke the discovery call
 * (`faostat_dataframe_describe` with no args). These assert the input schemas
 * accept an omitted `canvas_id` and still validate the rest of the surface.
 * @module tests/tools/dataframe-canvas-id-optional
 */

import { describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';

describe('faostat_dataframe_describe input', () => {
  it('accepts no arguments (canvas_id omitted — the discovery call)', () => {
    expect(() => dataframeDescribeTool.input.parse({})).not.toThrow();
    const parsed = dataframeDescribeTool.input.parse({});
    expect(parsed.canvas_id).toBeUndefined();
  });

  it('still accepts an explicit canvas_id and table name', () => {
    const parsed = dataframeDescribeTool.input.parse({
      canvas_id: 'abc1234567',
      name: 'faostat_xyz',
    });
    expect(parsed.canvas_id).toBe('abc1234567');
    expect(parsed.name).toBe('faostat_xyz');
  });
});

describe('faostat_dataframe_query input', () => {
  it('accepts a SQL-only call with canvas_id omitted', () => {
    const parsed = dataframeQueryTool.input.parse({ sql: 'SELECT 1' });
    expect(parsed.canvas_id).toBeUndefined();
    expect(parsed.sql).toBe('SELECT 1');
    expect(parsed.row_limit).toBe(1000); // default applies
  });

  it('still requires sql', () => {
    expect(() => dataframeQueryTool.input.parse({ canvas_id: 'abc1234567' })).toThrow();
  });
});
