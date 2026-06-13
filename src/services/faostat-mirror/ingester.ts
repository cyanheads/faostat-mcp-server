/**
 * @fileoverview The per-domain bulk-ZIP ingester. Streams a FAOSTAT domain ZIP
 * through fflate, routes the bundled code-list CSVs (`_AreaCodes`, `_ItemCodes`,
 * `_Elements`, `_Flags`) into the shared dimension store, and stream-parses the
 * normalized data CSV (`_All_Data_(Normalized)`) into observation rows yielded as
 * MirrorService pages. Bounded memory: the data CSV is split record-by-record
 * from decompressed chunks and drained in batched pages; the (small) code-list
 * CSVs are buffered whole and applied to dimensions before the data drains.
 * @module services/faostat-mirror/ingester
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type {
  MirrorLogger,
  MirrorRow,
  SyncContext,
  SyncGenerator,
  SyncPage,
} from '@cyanheads/mcp-ts-core/mirror';
import { Unzip, UnzipInflate } from 'fflate';
import { CsvRecordSplitter, headerIndex, parseCsvLine, stripApostrophe } from './csv.js';
import type { DimensionsStore } from './dimensions-store.js';
import { classifyArea } from './dimensions-store.js';
import { FAOSTAT_USER_AGENT } from './http.js';
import type {
  AreaRecord,
  ElementRecord,
  FlagRecord,
  ItemRecord,
  ManifestDataset,
  ObservationRow,
} from './types.js';

/** Observation rows drained to the framework per page (one transaction each). */
const BATCH_ROWS = 5000;

const EMPTY = new Uint8Array(0);

/** Identify which bundled CSV a ZIP entry is, by filename suffix. */
type EntryKind = 'data' | 'areas' | 'items' | 'elements' | 'flags' | 'other';

function classifyEntry(name: string): EntryKind {
  if (/_All_Data_\(Normalized\)\.csv$/i.test(name)) return 'data';
  if (/_AreaCodes(?:_M49)?\.csv$/i.test(name)) return 'areas';
  if (/_ItemCodes\.csv$/i.test(name)) return 'items';
  if (/_Elements\.csv$/i.test(name)) return 'elements';
  if (/_Flags\.csv$/i.test(name)) return 'flags';
  return 'other';
}

/** Map one data-CSV record (against the real header) to an observation row, or null to skip. */
export function dataRowToObservation(
  fields: string[],
  cols: Map<string, number>,
): ObservationRow | null {
  const get = (name: string): string | undefined => {
    const i = cols.get(name);
    return i === undefined ? undefined : fields[i];
  };
  const areaCode = Number(get('Area Code'));
  const itemCode = Number(get('Item Code'));
  const elementCode = Number(get('Element Code'));
  // Prefer Year; fall back to Year Code (calendar-year domains duplicate them).
  const yearRaw = get('Year') ?? get('Year Code');
  const year = Number(yearRaw);
  if (
    !Number.isFinite(areaCode) ||
    !Number.isFinite(itemCode) ||
    !Number.isFinite(elementCode) ||
    !Number.isFinite(year)
  ) {
    return null;
  }
  const valueRaw = get('Value');
  const value = valueRaw !== undefined && valueRaw !== '' ? Number(valueRaw) : null;
  const note = get('Note');
  const unit = get('Unit');
  const flag = get('Flag');
  return {
    id: `${areaCode}|${itemCode}|${elementCode}|${year}`,
    area_code: areaCode,
    area_m49: stripApostrophe(get('Area Code (M49)')),
    area: get('Area') ?? '',
    item_code: itemCode,
    item: get('Item') ?? '',
    element_code: elementCode,
    element: get('Element') ?? '',
    year,
    unit: unit && unit.length > 0 ? unit : null,
    value: value !== null && Number.isFinite(value) ? value : null,
    flag: flag && flag.length > 0 ? flag : null,
    note: note && note.length > 0 ? note : null,
  };
}

/** Parse buffered AreaCodes CSV text into area records. Header: `Area Code, M49 Code, Area`. */
export function parseAreaCodes(text: string): AreaRecord[] {
  const records: AreaRecord[] = [];
  const lines = splitNonEmptyLines(text);
  if (lines.length === 0) return records;
  const cols = headerIndex(parseCsvLine(lines[0]));
  const ci = cols.get('Area Code');
  const mi = cols.get('M49 Code');
  const ni = cols.get('Area');
  if (ci === undefined || ni === undefined) return records;
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const code = Number(f[ci]);
    if (!Number.isFinite(code)) continue;
    records.push({
      area_code: code,
      area_m49: mi === undefined ? null : stripApostrophe(f[mi]),
      area: f[ni] ?? '',
      kind: classifyArea(code),
    });
  }
  return records;
}

/** Parse buffered ItemCodes CSV text. Header: `Item Code, CPC Code, Item`. */
export function parseItemCodes(text: string): ItemRecord[] {
  const records: ItemRecord[] = [];
  const lines = splitNonEmptyLines(text);
  if (lines.length === 0) return records;
  const cols = headerIndex(parseCsvLine(lines[0]));
  const ci = cols.get('Item Code');
  const cpci = cols.get('CPC Code');
  const ni = cols.get('Item');
  if (ci === undefined || ni === undefined) return records;
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const code = Number(f[ci]);
    if (!Number.isFinite(code)) continue;
    records.push({
      item_code: code,
      cpc_code: cpci === undefined ? null : stripApostrophe(f[cpci]),
      item: f[ni] ?? '',
    });
  }
  return records;
}

/** Parse buffered Elements CSV text. Header: `Element Code, Element`. */
export function parseElementCodes(text: string): ElementRecord[] {
  const records: ElementRecord[] = [];
  const lines = splitNonEmptyLines(text);
  if (lines.length === 0) return records;
  const cols = headerIndex(parseCsvLine(lines[0]));
  const ci = cols.get('Element Code');
  const ni = cols.get('Element');
  if (ci === undefined || ni === undefined) return records;
  const seen = new Set<number>();
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const code = Number(f[ci]);
    if (!Number.isFinite(code) || seen.has(code)) continue;
    seen.add(code);
    records.push({ element_code: code, element: f[ni] ?? '' });
  }
  return records;
}

/** Parse buffered Flags CSV text. Header: `Flag, Description`. */
export function parseFlags(text: string): FlagRecord[] {
  const records: FlagRecord[] = [];
  const lines = splitNonEmptyLines(text);
  if (lines.length === 0) return records;
  const cols = headerIndex(parseCsvLine(lines[0]));
  const fi = cols.get('Flag');
  const di = cols.get('Description');
  if (fi === undefined) return records;
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const flag = (f[fi] ?? '').trim();
    if (flag.length === 0) continue;
    records.push({ flag, description: di === undefined ? '' : (f[di] ?? '') });
  }
  return records;
}

function splitNonEmptyLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
}

/**
 * Build a domain ingester. The returned generator:
 * 1. On `refresh`, short-circuits when the manifest `DateUpdate` is not newer
 *    than the stored checkpoint (no fetch — a domain ZIP is one atomic unit).
 * 2. Streams the ZIP, buffering the four code-list CSVs (small) and routing the
 *    data CSV record-by-record into observation rows.
 * 3. Applies the dimension code lists to the shared store, then yields data rows
 *    in batched pages. The durable `checkpoint` (the manifest `DateUpdate`) is
 *    emitted only on the terminal page — an interrupted run leaves no checkpoint,
 *    so the next refresh re-streams the whole ZIP (a ZIP is one atomic unit).
 */
export function makeDomainSync(opts: {
  dataset: ManifestDataset;
  dimensions: DimensionsStore;
  log?: MirrorLogger;
}): SyncGenerator {
  const { dataset, dimensions, log } = opts;

  return async function* domainSync(ctx: SyncContext): AsyncGenerator<SyncPage> {
    const checkpoint = dataset.DateUpdate;
    if (ctx.mode === 'refresh' && ctx.checkpoint && checkpoint && checkpoint <= ctx.checkpoint) {
      log?.info?.(`${dataset.DatasetCode} unchanged since last sync; skipping`, {
        checkpoint: ctx.checkpoint,
      });
      return;
    }

    const response = await fetch(dataset.FileLocation, {
      signal: ctx.signal,
      headers: { 'User-Agent': FAOSTAT_USER_AGENT },
    });
    if (!response.ok || !response.body) {
      throw serviceUnavailable(
        `FAOSTAT ZIP download failed for ${dataset.DatasetCode} (HTTP ${response.status})`,
        { url: dataset.FileLocation, status: response.status },
      );
    }

    const decoder = new TextDecoder('utf-8');
    const splitter = new CsvRecordSplitter();
    let dataHeader: Map<string, number> | undefined;
    const pending: ObservationRow[] = [];
    let dataRows = 0;

    // Buffered code-list CSV text (small files), keyed by kind.
    const codeListChunks: Partial<Record<'areas' | 'items' | 'elements' | 'flags', Uint8Array[]>> =
      {};
    let streamError: unknown;

    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (file) => {
      const kind = classifyEntry(file.name);
      if (kind === 'other') {
        // Drain and discard non-cube entries so fflate releases backpressure.
        file.ondata = () => {};
        file.start();
        return;
      }
      if (kind === 'data') {
        file.ondata = (err, chunk, final) => {
          if (err) {
            streamError ??= err;
            return;
          }
          if (chunk?.length) {
            for (const record of splitter.push(decoder.decode(chunk, { stream: true }))) {
              if (!dataHeader) {
                dataHeader = headerIndex(parseCsvLine(record));
                continue;
              }
              const obs = dataRowToObservation(parseCsvLine(record), dataHeader);
              if (obs) {
                pending.push(obs);
                dataRows++;
              }
            }
          }
          if (final) {
            const last = splitter.flush();
            if (last && dataHeader) {
              const obs = dataRowToObservation(parseCsvLine(last), dataHeader);
              if (obs) {
                pending.push(obs);
                dataRows++;
              }
            }
          }
        };
        file.start();
        return;
      }
      // Code-list entry: buffer the whole (small) file.
      const chunks: Uint8Array[] = [];
      codeListChunks[kind] = chunks;
      file.ondata = (err, chunk) => {
        if (err) {
          streamError ??= err;
          return;
        }
        if (chunk?.length) chunks.push(chunk);
      };
      file.start();
    };

    const reader = response.body.getReader();
    try {
      for (;;) {
        if (ctx.signal.aborted) {
          throw ctx.signal.reason instanceof Error
            ? ctx.signal.reason
            : new Error(`${dataset.DatasetCode} sync aborted`);
        }
        const { done, value } = await reader.read();
        if (done) break;
        unzip.push(value, false);
        if (streamError) throw streamError;
        while (pending.length >= BATCH_ROWS) {
          yield { records: pending.splice(0, BATCH_ROWS) as unknown as MirrorRow[] };
        }
      }
      unzip.push(EMPTY, true);
      if (streamError) throw streamError;
    } finally {
      reader.releaseLock();
    }

    // Apply the bundled dimension code lists to the shared store. Done after the
    // stream drains so all code-list entries are fully buffered.
    await applyDimensions(dimensions, codeListChunks, decoder);

    if (!dataHeader) {
      throw serviceUnavailable(
        `FAOSTAT ZIP for ${dataset.DatasetCode} had no normalized data CSV — non-standard or empty domain.`,
        { url: dataset.FileLocation },
      );
    }

    while (pending.length) {
      yield { records: pending.splice(0, BATCH_ROWS) as unknown as MirrorRow[] };
    }

    log?.notice?.(`${dataset.DatasetCode} ingest complete`, { dataRows });
    // Terminal completion marker — checkpoint valid only once every row applied.
    yield { records: [], checkpoint };
  };
}

/** Decode and parse buffered code-list chunks, then upsert into the dimension store. */
async function applyDimensions(
  dimensions: DimensionsStore,
  chunks: Partial<Record<'areas' | 'items' | 'elements' | 'flags', Uint8Array[]>>,
  decoder: TextDecoder,
): Promise<void> {
  const decode = (parts: Uint8Array[] | undefined): string | undefined =>
    parts ? new TextDecoder('utf-8').decode(concat(parts)) : undefined;
  void decoder; // streaming decoder reserved for the data CSV; code lists use a fresh decode

  const areaText = decode(chunks.areas);
  if (areaText) await dimensions.upsertAreas(parseAreaCodes(areaText));
  const itemText = decode(chunks.items);
  if (itemText) await dimensions.upsertItems(parseItemCodes(itemText));
  const elementText = decode(chunks.elements);
  if (elementText) await dimensions.upsertElements(parseElementCodes(elementText));
  const flagText = decode(chunks.flags);
  if (flagText) await dimensions.upsertFlags(parseFlags(flagText));
}

/** Concatenate Uint8Array chunks into one buffer. */
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
