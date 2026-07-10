/**
 * Tiny RFC 4180-ish CSV parser. Handles double-quoted fields,
 * escaped quotes ("" inside a quoted field), CRLF or LF line
 * endings, and trailing newlines. No streaming (caller reads the
 * whole file into memory first — fine for ≤MB-sized uploads).
 *
 * Why not pull in papaparse / csv-parse? This is small, has no
 * dependencies, and we control exactly what the parser tolerates
 * vs. rejects. If we ever need streaming or Excel (.xlsx) support
 * we'll swap to a real library — until then keep it lean.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      // Opening quote — only valid at field start. If we already
      // have content, treat as literal (lenient parser).
      if (field.length === 0) {
        inQuotes = true;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }

    if (ch === '\r') {
      // Swallow — handled when we see the \n (or treat as EOL if no \n).
      if (input[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
      i++;
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Flush final field if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export const BULK_UPLOAD_HEADERS = [
  'name',
  'description',
  'stage',
  'amount',
  'currency',
  'expectedCloseDate',
  'companyName',
  'lostReason',
] as const;

export type BulkUploadHeader = (typeof BULK_UPLOAD_HEADERS)[number];

/**
 * Normalize a header cell: trim, lowercase, strip whitespace, allow
 * common aliases. Lets users hand-edit the template in Excel without
 * the parser falling over on "Name" vs "name " vs "Deal Name".
 */
export function normalizeHeader(raw: string): BulkUploadHeader | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, '');
  switch (k) {
    case 'name':
    case 'dealname':
      return 'name';
    case 'description':
    case 'notes':
    case 'details':
      return 'description';
    case 'stage':
      return 'stage';
    case 'amount':
    case 'value':
      return 'amount';
    case 'currency':
      return 'currency';
    case 'expectedclosedate':
    case 'closedate':
    case 'expectedclose':
      return 'expectedCloseDate';
    case 'companyname':
    case 'company':
      return 'companyName';
    case 'lostreason':
    case 'reason':
    case 'lossreason':
      return 'lostReason';
    default:
      return null;
  }
}
