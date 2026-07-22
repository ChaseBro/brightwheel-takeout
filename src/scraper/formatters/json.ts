// JSON formatter — matches the historical output shape so the standalone
// viewer keeps working. Retained here (instead of writing inline in run.ts)
// so all format decisions live in one place.

import type {
  FormatterManifest,
  MessageRow,
  NoteRow,
  PhotoRow,
} from './types.js';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export interface NotesEnvelope {
  source: 'brightwheel';
  kind: 'notes';
  guardian_id: string;
  student_ids: string[];
  fetched_at: string;
  count: number;
  notes: unknown[];
}

export interface MessagesEnvelope {
  source: 'brightwheel';
  kind: 'messages';
  guardian_id: string;
  thread_ids: string[];
  fetched_at: string;
  count: number;
  messages: unknown[];
}

export interface PhotosManifestEnvelope {
  count: number;
  photos: unknown[];
}

export function writeNotesJson(envelope: NotesEnvelope): Uint8Array {
  return encode(JSON.stringify(envelope, null, 2));
}

export function writeMessagesJson(envelope: MessagesEnvelope): Uint8Array {
  return encode(JSON.stringify(envelope, null, 2));
}

export function writePhotoManifestJson(envelope: PhotosManifestEnvelope): Uint8Array {
  return encode(JSON.stringify(envelope, null, 2));
}

/**
 * Provide a row-shaped JSON alternative that mirrors the CSV/XLSX layout.
 * Callers may prefer this over the raw BW envelopes when they want machine
 * consumers that don't have to know the BW API shape.
 */
export function writeNotesRowsJson(
  rows: NoteRow[],
  manifest: Pick<FormatterManifest, 'guardianId' | 'studentIds' | 'exportedAt'>,
): Uint8Array {
  return encode(
    JSON.stringify(
      {
        kind: 'notes',
        guardian_id: manifest.guardianId,
        student_ids: manifest.studentIds,
        fetched_at: manifest.exportedAt,
        count: rows.length,
        notes: rows,
      },
      null,
      2,
    ),
  );
}

export function writeMessagesRowsJson(
  rows: MessageRow[],
  manifest: Pick<FormatterManifest, 'guardianId' | 'exportedAt'>,
): Uint8Array {
  return encode(
    JSON.stringify(
      {
        kind: 'messages',
        guardian_id: manifest.guardianId,
        fetched_at: manifest.exportedAt,
        count: rows.length,
        messages: rows,
      },
      null,
      2,
    ),
  );
}

export function writePhotoManifestRowsJson(rows: PhotoRow[]): Uint8Array {
  return encode(JSON.stringify({ count: rows.length, photos: rows }, null, 2));
}
