/**
 * @fileoverview `faostat_dataframe_drop`'s opt-in registration, read through a
 * served MCP endpoint. With `FAOSTAT_DATAFRAME_DROP_ENABLED` off the tool registers
 * through `disabledTool()`: absent from `tools/list`, uncallable, and shown on the
 * landing page with the reason and the enable hint. On, it is listed with its
 * destructive, idempotent annotations. Served by `createWorkerHandler`, which marks
 * the process as a Worker runtime (a DuckDB canvas then refuses to build), so it
 * runs in a file of its own.
 * @module tests/tools/dataframe-drop-registration
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import {
  dataframeDropRegistration,
  dataframeDropTool,
} from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';

/** The 2026-07-28 revision: selected per request, no initialize round. */
const PROTOCOL = '2026-07-28';

/** A served endpoint carrying the drop tool registered as `enabled` decides. */
function serve(enabled: boolean) {
  const handler = createWorkerHandler({
    name: 'faostat-mcp-server',
    title: 'faostat-mcp-server',
    tools: [dataframeDescribeTool, dataframeDropRegistration(enabled)],
  });
  const env = { MCP_LOG_LEVEL: 'error' } as Parameters<typeof handler.fetch>[1];
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as Parameters<typeof handler.fetch>[2];

  /** One JSON-RPC request on the MCP endpoint; resolves with its parsed body. */
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL,
          'mcp-method': method,
          ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': PROTOCOL,
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'dataframe-drop-test', version: '1' },
            },
          },
        }),
      }),
      env,
      executionCtx,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      result?: { tools?: { name: string; annotations?: Record<string, unknown> }[] };
      error?: { code: number; message: string };
    };
  }

  async function landingPage(): Promise<string> {
    const response = await handler.fetch(
      new Request('http://localhost/', { headers: { accept: 'text/html' } }),
      env,
      executionCtx,
    );
    expect(response.status).toBe(200);
    return response.text();
  }

  return { rpc, landingPage };
}

describe('faostat_dataframe_drop registration', () => {
  it('flag off: absent from tools/list, uncallable, and shown disabled with the enable hint', async () => {
    const server = serve(false);

    const list = await server.rpc('tools/list');
    const names = list.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('faostat_dataframe_describe');
    expect(names).not.toContain('faostat_dataframe_drop');

    const call = await server.rpc('tools/call', {
      name: 'faostat_dataframe_drop',
      arguments: { name: 'faostat_abcd1234' },
    });
    expect(call.error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message: expect.stringContaining('faostat_dataframe_drop not found'),
    });

    const html = await server.landingPage();
    expect(html).toContain('faostat_dataframe_drop');
    expect(html).toContain('Dropping staged tables is turned off in this deployment');
    expect(html).toContain('<code>FAOSTAT_DATAFRAME_DROP_ENABLED=true</code>');
  });

  it('flag on: listed as a destructive, idempotent tool, with no enable hint', async () => {
    expect(dataframeDropRegistration(true)).toBe(dataframeDropTool);
    const server = serve(true);

    const list = await server.rpc('tools/list');
    const drop = list.result?.tools?.find((t) => t.name === 'faostat_dataframe_drop');
    expect(drop?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(await server.landingPage()).not.toContain('FAOSTAT_DATAFRAME_DROP_ENABLED=true');
  });
});
