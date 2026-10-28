/**
 * @fileoverview Bundle documentation filtering preserves executable skill modules.
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

const packaging = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

describe('bundle agent documentation', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/example/dist/skills/runtime.js',
    'skills/faostat-analysis/SKILL.md',
    'node_modules/example/dist/SKILL.md',
  ])('keeps runtime or published entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(packaging.checkBundleEntries([entry], 'fixture.mcpb')).toEqual([]);
  });

  it.each([
    'node_modules/example/skills/guide/SKILL.md',
    'node_modules/@scope/example/framework-skills/guide/SKILL.md',
    'node_modules/parent/node_modules/@scope/example/skills/guide/SKILL.md',
    'node_modules/@scope/parent/node_modules/example/.claude/settings.json',
    'node_modules/example/.agents/config.json',
    'node_modules/example/SKILL.md',
  ])('removes dependency root documentation %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(packaging.checkBundleEntries([entry], 'fixture.mcpb')).toHaveLength(1);
  });
});
