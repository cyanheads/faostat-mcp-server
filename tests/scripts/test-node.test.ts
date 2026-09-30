/**
 * @fileoverview `findRealNode` — how the Node test lane (`bun run test:node`)
 * picks its binary. Inside `bun run`, the first `node` on PATH is Bun's alias (a
 * symlink to the Bun binary), so the lane takes the first `node` whose real path
 * is not Bun's and drops the alias directories from its child's PATH (#36).
 * @module tests/scripts/test-node
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRealNode } from '../../scripts/test-node.js';

describe('findRealNode', () => {
  let root: string;
  /** Stand-in for the running Bun binary. */
  let bun: string;
  /** `node` → Bun symlink, the shape of Bun's `/private/tmp/bun-node-*` alias. */
  let aliasDir: string;
  /** A directory with no `node`. */
  let emptyDir: string;
  /** A `node` file without the execute bit. */
  let plainDir: string;
  /** A real, executable `node`. */
  let realDir: string;

  /** Create `dir/node` as a file with `mode`. */
  function nodeFile(dir: string, mode: number) {
    const path = join(dir, 'node');
    writeFileSync(path, '');
    chmodSync(path, mode);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'faostat-node-lane-'));
    [aliasDir, emptyDir, plainDir, realDir] = ['alias', 'empty', 'plain', 'real'].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      return dir;
    }) as [string, string, string, string];
    bun = join(root, 'bun');
    writeFileSync(bun, '');
    chmodSync(bun, 0o755);
    symlinkSync(bun, join(aliasDir, 'node'));
    nodeFile(plainDir, 0o644);
    nodeFile(realDir, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('skips the Bun alias, a missing node, and a non-executable one', () => {
    const lane = findRealNode([aliasDir, emptyDir, plainDir, realDir].join(delimiter), bun);
    expect(lane?.node).toBe(realpathSync(join(realDir, 'node')));
    // Only the alias directory leaves the child's PATH; order is preserved.
    expect(lane?.path).toBe([emptyDir, plainDir, realDir].join(delimiter));
  });

  it('returns undefined when every node on PATH resolves to Bun', () => {
    expect(findRealNode([emptyDir, aliasDir, plainDir].join(delimiter), bun)).toBeUndefined();
    expect(findRealNode('', bun)).toBeUndefined();
  });
});
