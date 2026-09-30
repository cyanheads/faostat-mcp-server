/**
 * @fileoverview `printFailure` — how `mirror:init` / `mirror:refresh` report a
 * failed run. A refused manifest carries a recovery hint naming
 * `FAOSTAT_BULK_BASE_URL` (#28); the scripts print it beside the message so the
 * operator sees the same guidance an MCP client does.
 * @module tests/scripts/mirror-context
 */

import { forbidden } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printFailure } from '../../scripts/_mirror-context.js';

describe('printFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureStderr(run: () => void): string[] {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    run();
    return lines;
  }

  it('prints the recovery hint beside the message', () => {
    const err = forbidden('FAOSTAT bulk service returned HTTP 403 Forbidden.', {
      recovery: { hint: 'Check FAOSTAT_BULK_BASE_URL.' },
    });

    expect(captureStderr(() => printFailure('Refresh', err))).toEqual([
      '\nRefresh failed: FAOSTAT bulk service returned HTTP 403 Forbidden.',
      'Recovery: Check FAOSTAT_BULK_BASE_URL.',
    ]);
  });

  it('prints the message alone when the error carries no hint', () => {
    expect(captureStderr(() => printFailure('Init', new Error('disk full')))).toEqual([
      '\nInit failed: disk full',
    ]);
  });
});
