/**
 * @fileoverview Stand-in `ReadPool` worker entry for the off-thread tests: a read
 * whose `sql` is `crash` kills the thread mid-read with an uncaught error; every
 * other read is answered with one `{ ok: 1 }` row. Plain JavaScript so it loads
 * unchanged under Bun and Node.
 * @module tests/fixtures/crash-read-worker
 */

import { parentPort } from 'node:worker_threads';

parentPort?.on('message', (request) => {
  if (request.op === 'close') {
    parentPort?.close();
    return;
  }
  if (request.sql === 'crash') throw new Error('read worker crashed');
  parentPort?.postMessage({ id: request.id, rows: [{ ok: 1 }] });
});
