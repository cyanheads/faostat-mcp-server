/**
 * @fileoverview The per-domain bulk-ZIP ingester. Streams a FAOSTAT domain ZIP
 * through fflate, routes the bundled code-list CSVs (`_AreaCodes`, `_ItemCodes`,
 * `_Elements`, `_Flags`) into the shared dimension store, and stream-parses the
 * normalized data CSV (`_All_Data_(Normalized)`) into observation rows yielded as
 * MirrorService pages. The data rows also supply the item identities the item list
 * lacks: FAO ships some lists short or header-only (#64). Each row carries the
 * stamp of the file it came from, and once every row of the file is in, the rows
 * the cube holds without that stamp are removed (#63), unless the file carries no
 * row at all. Bounded memory: the data CSV is split record-by-record from
 * decompressed chunks and drained in batched pages; the (small) code-list CSVs are
 * buffered whole and applied to dimensions
 * before the data drains, the data rows' item identities are kept one entry per
 * identity, and the rows to remove are read in bounded rowid slices.
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
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { Unzip, UnzipInflate } from 'fflate';
import { CsvRecordSplitter, headerIndex, parseCsvLine, stripApostrophe } from './csv.js';
import type { DimensionsStore } from './dimensions-store.js';
import { classifyArea } from './dimensions-store.js';
import { FAOSTAT_BULK_SERVICE, FAOSTAT_USER_AGENT } from './http.js';
import type {
  AreaRecord,
  ElementRecord,
  FlagRecord,
  ItemRecord,
  ManifestDataset,
  ObservationRow,
} from './types.js';

/** Observation rows, or ids of rows to remove, drained to the framework per page (one transaction each). */
const BATCH_ROWS = 5000;

/**
 * Rowids one read of the rows a file does not carry covers. Each read is one
 * rowid-range search of the cube table, so it reads at most this many rows, and
 * the pass over the 4.8M-row FBS cube is 97 such reads.
 */
const STALE_SLICE_ROWIDS = 50_000;

const EMPTY = new Uint8Array(0);

/**
 * The stamp a file's rows carry in `file_date_update`: its manifest `DateUpdate`
 * as Unix epoch seconds, read as UTC. Undefined unless the `DateUpdate` is a
 * calendar instant in the manifest's `YYYY-MM-DDTHH:MM:SS` form, so two values
 * never share a stamp, and SQLite reads one back as the text it came from
 * (`strftime('%Y-%m-%dT%H:%M:%S', stamp, 'unixepoch')`). An integer, never the
 * 19-character text: it takes 4 bytes a row until 2038 and 6 after, against about
 * 20, which on the 17M-row TCL cube is the difference between tens and hundreds of
 * megabytes.
 */
export function dateUpdateStamp(dateUpdate: string): number | undefined {
  const ms = Date.parse(`${dateUpdate}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== `${dateUpdate}.000Z`) return;
  return ms / 1000;
}

/**
 * The reads of a domain cube the ingester needs from the store it writes, bound
 * for one run by `FaostatMirror.runDomainSync`. Each read takes the run's signal
 * and rejects with the run's stop reason once the run is stopped.
 */
export interface CubeAccess {
  /** The lowest and highest rowid the cube holds, or undefined when it holds no row. */
  rowids(signal: AbortSignal): Promise<{ first: number; last: number } | undefined>;
  /**
   * The ids of the rows with a rowid in `[from, to)` that do not carry `stamp`,
   * unstamped rows included.
   */
  unstamped(stamp: number, from: number, to: number, signal: AbortSignal): Promise<string[]>;
}

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

/**
 * Map one data-CSV record (against the real header) to an observation row, or null
 * to skip. The row is the record's alone: the file stamp is the ingester's to add.
 */
export function dataRowToObservation(
  fields: string[],
  cols: Map<string, number>,
): Omit<ObservationRow, 'file_date_update'> | null {
  const get = (name: string): string | undefined => {
    const i = cols.get(name);
    return i === undefined ? undefined : fields[i];
  };
  const areaCode = Number(get('Area Code'));
  const itemRaw = get('Item Code');
  const itemCode = Number.isFinite(Number(itemRaw)) ? Number(itemRaw) : null;
  const itemCodeText =
    itemCode === null && itemRaw !== undefined && /^\d+[A-Za-z][A-Za-z0-9]*$/.test(itemRaw)
      ? itemRaw
      : null;
  const elementCode = Number(get('Element Code'));
  // Prefer Year; fall back to Year Code (calendar-year domains duplicate them).
  const yearRaw = get('Year') ?? get('Year Code');
  const periodMatch = yearRaw?.match(/^(\d{4})-(\d{4})$/);
  const period = periodMatch ? (yearRaw ?? null) : null;
  const year = periodMatch
    ? (Number(periodMatch[1]) + Number(periodMatch[2])) / 2
    : Number(yearRaw);
  if (
    yearRaw?.includes('-') &&
    (!periodMatch || Number(periodMatch[1]) > Number(periodMatch[2]) || !Number.isInteger(year))
  ) {
    throw new Error(
      `Unsupported FAOSTAT period "${yearRaw}"; expected an ordered calendar-year range with an integer midpoint.`,
    );
  }
  if (
    !Number.isFinite(areaCode) ||
    (itemCode === null && itemCodeText === null) ||
    !Number.isFinite(elementCode) ||
    !Number.isFinite(year)
  ) {
    return null;
  }
  const valueRaw = get('Value');
  const qualifier = valueRaw?.match(/^(<=|>=|<|>)/)?.[0] ?? null;
  const value =
    valueRaw !== undefined && valueRaw !== ''
      ? Number(qualifier ? valueRaw.slice(qualifier.length) : valueRaw)
      : null;
  const sourceRaw = get('Source Code');
  const sourceCode = sourceRaw ? Number(sourceRaw) : null;
  if (sourceCode !== null && !Number.isSafeInteger(sourceCode))
    throw new Error('Invalid FAOSTAT Source Code; expected an integer.');
  const source = get('Source') || null;
  const note = get('Note');
  const unit = get('Unit');
  const flag = get('Flag');
  return {
    id: `${areaCode}|${itemCode ?? `text:${itemCodeText}`}|${elementCode}|${period ?? year}${sourceCode === null ? '' : `|source:${sourceCode}`}`,
    area_code: areaCode,
    area_m49: stripApostrophe(get('Area Code (M49)')),
    area: get('Area') ?? '',
    item_code: itemCode,
    item_code_text: itemCodeText,
    item: get('Item') ?? '',
    element_code: elementCode,
    element: get('Element') ?? '',
    year,
    period,
    source_code: sourceCode,
    source,
    value_qualifier: qualifier,
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
    const raw = f[ci];
    const code = Number.isFinite(Number(raw)) ? Number(raw) : null;
    const textCode =
      code === null && raw !== undefined && /^\d+[A-Za-z][A-Za-z0-9]*$/.test(raw) ? raw : null;
    if (code === null && textCode === null) continue;
    records.push({
      item_code: code,
      item_code_text: textCode,
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
 * An item's identity: its numeric code, or its alphanumeric code text. The two never
 * collide, since a code text always holds a letter.
 */
function itemKey(r: Pick<ItemRecord, 'item_code' | 'item_code_text'>): number | string | null {
  return r.item_code ?? r.item_code_text;
}

/**
 * Build a domain ingester. The returned generator:
 * 1. On `refresh`, short-circuits when the manifest `DateUpdate` is not newer
 *    than the stored checkpoint (no fetch — a domain ZIP is one atomic unit).
 * 2. Streams the ZIP, buffering the four code-list CSVs (small) and routing the
 *    data CSV record-by-record into observation rows, noting each item identity
 *    the rows name with the label of its first row in file order.
 * 3. Applies the dimension code lists to the shared store, then adds the noted
 *    item identities the item list lacks ({@link DimensionsStore.addMissingItems},
 *    which never replaces a row already present), then yields data rows in batched
 *    pages, each row stamped with the file's {@link dateUpdateStamp}.
 * 4. Once every data page has committed, reads the ids of the rows the cube holds
 *    without that stamp — rows the file no longer carries, and rows stored before
 *    rows carried a stamp — one {@link STALE_SLICE_ROWIDS} rowid slice at a time
 *    (`cube`), and yields them as tombstone pages. A read never meets a cube
 *    missing a row of the file, and since the stamp is the file's, not the run's,
 *    a run stopped anywhere and rerun removes the same rows.
 *
 * The durable `checkpoint` (the manifest `DateUpdate`) is emitted only on the
 * terminal page, which carries the last tombstones, so no removal ever follows it:
 * once it commits, the next refresh skips the domain. An interrupted run leaves no
 * checkpoint, so the next refresh re-streams the whole ZIP (a ZIP is one atomic
 * unit). Two files remove nothing, each with a warning saying so, and still
 * complete with their checkpoint, so the next file that stamps and carries rows
 * removes what it does not carry: a file whose `DateUpdate` stamps nothing, whose
 * rows land unstamped; and a file whose data CSV yields no row (FAO has shipped one
 * holding only its header, with or without a final line break), which would
 * otherwise remove every row of the domain.
 */
export function makeDomainSync(opts: {
  cube: CubeAccess;
  dataset: ManifestDataset;
  dimensions: DimensionsStore;
  log?: MirrorLogger;
}): SyncGenerator {
  const { cube, dataset, dimensions, log } = opts;

  return async function* domainSync(ctx: SyncContext): AsyncGenerator<SyncPage> {
    const checkpoint = dataset.DateUpdate;
    if (ctx.mode === 'refresh' && ctx.checkpoint && checkpoint && checkpoint <= ctx.checkpoint) {
      log?.info?.(`${dataset.DatasetCode} unchanged since last sync; skipping`, {
        checkpoint: ctx.checkpoint,
      });
      return;
    }
    const stamp = dateUpdateStamp(checkpoint);
    if (stamp === undefined) {
      log?.warning?.(
        `${dataset.DatasetCode} manifest DateUpdate "${checkpoint}" is not a YYYY-MM-DDTHH:MM:SS instant, so this sync stamps none of its rows and removes none the file no longer carries; the next file whose DateUpdate has that form removes them`,
      );
    }
    const stamped = { file_date_update: stamp ?? null };

    const response = await fetch(dataset.FileLocation, {
      signal: ctx.signal,
      headers: { 'User-Agent': FAOSTAT_USER_AGENT },
    });
    if (!response.ok) {
      // Status-classified, so a 4xx reads as what it is rather than an outage. The
      // error reaches only the sync logs, so it may carry the ZIP URL.
      throw await httpErrorFromResponse(response, {
        service: `${FAOSTAT_BULK_SERVICE} (${dataset.DatasetCode} ZIP)`,
        includeUrl: true,
      });
    }
    if (!response.body) {
      throw serviceUnavailable(
        `FAOSTAT ZIP download for ${dataset.DatasetCode} returned HTTP ${response.status} with no body.`,
        { url: dataset.FileLocation, status: response.status },
      );
    }

    const decoder = new TextDecoder('utf-8');
    const splitter = new CsvRecordSplitter();
    let dataHeader: Map<string, number> | undefined;
    const pending: ObservationRow[] = [];
    let dataRows = 0;
    /** Each item identity the data rows name, labeled from its first row in file order. */
    const rowItems = new Map<number | string | null, ItemRecord>();
    /** The data CSV's first record is its header, the rest its rows. */
    const take = (record: string): void => {
      if (!dataHeader) {
        dataHeader = headerIndex(parseCsvLine(record));
        return;
      }
      const obs = dataRowToObservation(parseCsvLine(record), dataHeader);
      if (!obs) return;
      pending.push(Object.assign(obs, stamped));
      dataRows++;
      const key = itemKey(obs);
      if (!rowItems.has(key)) {
        rowItems.set(key, {
          item_code: obs.item_code,
          item_code_text: obs.item_code_text,
          cpc_code: null,
          item: obs.item,
        });
      }
    };

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
              take(record);
            }
          }
          if (final) {
            // A header-only CSV without a final line break ends with its header here.
            const last = splitter.flush();
            if (last) take(last);
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
    const itemsFromRows = await applyDimensions(dimensions, codeListChunks, [...rowItems.values()]);

    if (!dataHeader) {
      throw serviceUnavailable(
        `FAOSTAT ZIP for ${dataset.DatasetCode} had no normalized data CSV — non-standard or empty domain.`,
        { url: dataset.FileLocation },
      );
    }

    while (pending.length) {
      yield { records: pending.splice(0, BATCH_ROWS) as unknown as MirrorRow[] };
    }

    log?.notice?.(`${dataset.DatasetCode} ingest complete`, { dataRows, itemsFromRows });
    // FAO has shipped a data CSV holding only its header: a publishing fault, not the
    // withdrawal of a whole domain, so a file with no row removes none.
    if (dataRows === 0) {
      log?.warning?.(
        `${dataset.DatasetCode} data file for DateUpdate "${checkpoint}" carries no data rows, so this sync removes none of the rows the cube holds; the next file that carries rows removes those it does not carry`,
      );
    }
    const stale: string[] = [];
    const range = stamp === undefined || dataRows === 0 ? undefined : await cube.rowids(ctx.signal);
    if (stamp !== undefined && range) {
      for (let from = range.first; from <= range.last; from += STALE_SLICE_ROWIDS) {
        for (const id of await cube.unstamped(stamp, from, from + STALE_SLICE_ROWIDS, ctx.signal))
          stale.push(id);
        // Strictly more than a page, so the last tombstones ride the checkpoint page.
        while (stale.length > BATCH_ROWS) {
          yield { records: [], tombstones: stale.splice(0, BATCH_ROWS) };
        }
      }
    }
    // Terminal completion marker — checkpoint valid only once every row applied and removed.
    yield { records: [], tombstones: stale, checkpoint };
  };
}

/**
 * Decode and parse buffered code-list chunks and upsert them into the dimension
 * store, then add the data rows' item identities the item list lacks. The list
 * goes first, so its label and CPC code are what a listed identity keeps. Returns
 * how many items the rows added.
 */
async function applyDimensions(
  dimensions: DimensionsStore,
  chunks: Partial<Record<'areas' | 'items' | 'elements' | 'flags', Uint8Array[]>>,
  rowItems: ItemRecord[],
): Promise<number> {
  const decode = (parts: Uint8Array[] | undefined): string | undefined =>
    parts ? new TextDecoder('utf-8').decode(concat(parts)) : undefined;

  const areaText = decode(chunks.areas);
  if (areaText) await dimensions.upsertAreas(parseAreaCodes(areaText));
  const itemText = decode(chunks.items);
  const listed = itemText ? parseItemCodes(itemText) : [];
  await dimensions.upsertItems(listed);
  const listedKeys = new Set(listed.map(itemKey));
  const added = await dimensions.addMissingItems(
    rowItems.filter((r) => !listedKeys.has(itemKey(r))),
  );
  const elementText = decode(chunks.elements);
  if (elementText) await dimensions.upsertElements(parseElementCodes(elementText));
  const flagText = decode(chunks.flags);
  if (flagText) await dimensions.upsertFlags(parseFlags(flagText));
  return added;
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
