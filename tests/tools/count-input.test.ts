/**
 * @fileoverview The count-input seam (#56): a `limit` / `top_n` / `row_limit` above
 * its cap is served at the cap in the default (clamp) mode, and rejected in the strict
 * registration `FAOSTAT_CLAMP_LIMITS=false` selects. The value table runs here once,
 * through a served endpoint — the real `tools/list` emission and the real `tools/call`
 * argument validation — over a probe tool built with `countInput()`; per-tool suites
 * prove only their wiring. Served by `createWorkerHandler`, which marks the process
 * as a Worker runtime (a DuckDB canvas then refuses to build), so it runs in a file of
 * its own.
 * @module tests/tools/count-input
 */

import { type AnyToolDefinition, tool, z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { describe, expect, it, vi } from 'vitest';
import { countInput, withStrictCountInputs } from '@/mcp-server/tools/count-input.js';

/**
 * The clamp counter is created at module load, before Vitest's `clearMocks` resets
 * mock state for the first test — so its creation is recorded in this plain array,
 * and only `add` (called inside each test) is a mock.
 */
const telemetry = vi.hoisted(() => ({ created: [] as unknown[][], add: vi.fn() }));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    createCounter: (...args: unknown[]) => {
      telemetry.created.push(args);
      return { add: telemetry.add };
    },
  };
});

const CAP = 200;
const DEFAULT = 20;

const LIMIT = countInput({
  tool: 'probe_list',
  name: 'limit',
  default: DEFAULT,
  cap: CAP,
  description: (cap) => `Items to return, at most ${cap} per call.`,
});

/** A tool shaped like the paged FAOSTAT tools: a count input beside a strict offset. */
const probeTool = tool('probe_list', {
  description: 'Lists numbered items, to exercise the count-input seam.',
  annotations: { readOnlyHint: true },
  enrichment: {
    ...LIMIT.enrichment,
    notice: z.string().optional().describe('Clamp notice.'),
  },
  input: z.object({
    limit: LIMIT.schema,
    offset: z.number().int().min(0).default(0).describe('Zero-based offset.'),
  }),
  output: z.object({
    served: z.number().describe('The limit the handler applied.'),
  }),
  handler(input, ctx) {
    const limit = LIMIT.clamp(ctx, input.limit);
    if (limit.clamped) ctx.enrich.notice(limit.notice);
    return { served: limit.effective };
  },
  format: (result) => [{ type: 'text', text: `Served ${result.served}.` }],
});

/** A definition with no count input — the strict registration must hand it back unchanged. */
const plainTool = tool('probe_plain', {
  description: 'Echoes an offset, to exercise the strict registration on a tool without counts.',
  input: z.object({ offset: z.number().int().min(0).default(0).describe('Zero-based offset.') }),
  output: z.object({ offset: z.number().describe('The offset echoed back.') }),
  handler: (input) => ({ offset: input.offset }),
  format: (result) => [{ type: 'text', text: `Offset ${result.offset}.` }],
});

/** The 2026-07-28 revision: selected per request, no initialize round. */
const PROTOCOL = '2026-07-28';

interface ToolListing {
  inputSchema: {
    additionalProperties?: boolean;
    properties: Record<string, Record<string, unknown>>;
  };
  name: string;
}

interface CallResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent: Record<string, unknown> & {
    error?: { code: number; message: string; data: { reason: string } };
  };
}

/** A served endpoint carrying `tools`; `rpc` sends one JSON-RPC request. */
function serve(tools: AnyToolDefinition[]) {
  const handler = createWorkerHandler({
    name: 'count-input-test',
    title: 'count-input-test',
    tools,
  });
  const env = { MCP_LOG_LEVEL: 'error' } as Parameters<typeof handler.fetch>[1];
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as Parameters<typeof handler.fetch>[2];

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
              'io.modelcontextprotocol/clientInfo': { name: 'count-input-test', version: '1' },
            },
          },
        }),
      }),
      env,
      executionCtx,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { result: unknown };
  }

  return {
    async list(name: string) {
      const { result } = await rpc('tools/list');
      const listing = (result as { tools: ToolListing[] }).tools.find((t) => t.name === name);
      if (!listing) throw new Error(`${name} is not in tools/list`);
      return listing.inputSchema;
    },
    async call(name: string, args: Record<string, unknown>) {
      const { result } = await rpc('tools/call', { name, arguments: args });
      const call = result as CallResult;
      return { ...call, text: call.content.map((c) => c.text ?? '').join('\n') };
    },
  };
}

const clampServer = serve([probeTool]);
const strictServer = serve([withStrictCountInputs(probeTool)]);

describe('count input in tools/list', () => {
  it('clamp mode advertises an integer with its minimum and default and no maximum', async () => {
    const schema = await clampServer.list('probe_list');
    expect(schema.properties.limit).toEqual({
      type: 'integer',
      minimum: 1,
      default: DEFAULT,
      description: `Items to return, at most ${CAP} per call.`,
    });
    expect(schema.additionalProperties).toBe(false);
  });

  it('strict mode advertises the cap as maximum, keeping the rest of the input as it was', async () => {
    const clamp = await clampServer.list('probe_list');
    const strict = await strictServer.list('probe_list');
    expect(strict.properties.limit).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: CAP,
      default: DEFAULT,
      description: `Items to return, at most ${CAP} per call.`,
    });
    expect(strict.properties.offset).toEqual(clamp.properties.offset);
    expect(strict.additionalProperties).toBe(false);
  });

  it("matches zod's input-side JSON Schema, so per-tool suites can read the shape without serving", async () => {
    const advertised = (definition: AnyToolDefinition) =>
      (z.toJSONSchema(definition.input, { io: 'input' }) as ToolListing['inputSchema']).properties;
    expect((await clampServer.list('probe_list')).properties).toEqual(advertised(probeTool));
    expect((await strictServer.list('probe_list')).properties).toEqual(
      advertised(withStrictCountInputs(probeTool)),
    );
  });
});

describe('count input in tools/call, clamp mode', () => {
  it.each([
    ['the cap', CAP],
    ['a value below the cap', 7],
  ])('serves %s as asked, with no clamp fields or notice', async (_label, value) => {
    const wire = await clampServer.call('probe_list', { limit: value });
    expect(wire.isError).not.toBe(true);
    expect(wire.structuredContent).toEqual({ served: value });
    expect(wire.text).toBe(`Served ${value}.`);
  });

  it.each([
    ['cap + 1', CAP + 1, `${CAP + 1}`],
    ['1e20', 1e20, '100000000000000000000'],
  ])('serves %s at the cap and says so on both surfaces', async (_label, value, printed) => {
    const wire = await clampServer.call('probe_list', { limit: value });
    expect(wire.isError).not.toBe(true);
    const notice = `limit ${printed} is above the ${CAP} cap; returned up to ${CAP}.`;
    expect(wire.structuredContent).toEqual({
      served: CAP,
      requestedLimit: value,
      effectiveLimit: CAP,
      notice,
    });
    expect(wire.text).toContain(`Served ${CAP}.`);
    expect(wire.text).toContain(`**requestedLimit:** ${printed}`);
    expect(wire.text).toContain(`**effectiveLimit:** ${CAP}`);
    expect(wire.text).toContain(`> ${notice}`);
  });

  it('rejects 0 on its minimum', async () => {
    const wire = await clampServer.call('probe_list', { limit: 0 });
    expect(wire.isError).toBe(true);
    expect(wire.structuredContent.error).toMatchObject({
      code: -32602,
      data: { reason: 'invalid_arguments' },
    });
    expect(wire.structuredContent.error?.message).toContain('limit: Too small');
    expect(wire.structuredContent.error?.message).not.toContain('whole number');
  });

  it.each([
    ['1.5', 1.5],
    ['float noise', 20.000000000000004],
  ])('rejects %s once, asking for a whole number', async (_label, value) => {
    const wire = await clampServer.call('probe_list', { limit: value });
    expect(wire.isError).toBe(true);
    const message = wire.structuredContent.error?.message ?? '';
    expect(wire.structuredContent.error).toMatchObject({
      code: -32602,
      data: { reason: 'invalid_arguments' },
    });
    expect(message).toContain(`limit: Send a whole number, such as ${DEFAULT}.`);
    expect(message.match(/whole number/g)).toHaveLength(1);
    expect(wire.text).toContain('whole number');
  });
});

describe('count input in tools/call, strict mode', () => {
  it('serves the cap', async () => {
    const wire = await strictServer.call('probe_list', { limit: CAP });
    expect(wire.structuredContent).toEqual({ served: CAP });
  });

  it.each([
    ['cap + 1', CAP + 1],
    ['1e20', 1e20],
  ])('rejects %s on the maximum, as 0.6.0 did', async (_label, value) => {
    const wire = await strictServer.call('probe_list', { limit: value });
    expect(wire.isError).toBe(true);
    expect(wire.structuredContent.error).toMatchObject({
      code: -32602,
      data: { reason: 'invalid_arguments' },
    });
    expect(wire.structuredContent.error?.message).toContain(
      `limit: Too big: expected number to be <=${CAP}`,
    );
  });

  it('rejects a non-integer', async () => {
    const wire = await strictServer.call('probe_list', { limit: 1.5 });
    expect(wire.isError).toBe(true);
    expect(wire.structuredContent.error?.data.reason).toBe('invalid_arguments');
  });
});

describe('withStrictCountInputs', () => {
  it('hands back a definition with no count input unchanged', () => {
    expect(withStrictCountInputs(plainTool)).toBe(plainTool);
  });

  it('replaces only the count fields, keeping every other part of the definition', () => {
    const strict = withStrictCountInputs(probeTool);
    expect(strict).not.toBe(probeTool);
    expect(strict.handler).toBe(probeTool.handler);
    expect(strict.format).toBe(probeTool.format);
    expect(strict.enrichment).toBe(probeTool.enrichment);
    expect(strict.description).toBe(probeTool.description);
    const shape = (strict.input as typeof probeTool.input).shape;
    expect(shape.offset).toBe(probeTool.input.shape.offset);
    expect(shape.limit).not.toBe(probeTool.input.shape.limit);
    // The source definition is untouched: clamp mode still serves an over-cap value.
    expect(probeTool.input.parse({ limit: CAP + 1 }).limit).toBe(CAP + 1);
  });

  it('does not recognize a count schema rebuilt by chaining onto it', () => {
    const chained = tool('probe_chained', {
      description: 'Carries a count schema rebuilt by a chained describe.',
      input: z.object({ limit: LIMIT.schema.describe('Rebuilt.') }),
      output: z.object({ ok: z.boolean().describe('Always true.') }),
      handler: () => ({ ok: true }),
      format: () => [{ type: 'text', text: 'ok' }],
    });
    expect(withStrictCountInputs(chained)).toBe(chained);
  });
});

describe('CountInput.clamp', () => {
  it('creates one clamp counter at module load', () => {
    expect(telemetry.created).toEqual([
      [
        'faostat.count_input.clamped',
        'Tool calls whose count input was above its cap and was served at the cap',
        '{call}',
      ],
    ]);
  });

  it('records nothing at or below the cap', () => {
    const ctx = createMockContext({ tenantId: 't' });
    expect(LIMIT.clamp(ctx, CAP)).toEqual({ clamped: false, effective: CAP });
    expect((ctx.log as MockContextLogger).calls).toEqual([]);
    expect(telemetry.add).not.toHaveBeenCalled();
    expect(getEnrichment(ctx)).toEqual({});
  });

  it('logs one line, counts once, and enriches both fields above the cap', () => {
    const ctx = createMockContext({ tenantId: 't' });
    expect(LIMIT.clamp(ctx, 5000)).toEqual({
      clamped: true,
      effective: CAP,
      requested: 5000,
      notice: `limit 5000 is above the ${CAP} cap; returned up to ${CAP}.`,
    });
    expect((ctx.log as MockContextLogger).calls).toEqual([
      {
        level: 'info',
        msg: 'Count input above its cap, served at the cap',
        data: { input: 'limit', requested: 5000, cap: CAP },
      },
    ]);
    expect(telemetry.add).toHaveBeenCalledTimes(1);
    expect(telemetry.add).toHaveBeenCalledWith(1, {
      'mcp.tool.name': 'probe_list',
      'faostat.count_input': 'limit',
    });
    expect(getEnrichment(ctx)).toEqual({ requestedLimit: 5000, effectiveLimit: CAP });
  });

  it('names the enrichment fields after the input', () => {
    const fields = (name: string) =>
      Object.keys(
        countInput({ tool: 't', name, default: 1, cap: 2, description: () => 'd' }).enrichment,
      ).sort();
    expect(fields('limit')).toEqual(['effectiveLimit', 'requestedLimit']);
    expect(fields('top_n')).toEqual(['effectiveTopN', 'requestedTopN']);
    expect(fields('row_limit')).toEqual(['effectiveRowLimit', 'requestedRowLimit']);
  });
});
