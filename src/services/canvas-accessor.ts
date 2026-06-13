/**
 * @fileoverview Module-level accessor for the framework DataCanvas. The canvas
 * is wired onto `CoreServices` in `setup()` and is `undefined` when disabled
 * (`CANVAS_PROVIDER_TYPE=none`; this server defaults it to `duckdb` in index.ts)
 * or on a Worker-like runtime. Handlers reach it through {@link getCanvas} and
 * degrade gracefully when it returns `undefined`.
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Wire the canvas during `setup()` (pass `core.canvas`). */
export function setCanvas(canvas: DataCanvas | undefined): void {
  _canvas = canvas;
}

/** The DataCanvas, or `undefined` when canvas is disabled / unavailable. */
export function getCanvas(): DataCanvas | undefined {
  return _canvas;
}
