// Hand-rolled RFC-4180 CSV writer. No dependency — CSV is tiny.
//
// - UTF-8 BOM prefix so Excel handles emoji ("smart" in the parent's export
//   without them having to import-with-encoding).
// - Fields containing `,`, `"`, `\n`, or `\r` get wrapped in double quotes;
//   internal double quotes are doubled.
// - Line ending is LF (RFC-4180 says CRLF but every modern importer accepts
//   LF and it keeps the byte layout stable across platforms).

import type {
  FormatterManifest,
  MessageRow,
  NoteRow,
  PhotoRow,
} from './types.js';

const BOM = '﻿';
const LF = '\n';

/**
 * Quote a single field per RFC-4180. Exposed for tests + reuse.
 */
export function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toRow(fields: Array<string | number | null | undefined>): string {
  return fields.map((f) => csvField(f)).join(',');
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Take a list of column headers + rows and produce CSV bytes with a BOM.
 * Exposed so specialty callers (e.g. debug capture) can drop CSV files with
 * a consistent style.
 */
export function writeCsv(
  header: string[],
  rows: Array<Array<string | number | null | undefined>>,
): Uint8Array {
  const lines: string[] = [toRow(header)];
  for (const r of rows) lines.push(toRow(r));
  return encode(BOM + lines.join(LF) + (rows.length > 0 ? LF : ''));
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

export function writeNotesCsv(notes: NoteRow[]): Uint8Array {
  const rows = notes.map((n) => [
    n.date,
    n.time,
    n.studentId,
    n.studentName,
    n.author,
    n.body,
    n.mediaCount,
    n.mediaFiles.join('; '),
  ]);
  return writeCsv(NOTE_HEADER, rows);
}

export function writeMessagesCsv(messages: MessageRow[]): Uint8Array {
  const rows = messages.map((m) => [
    m.date,
    m.time,
    m.sender,
    m.body,
    m.mediaFiles.join('; '),
  ]);
  return writeCsv(MESSAGE_HEADER, rows);
}

export function writePhotoManifestCsv(photos: PhotoRow[]): Uint8Array {
  const rows = photos.map((p) => [
    p.filename,
    p.date,
    p.time,
    p.studentId,
    p.studentName,
    p.author,
    p.attachedNote,
  ]);
  return writeCsv(PHOTO_HEADER, rows);
}

const DAILY_REPORT_HEADER = [
  'Kind',
  'Date',
  'Time',
  'Student ID',
  'Student',
  'Author',
  'Summary',
  'Object ID',
];

/**
 * CSV for the opt-in "daily reports" bucket (ac_food, ac_nap, ac_health_check,
 * etc.). One file for all kinds — the Kind column makes filtering trivial in
 * Excel / Sheets and avoids landing users with a folder of 7 empty CSVs when
 * their school populates only a couple of kinds.
 */
export function writeDailyReportsCsv(
  rows: Array<{
    kindLabel: string;
    date: string;
    time: string;
    studentId: string;
    studentName: string;
    author: string;
    summary: string;
    objectId: string;
  }>,
): Uint8Array {
  const flat = rows.map((r) => [
    r.kindLabel,
    r.date,
    r.time,
    r.studentId,
    r.studentName,
    r.author,
    r.summary,
    r.objectId,
  ]);
  return writeCsv(DAILY_REPORT_HEADER, flat);
}

/**
 * A compact CSV rendering of the manifest — used only when csv is picked and
 * the caller wants a companion "what was in this export" file. Keeps the
 * key/value pairs on separate lines so it's greppable in a text editor.
 */
export function writeManifestCsv(m: FormatterManifest): Uint8Array {
  const rows: Array<[string, string | number]> = [
    ['guardian_id', m.guardianId],
    ['student_ids', m.studentIds.join('; ')],
    ['exported_at', m.exportedAt],
    ['extension_version', m.extensionVersion],
    ['count_notes', m.counts.notes],
    ['count_messages', m.counts.messages],
    ['count_photos', m.counts.photos],
    ['date_range_from', m.dateRange?.from ?? ''],
    ['date_range_to', m.dateRange?.to ?? ''],
    ['included_kinds', (m.includedKinds ?? []).join('; ')],
  ];
  return writeCsv(['key', 'value'], rows);
}
