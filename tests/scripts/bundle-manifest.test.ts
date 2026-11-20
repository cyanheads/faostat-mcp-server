/**
 * @fileoverview Verifies the capability claims in the MCPB installer metadata.
 * @module tests/scripts/bundle-manifest.test
 */

import { expect, it } from 'vitest';
import manifest from '../../manifest.json' with { type: 'json' };

it('describes the SQLite mirror and stdio transport in the bundle installer', () => {
  expect(manifest.server.mcp_config.env).toMatchObject({
    MCP_TRANSPORT_TYPE: 'stdio',
    CANVAS_PROVIDER_TYPE: 'none',
  });
  expect(manifest.description).toMatch(/SQLite.*stdio/i);
  expect(manifest.description).not.toMatch(/DataCanvas|HTTP/i);
});
