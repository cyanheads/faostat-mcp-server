/**
 * @fileoverview Startup with an invalid FAOSTAT_* value — the server exits 1 behind
 * the framework's "Configuration error — server failed to start" banner, naming the
 * variable, rather than an uncaught stack trace. Boots `src/index.ts` under Bun from
 * an empty cwd, so no `.env` is read.
 * @module tests/config/startup-config-error
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
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
