/**
 * Minimal, allocation-light CSV parsing for GTFS text files.
 * Handles quoted fields with embedded separators/newlines ("" escapes).
 * The original operator GTFS ZIP is the canonical schedule source (GOAL.md §8);
 * portal-imported table copies are never used.
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  // strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore; handled by \n
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // drop trailing fully-empty rows
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0] === '') rows.pop();
    else break;
  }
  const header = rows.shift() ?? [];
  return { header, rows };
}

export interface CsvTable {
  header: string[];
  rows: string[][];
  indexOf(col: string): number | null;
}

export function table(text: string): CsvTable {
  const { header, rows } = parseCsv(text);
  const idx = new Map<string, number>();
  header.forEach((h, i) => idx.set(h, i));
  return {
    header,
    rows,
    indexOf(col: string): number | null {
      const v = idx.get(col);
      return v === undefined ? null : v;
    },
  };
}
