// A delimited text (CSV, TSV) → header and rows for the table viewer.
// RFC 4180 quoting: a quoted field may hold the delimiter, line breaks and
// doubled quotes. The first record is the header; rows beyond `maxRows`
// are counted, not kept.

export type Table = {
  header: string[];
  rows: string[][];
  // Records below the header in the whole text.
  total: number;
  truncated: boolean;
};

export function parseDelimited(text: string, delimiter: ',' | '\t', maxRows: number): Table {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  // The current record has begun: a character, a delimiter or an opening
  // quote — so `""` alone is a record of one empty field, not nothing.
  let started = false;
  let i = 0;
  let total = 0;
  let kept = 0;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();

    if (records.length === 0) {
      records.push(record);
    } else {
      total += 1;

      if (kept < maxRows) {
        records.push(record);
        kept += 1;
      }
    }

    record = [];
    started = false;
  };

  while (i < text.length) {
    const ch = text[i] as string;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }

        quoted = false;
        i += 1;
        continue;
      }

      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      started = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      started = true;
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      i += 1;
      continue;
    }

    field += ch;
    started = true;
    i += 1;
  }

  // A last record without a trailing newline; a trailing newline leaves
  // nothing behind.
  if (started) {
    endRecord();
  }

  const [header = [], ...rows] = records;

  return { header, rows, total, truncated: total > rows.length };
}

// A cell that reads as a number is right-aligned (the design's data-num).
const NUMERIC = /^[-+]?(\d{1,3}(,\d{3})*|\d+)?(\.\d+)?%?$/;

export function isNumeric(cell: string): boolean {
  const value = cell.trim();

  return value !== '' && NUMERIC.test(value);
}
