/**
 * @fileoverview Read a `format()` Markdown table back the way a CommonMark renderer
 * does, so a test can assert what a reader actually sees: which `|` characters
 * separate cells, and what each cell displays once backslash escapes are undone.
 * @module tests/helpers/markdown-table
 */

/**
 * Split a rendered Markdown table row on its real cell separators: a `|` preceded
 * by an odd number of backslashes is escaped and stays inside the cell. Returns the
 * cells trimmed, with their escapes intact.
 */
export function splitRow(row: string): string[] {
  const out: string[] = [];
  let current = '';
  let slashes = 0;
  for (const ch of row) {
    if (ch === '\\') {
      slashes++;
      current += ch;
      continue;
    }
    if (ch === '|' && slashes % 2 === 0) {
      out.push(current);
      current = '';
      slashes = 0;
      continue;
    }
    current += ch;
    slashes = 0;
  }
  out.push(current);
  // A row is `| a | b |`, so the split yields an empty segment at each end.
  return out.slice(1, -1).map((c) => c.trim());
}

/** Undo CommonMark backslash escaping of ASCII punctuation — what the reader sees. */
export function renderCell(cell: string): string {
  return cell.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * The table that starts at the line equal to `header`: the header, the delimiter
 * row, and every line after it up to the first blank line or end of text. A value
 * that ends a row early leaves its remainder on a line of its own, which this keeps
 * so the caller can see it.
 */
export function tableLines(text: string, header: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(header);
  if (start === -1) throw new Error(`table header not found: ${header}`);
  const end = lines.indexOf('', start);
  return lines.slice(start, end === -1 ? undefined : end);
}
