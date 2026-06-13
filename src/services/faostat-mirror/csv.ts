/**
 * @fileoverview Minimal streaming-friendly CSV helpers for FAOSTAT bulk files.
 * FAOSTAT CSVs are RFC-4180-ish: comma-delimited, double-quoted fields that may
 * contain commas, newlines, and escaped quotes (`""`). The data CSVs are huge
 * (~600 MB decompressed) so the ingester feeds decompressed chunks here and
 * pulls complete records line-by-line rather than materializing the whole file.
 * @module services/faostat-mirror/csv
 */

/**
 * Parse a single CSV record (already known to be one logical row — no embedded
 * newlines spanning the boundary) into its fields. Handles double-quoted fields
 * with `""` escapes and leading/trailing whitespace outside quotes. FAOSTAT
 * headers have a space after the comma (`Area Code, M49 Code, Area`) so unquoted
 * fields are trimmed.
 */
export function parseCsvLine(line: string | undefined): string[] {
  const fields: string[] = [];
  if (line === undefined) return [''];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field.trim());
  return fields;
}

/**
 * Incremental CSV record splitter. Push decompressed text chunks; pull complete
 * records. Tracks quote state across chunk boundaries so a quoted field spanning
 * a newline (rare in FAOSTAT, possible in `Note`) is not split mid-record. Call
 * {@link CsvRecordSplitter.flush} after the last chunk to emit a trailing record
 * with no terminating newline.
 */
export class CsvRecordSplitter {
  private buffer = '';
  private inQuotes = false;

  /** Feed a chunk; returns any complete records it completed. */
  push(chunk: string): string[] {
    const records: string[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (ch === '"') {
        // Toggle on a quote, unless it's an escaped pair inside a quoted field.
        if (this.inQuotes && chunk[i + 1] === '"') {
          i++;
          continue;
        }
        this.inQuotes = !this.inQuotes;
      } else if ((ch === '\n' || ch === '\r') && !this.inQuotes) {
        const line = this.buffer + chunk.slice(start, i);
        if (line.length > 0) records.push(line);
        this.buffer = '';
        // Swallow a following \n in a \r\n sequence.
        if (ch === '\r' && chunk[i + 1] === '\n') i++;
        start = i + 1;
      }
    }
    this.buffer += chunk.slice(start);
    return records;
  }

  /** Emit any buffered final record without a trailing newline. */
  flush(): string | undefined {
    const rest = this.buffer;
    this.buffer = '';
    return rest.length > 0 ? rest : undefined;
  }
}

/**
 * Build a header-index lookup for the actual CSV header row, so the ingester
 * maps columns off the real header rather than a hard-coded order — a
 * non-standard domain then fails loudly instead of mis-mapping.
 */
export function headerIndex(header: string[]): Map<string, number> {
  const idx = new Map<string, number>();
  for (let i = 0; i < header.length; i++) {
    idx.set((header[i] ?? '').trim(), i);
  }
  return idx;
}

/**
 * Strip FAOSTAT's leading apostrophe from an M49 / CPC code (e.g. `'004` → `004`,
 * `'F3102` → `F3102`). Empty/whitespace becomes null.
 */
export function stripApostrophe(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim().replace(/^'/, '');
  return trimmed.length > 0 ? trimmed : null;
}
