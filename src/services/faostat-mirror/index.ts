/**
 * @fileoverview Public barrel for the FAOSTAT mirror service.
 * @module services/faostat-mirror
 */

export {
  FaostatMirror,
  type FaostatMirrorOptions,
  getFaostatMirror,
  initFaostatMirror,
  type ObservationQuery,
} from './faostat-mirror.js';
export { fetchManifest, findDataset, parseFileRows, parseFileSizeBytes } from './manifest.js';
export type {
  AreaKind,
  DimensionKind,
  ManifestDataset,
  ObservationRow,
  ResolvedCode,
} from './types.js';
