// Excel (.xlsx) formatter.
//
// The xlsx dependency is heavy (~350 KB minified), so it's imported lazily
// via `await import('xlsx')`. Callers that never pick Excel pay no bundle
// cost. The `xlsxModuleLoader` seam lets tests swap in a fake so the spec
// doesn't have to pull in the real package (still fast, ~5 ms).

import type {
  FormatterManifest,
  MessageRow,
  NoteRow,
  PhotoRow,
} from './types.js';

/** Excel's per-cell character cap. See ECMA-376 §18.3.1.4. */
export const XLSX_CELL_CHAR_LIMIT = 32_767;
const TRUNC_SUFFIX = ' [truncated]';

/** Injectable loader for tests. Default = real dynamic import. */
export type XlsxModuleLoader = () => Promise<typeof import('xlsx')>;

let overrideLoader: XlsxModuleLoader | null = null;

export function __setXlsxLoader(loader: XlsxModuleLoader | null): void {
  overrideLoader = loader;
}

async function loadXlsx(): Promise<typeof import('xlsx')> {
  if (overrideLoader) return overrideLoader();
  return await import('xlsx');
}

interface TruncationLogger {
  warn(msg: string): void;
}

function truncateCell(
  value: string,
  where: string,
  logger?: TruncationLogger,
): string {
  if (value.length <= XLSX_CELL_CHAR_LIMIT) return value;
  logger?.warn(
    `xlsx: cell ${where} exceeded Excel's ${XLSX_CELL_CHAR_LIMIT}-char cap (${value.length}); truncated`,
  );
  return value.slice(0, XLSX_CELL_CHAR_LIMIT - TRUNC_SUFFIX.length) + TRUNC_SUFFIX;
}

const NOTE_HEADER = [
  'Date',
  'Time',
  'Student ID',
  'Student',
  'Author',
  'Body',
  'Media count',
  'Media files',
];
const MESSAGE_HEADER = ['Date', 'Time', 'Sender', 'Body', 'Media files'];
const PHOTO_HEADER = [
  'Filename',
  'Date',
  'Time',
  'Student ID',
  'Student',
  'Author',
  'Attached note',
];

export interface XlsxBundleInput {
  notes?: NoteRow[];
  messages?: MessageRow[];
  photos?: PhotoRow[];
  manifest: FormatterManifest;
  logger?: TruncationLogger;
}

/**
 * Produce a single workbook containing whichever sheets the caller populated,
 * plus a Manifest sheet. Sheets are only added for provided data — a
 * caller who unchecked "messages" won't get an empty Messages tab.
 */
export async function writeWorkbook(input: XlsxBundleInput): Promise<Uint8Array> {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();

  if (input.notes) {
    const rows = input.notes.map((n, i) => [
      n.date,
      n.time,
      n.studentId,
      n.studentName,
      n.author,
      truncateCell(n.body ?? '', `Notes!F${i + 2}`, input.logger),
      n.mediaCount,
      truncateCell(n.mediaFiles.join('; '), `Notes!H${i + 2}`, input.logger),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([NOTE_HEADER, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Notes');
  }

  if (input.messages) {
    const rows = input.messages.map((m, i) => [
      m.date,
      m.time,
      m.sender,
      truncateCell(m.body ?? '', `Messages!D${i + 2}`, input.logger),
      truncateCell(m.mediaFiles.join('; '), `Messages!E${i + 2}`, input.logger),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([MESSAGE_HEADER, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Messages');
  }

  if (input.photos) {
    const rows = input.photos.map((p, i) => [
      p.filename,
      p.date,
      p.time,
      p.studentId,
      p.studentName,
      p.author,
      truncateCell(p.attachedNote ?? '', `Photos!G${i + 2}`, input.logger),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([PHOTO_HEADER, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Photos');
  }

  const manifestRows: Array<[string, string | number]> = [
    ['guardian_id', input.manifest.guardianId],
    ['student_ids', input.manifest.studentIds.join('; ')],
    ['exported_at', input.manifest.exportedAt],
    ['extension_version', input.manifest.extensionVersion],
    ['count_notes', input.manifest.counts.notes],
    ['count_messages', input.manifest.counts.messages],
    ['count_photos', input.manifest.counts.photos],
    ['date_range_from', input.manifest.dateRange?.from ?? ''],
    ['date_range_to', input.manifest.dateRange?.to ?? ''],
    ['included_kinds', (input.manifest.includedKinds ?? []).join('; ')],
  ];
  const manifestWs = XLSX.utils.aoa_to_sheet([['key', 'value'], ...manifestRows]);
  XLSX.utils.book_append_sheet(wb, manifestWs, 'Manifest');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  // XLSX.write in type:'array' mode returns a plain Uint8Array. Normalize
  // for TS strictness — some xlsx builds return a wider Array-like.
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBufferLike);
}
