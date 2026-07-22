// Shared shapes for the CSV/XLSX/JSON output formatters.
//
// The scraper collects rich Brightwheel activity records; formatters see a
// flattened, presentation-ready row instead. Keeping the row types narrow
// keeps the RFC-4180 escaper and the SheetJS mapper both trivial.

export interface NoteRow {
  /** ISO date part, e.g. "2026-06-15". */
  date: string;
  /** Local wall-clock time HH:MM (24h) — may be empty for undated notes. */
  time: string;
  studentId: string;
  studentName: string;
  author: string;
  body: string;
  mediaCount: number;
  /** Relative paths inside the export, e.g. "photos/2026-06-15_photo-abcd.jpg". */
  mediaFiles: string[];
}

export interface MessageRow {
  date: string;
  time: string;
  sender: string;
  body: string;
  mediaFiles: string[];
}

export interface PhotoRow {
  filename: string;
  date: string;
  time: string;
  studentId: string;
  studentName: string;
  author: string;
  attachedNote: string;
}

/**
 * Extra info the manifest sheet/section carries in xlsx mode. Matches the
 * top-level fields the run.ts orchestrator already tracks so we don't have
 * to thread anything new through the pipeline.
 */
export interface FormatterManifest {
  guardianId: string;
  studentIds: string[];
  exportedAt: string;
  extensionVersion: string;
  counts: { notes: number; messages: number; photos: number };
  dateRange?: { from?: string | null; to?: string | null };
  includedKinds?: string[];
}

export type OutputFormat = 'csv' | 'xlsx' | 'json';
