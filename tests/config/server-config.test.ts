/**
 * @fileoverview `getServerConfig()` — the FAOSTAT env vars it reads, their
 * defaults, and the error naming the variable when a value fails to parse. The
 * module caches its parse, so each case imports a fresh copy under its own env.
 * @module tests/config/server-config
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

const FAOSTAT_VARS = [
  'FAOSTAT_BULK_BASE_URL',
  'FAOSTAT_DOMAINS',
  'FAOSTAT_MIRROR_PATH',
  'FAOSTAT_REFRESH_CRON',
  'FAOSTAT_DATAFRAME_DROP_ENABLED',
] as const;

/** A fresh `getServerConfig` reading `env` (every other FAOSTAT var unset). */
async function configUnder(env: Record<string, string> = {}) {
  for (const name of FAOSTAT_VARS) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it('applies the defaults when no FAOSTAT variable is set', async () => {
    const getServerConfig = await configUnder();
    expect(getServerConfig()).toEqual({
      bulkBaseUrl: 'https://bulks-faostat.fao.org/production',
      domains: 'QCL,TCL,FBS,FS,RL,GLE,RFN,QV',
      mirrorPath: './.faostat-mirror',
      dataframeDropEnabled: false,
    });
  });

  it('reads each variable it maps', async () => {
    const getServerConfig = await configUnder({
      FAOSTAT_BULK_BASE_URL: 'https://example.org/bulk',
      FAOSTAT_DOMAINS: 'QCL,FBS',
      FAOSTAT_MIRROR_PATH: '/data/mirror',
      FAOSTAT_REFRESH_CRON: '0 6 * * *',
      FAOSTAT_DATAFRAME_DROP_ENABLED: 'true',
    });
    expect(getServerConfig()).toEqual({
      bulkBaseUrl: 'https://example.org/bulk',
      domains: 'QCL,FBS',
      mirrorPath: '/data/mirror',
      refreshCron: '0 6 * * *',
      dataframeDropEnabled: true,
    });
  });

  it.each([
    ['true', true],
    ['1', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['off', false],
    ['', false],
  ])('parses FAOSTAT_DATAFRAME_DROP_ENABLED=%j as %s', async (raw, enabled) => {
    const getServerConfig = await configUnder({ FAOSTAT_DATAFRAME_DROP_ENABLED: raw });
    expect(getServerConfig().dataframeDropEnabled).toBe(enabled);
  });

  it('rejects a FAOSTAT_DATAFRAME_DROP_ENABLED value that is not a boolean word', async () => {
    const getServerConfig = await configUnder({ FAOSTAT_DATAFRAME_DROP_ENABLED: 'maybe' });
    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('FAOSTAT_DATAFRAME_DROP_ENABLED'),
      }),
    );
  });

  it('fails with a ConfigurationError naming the variable that did not parse', async () => {
    const getServerConfig = await configUnder({ FAOSTAT_BULK_BASE_URL: 'not a url' });
    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('FAOSTAT_BULK_BASE_URL'),
      }),
    );
  });
});

describe('dataframeDropRequested', () => {
  /** A fresh `dataframeDropRequested` reading `env` (every other FAOSTAT var unset). */
  async function requestedUnder(env: Record<string, string> = {}) {
    for (const name of FAOSTAT_VARS) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    const { dataframeDropRequested } = await import('@/config/server-config.js');
    return dataframeDropRequested;
  }

  it.each([
    ['true', true],
    ['on', true],
    ['false', false],
    ['', false],
  ])(
    'reads FAOSTAT_DATAFRAME_DROP_ENABLED=%j as %s, as getServerConfig does',
    async (raw, enabled) => {
      const dataframeDropRequested = await requestedUnder({ FAOSTAT_DATAFRAME_DROP_ENABLED: raw });
      expect(dataframeDropRequested()).toBe(enabled);
    },
  );

  it('reads an unset flag as off', async () => {
    const dataframeDropRequested = await requestedUnder();
    expect(dataframeDropRequested()).toBe(false);
  });

  it('reads an unparseable flag as off without throwing, leaving the rejection to getServerConfig', async () => {
    const dataframeDropRequested = await requestedUnder({
      FAOSTAT_DATAFRAME_DROP_ENABLED: 'maybe',
    });
    expect(dataframeDropRequested()).toBe(false);
  });

  it('ignores a bad value in another FAOSTAT variable', async () => {
    const dataframeDropRequested = await requestedUnder({
      FAOSTAT_BULK_BASE_URL: 'not a url',
      FAOSTAT_DATAFRAME_DROP_ENABLED: 'true',
    });
    expect(dataframeDropRequested()).toBe(true);
  });
});
