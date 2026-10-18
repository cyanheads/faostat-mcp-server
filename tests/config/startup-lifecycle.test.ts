/**
 * @fileoverview Startup registration, refresh scheduling, and shutdown behavior
 * at the framework app boundary, without starting a transport or real mirror.
 * @module tests/config/startup-lifecycle
 */

import type { createApp } from '@cyanheads/mcp-ts-core';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  app: vi.fn(),
  init: vi.fn(),
  close: vi.fn(async () => {}),
  sync: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  schedule: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  start: vi.fn(),
  isNode: true,
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@cyanheads/mcp-ts-core', async (original) => ({
  ...(await original<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: boundary.app,
}));
vi.mock('@cyanheads/mcp-ts-core/utils', async (original) => ({
  ...(await original<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  logger: boundary.log,
  runtimeCaps: {
    get isNode() {
      return boundary.isNode;
    },
  },
  schedulerService: { schedule: boundary.schedule, start: boundary.start },
}));
vi.mock('@/services/faostat-mirror/index.js', () => ({
  initFaostatMirror: boundary.init,
  getFaostatMirror: () => ({ selectedDomains: () => ['QCL', 'TCL'], runDomainSync: boundary.sync }),
}));

type Options = NonNullable<Parameters<typeof createApp>[0]>;
type Core = Parameters<NonNullable<Options['setup']>>[0];

/** Only the services consumed by the entry point; no transport is constructed. */
const coreFor = (mcpTransportType: string): Core =>
  ({ canvas: undefined, config: { mcpTransportType } }) as unknown as Core;

async function load() {
  await import('@/index.js');
  const options = boundary.app.mock.calls[0]?.[0] as Options;
  expect(options.name).toBe('faostat-mcp-server');
  expect(options.title).toBe('faostat-mcp-server');
  expect(options.sessionMode).toBe('stateless');
  return options;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  boundary.isNode = true;
  boundary.init.mockReturnValue({ close: boundary.close });
  boundary.schedule.mockResolvedValue(undefined);
  for (const key of Object.keys(process.env).filter((name) => name.startsWith('FAOSTAT_'))) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv('FAOSTAT_MIRROR_PATH', '/unused/synthetic-mirror');
  vi.stubEnv('FAOSTAT_DOMAINS', ' qcl, TCL, qcl, ');
  vi.stubEnv('CANVAS_PROVIDER_TYPE', undefined);
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('startup lifecycle', () => {
  it('loads environment before registration and wires normalized domains and canvas', async () => {
    vi.mocked(process.loadEnvFile).mockImplementation(() => {
      process.env.FAOSTAT_DATAFRAME_DROP_ENABLED = 'true';
    });
    const options = await load();
    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
    expect(options.instructions).toContain('faostat_dataframe_drop removes');
    expect(options.tools).toHaveLength(7);
    options.setup?.(coreFor('stdio'));
    expect(boundary.init).toHaveBeenCalledWith({
      dir: '/unused/synthetic-mirror',
      domains: ['QCL', 'TCL'],
      log: expect.any(Object),
    });
    const { getCanvas } = await import('@/services/canvas-accessor.js');
    expect(getCanvas()).toBeUndefined();
    const [initialized] = boundary.init.mock.calls;
    if (!initialized) throw new Error('Expected setup to initialize the mirror');
    const { log } = initialized[0] as { log: MirrorLogger };
    for (const level of ['debug', 'info', 'notice', 'warning', 'error'] as const) {
      log[level]?.('sync event', { domain: 'QCL' });
      expect(boundary.log[level]).toHaveBeenCalledWith(
        'sync event',
        expect.objectContaining({
          operation: 'faostatMirrorSync',
          extra: { domain: 'QCL' },
        }),
      );
    }
    log.info?.('without metadata');
    expect(boundary.log.info).toHaveBeenLastCalledWith(
      'without metadata',
      expect.objectContaining({
        operation: 'faostatMirrorSync',
      }),
    );
    await options.teardown?.({} as Core);
    await options.teardown?.({} as Core);
    expect(boundary.close).toHaveBeenCalledTimes(1);
    expect(boundary.schedule).not.toHaveBeenCalled();
  });

  it.each([
    { transport: 'http', cron: '0 6 * * *', node: true, scheduled: true },
    { transport: 'stdio', cron: '0 6 * * *', node: true, scheduled: false },
    { transport: 'http', cron: undefined, node: true, scheduled: false },
    { transport: 'http', cron: '0 6 * * *', node: false, scheduled: false },
  ])(
    'schedules refresh only for Node HTTP with a cron: $transport/$cron/$node',
    async ({ transport, cron, node, scheduled }) => {
      vi.stubEnv('FAOSTAT_REFRESH_CRON', cron);
      vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');
      boundary.isNode = node;
      const options = await load();
      expect(process.env.CANVAS_PROVIDER_TYPE).toBe('none');
      expect(options.instructions).not.toContain('faostat_dataframe_drop removes');
      options.setup?.(coreFor(transport));
      await Promise.resolve();
      expect(boundary.schedule).toHaveBeenCalledTimes(Number(scheduled));
      if (scheduled) {
        expect(boundary.start).toHaveBeenCalledWith('faostat-mirror-refresh');
        const refresh = boundary.schedule.mock.calls[0]?.[2] as () => Promise<void>;
        await refresh();
        expect(boundary.sync.mock.calls).toEqual([
          ['QCL', 'refresh', { signal: expect.any(AbortSignal) }],
          ['TCL', 'refresh', { signal: expect.any(AbortSignal) }],
        ]);
      }
      await options.teardown?.({} as Core);
    },
  );

  it.each([new Error('invalid cron'), 'invalid cron'])(
    'logs scheduler rejection without starting the task: %s',
    async (error) => {
      vi.stubEnv('FAOSTAT_REFRESH_CRON', 'bad');
      boundary.schedule.mockRejectedValue(error);
      const options = await load();
      options.setup?.(coreFor('http'));
      await vi.waitFor(() =>
        expect(boundary.log.error).toHaveBeenCalledWith(
          'Failed to schedule FAOSTAT mirror refresh',
          expect.objectContaining({ message: 'invalid cron' }),
        ),
      );
      expect(boundary.start).not.toHaveBeenCalled();
      await options.teardown?.({} as Core);
    },
  );

  it('accepts a missing .env but propagates other environment-file errors', async () => {
    vi.mocked(process.loadEnvFile).mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    await load();
    vi.resetModules();
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.mocked(process.loadEnvFile).mockImplementation(() => {
      throw failure;
    });
    await expect(import('@/index.js')).rejects.toBe(failure);
  });
});
