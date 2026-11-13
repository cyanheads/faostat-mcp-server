/**
 * @fileoverview Startup with an invalid FAOSTAT_* value — the server exits 1 behind
 * the framework's "Configuration error — server failed to start" banner, naming the
 * variable, rather than an uncaught stack trace. Boots `src/index.ts` under Bun from
 * an empty cwd, so no `.env` is read.
 *
 * Also boots the built entry (`dist/index.js`, so `bun run rebuild` first) under real
 * Node, where `.env` is loaded by `src/index.ts` itself rather than at process start:
 * `FAOSTAT_CLAMP_LIMITS=false` and `CANVAS_DEFAULT_ROW_LIMIT` must decide the
 * registered count inputs whether they come from the environment or from `.env`.
 * @module tests/config/startup-config-error
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findRealNode } from '../../scripts/test-node.js';

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const BUILT_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'faostat-startup-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Start the server with `env` layered over a clean FAOSTAT environment; resolve on exit. */
function startWith(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('FAOSTAT_')),
  );
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [ENTRY], {
      cwd: scratch,
      env: {
        ...base,
        DEBUG: '',
        MCP_TRANSPORT_TYPE: 'stdio',
        FAOSTAT_MIRROR_PATH: join(scratch, 'mirror'),
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

describe('startup with an invalid FAOSTAT_* value', () => {
  it.each([
    ['FAOSTAT_DATAFRAME_DROP_ENABLED', 'maybe'],
    ['FAOSTAT_CLAMP_LIMITS', 'maybe'],
    ['FAOSTAT_BULK_BASE_URL', 'not-a-url'],
  ])(
    '%s=%s fails behind the configuration-error banner',
    { timeout: 30_000 },
    async (name, value) => {
      const { code, stderr } = await startWith({ [name]: value });
      expect(code).toBe(1);
      expect(stderr).toContain('Configuration error — server failed to start');
      expect(stderr).toContain(name);
      expect(stderr).not.toMatch(/\n\s+at getServerConfig\b/);
    },
  );
});

/** Real Node: this process under the Node lane, the first non-Bun `node` on PATH under Bun. */
function nodeBinary(): string {
  if (!process.versions.bun) return process.execPath;
  const lane = findRealNode(process.env.PATH ?? '', process.execPath);
  if (!lane)
    throw new Error('No real Node binary on PATH — install Node (see package.json engines).');
  return lane.node;
}

/** Count inputs as `tools/list` advertises them. */
interface AdvertisedCountInputs {
  /** `faostat_list_domains` `limit`. */
  limit: Record<string, unknown>;
  /** `faostat_dataframe_query` `row_limit`, capped at the canvas row limit. */
  rowLimit: Record<string, unknown>;
}

/**
 * Boot the built entry under Node over stdio from `cwd`, with `env` layered over a
 * clean FAOSTAT and CANVAS environment, and return two count inputs `tools/list`
 * advertises. The child is stopped once the response arrives.
 */
function countInputsUnderNode(
  cwd: string,
  env: Record<string, string>,
): Promise<AdvertisedCountInputs> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('FAOSTAT_') && !name.startsWith('CANVAS_'),
    ),
  );
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'startup-config-test', version: '1' },
      },
    },
  };
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary(), [BUILT_ENTRY], {
      cwd,
      env: {
        ...base,
        DEBUG: '',
        MCP_TRANSPORT_TYPE: 'stdio',
        MCP_LOG_LEVEL: 'error',
        FAOSTAT_MIRROR_PATH: join(cwd, 'mirror'),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      finish();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error(`No tools/list response. stderr:\n${stderr}`))),
      25_000,
    );
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line) as {
          id?: number;
          result?: {
            tools: {
              name: string;
              inputSchema: { properties: Record<string, Record<string, unknown>> };
            }[];
          };
        };
        if (message.id !== 1) continue;
        const inputOf = (tool: string) =>
          message.result?.tools.find((t) => t.name === tool)?.inputSchema.properties;
        const limit = inputOf('faostat_list_domains')?.limit;
        const rowLimit = inputOf('faostat_dataframe_query')?.row_limit;
        settle(() =>
          limit && rowLimit
            ? resolve({ limit, rowLimit })
            : reject(new Error(`A count input is missing from ${line}`)),
        );
      }
    });
    child.on('error', (error) => settle(() => reject(error)));
    child.on('exit', (code) =>
      settle(() => reject(new Error(`Server exited (${code}) before answering:\n${stderr}`))),
    );
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

describe('FAOSTAT_CLAMP_LIMITS and CANVAS_DEFAULT_ROW_LIMIT under Node, from the environment and from .env', () => {
  it('registers the same count inputs either way', { timeout: 90_000 }, async () => {
    const plain = join(scratch, 'node-plain');
    const fromEnv = join(scratch, 'node-env');
    const fromFile = join(scratch, 'node-dotenv');
    for (const dir of [plain, fromEnv, fromFile]) mkdirSync(dir);
    writeFileSync(
      join(fromFile, '.env'),
      'FAOSTAT_CLAMP_LIMITS=false\nCANVAS_DEFAULT_ROW_LIMIT=500\n',
    );

    const clamp = await countInputsUnderNode(plain, {});
    const strictFromEnv = await countInputsUnderNode(fromEnv, {
      FAOSTAT_CLAMP_LIMITS: 'false',
      CANVAS_DEFAULT_ROW_LIMIT: '500',
    });
    const strictFromFile = await countInputsUnderNode(fromFile, {});

    expect(clamp.limit).not.toHaveProperty('maximum');
    expect(clamp.rowLimit).toMatchObject({
      default: 1000,
      description: expect.stringContaining('at most 10000 per call'),
    });
    expect(clamp.rowLimit).not.toHaveProperty('maximum');
    expect(strictFromEnv.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 });
    // The canvas refuses more than its configured 500 rows, so row_limit is capped there.
    expect(strictFromEnv.rowLimit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 500,
      default: 500,
      description: expect.stringContaining('at most 500 per call'),
    });
    expect(strictFromFile).toEqual(strictFromEnv);
  });
});
