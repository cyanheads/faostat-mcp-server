/**
 * @fileoverview Node test lane — runs the Vitest suite under a real Node binary.
 * `bunfig.toml` sets `[run] bun = true`, so the `vitest run` in `bun run test`
 * executes under Bun (the mirror opens `bun:sqlite`), and inside any `bun run`
 * the `node` on PATH is Bun's alias. The npm bin and the `.mcpb` bundle run
 * `node dist/index.js`, where the mirror opens `better-sqlite3` — a different
 * driver with different bind semantics. `bun run test` chains this script after
 * the Bun lane, so every suite runs under both runtimes.
 *
 * Takes the first PATH entry whose `node` does not resolve to the running Bun
 * binary, drops Bun's alias directories from the child's PATH (anything a test
 * spawns as `node` is real Node too), forwards CLI arguments to Vitest, and exits
 * with its status. Exits non-zero when no real Node is installed.
 * @module scripts/test-node
 *
 * @example
 * // bun run test:node
 * // bun run test:node tests/tools/resolve-codes-domain-scope.test.ts
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

/** The resolved Node binary plus the PATH its child process runs with. */
export interface NodeLane {
  /** Real path of the Node binary. */
  node: string;
  /** `pathEnv` minus every directory whose `node` resolves to Bun. */
  path: string;
}

/** Real path of `<dir>/node` when it is executable, else undefined. */
function nodeIn(dir: string): string | undefined {
  const candidate = join(dir, 'node');
  try {
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return;
  }
}

/**
 * Find a real Node on `pathEnv`: the first `node` whose real path is not
 * `bunBinary`'s. Undefined when every `node` on the path is Bun (or none exists).
 */
export function findRealNode(pathEnv: string, bunBinary: string): NodeLane | undefined {
  const bun = realpathSync(bunBinary);
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const node = dirs.map(nodeIn).find((resolved) => resolved !== undefined && resolved !== bun);
  if (!node) return;
  return { node, path: dirs.filter((dir) => nodeIn(dir) !== bun).join(delimiter) };
}

if (import.meta.main) {
  const lane = findRealNode(process.env.PATH ?? '', process.execPath);
  if (!lane) {
    console.error(
      'Node test lane: no real Node binary on PATH — every `node` found resolves to Bun. ' +
        'Install Node (see package.json engines); the npm bin and .mcpb bundle run under it.',
    );
    process.exit(1);
  }
  const version = spawnSync(lane.node, ['--version'], { encoding: 'utf8' }).stdout.trim();
  console.log(`\nNode test lane: ${lane.node} (${version})`);

  const vitest = resolve(import.meta.dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
  const { status } = spawnSync(lane.node, [vitest, 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, PATH: lane.path },
  });
  process.exit(status ?? 1);
}
