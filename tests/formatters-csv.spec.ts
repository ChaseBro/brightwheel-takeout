// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  csvField,
  writeMessagesCsv,
  writeNotesCsv,
  writePhotoManifestCsv,
} from '@/scraper/formatters/csv';
import type {
  MessageRow,
  NoteRow,
  PhotoRow,
} from '@/scraper/formatters/types';

// TextDecoder strips a leading UTF-8 BOM by default (`ignoreBOM: false` in
// spec-speak actually means "strip it"), so tests read the decoded body
// directly. The raw byte-level BOM presence is asserted separately.
function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Minimal RFC-4180 parser for round-trip verification. Handles quoted
 * fields, doubled quotes, and embedded newlines. Not battle-hardened, but
 * sufficient to catch escaping regressions.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      if (ch === '\r' && text[i] === '\n') i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('csvField (RFC-4180 escaping)', () => {
  it('leaves plain text untouched', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField('')).toBe('');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField(42)).toBe('42');
  });

  it('wraps fields that contain commas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
  });

  it('wraps + doubles internal quotes', () => {
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('wraps fields containing newlines', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('preserves emoji + non-ASCII', () => {
    // No wrapping needed — no special characters — but bytes must round-trip.
    expect(csvField('café ☕ 🎉')).toBe('café ☕ 🎉');
  });
});

describe('writeNotesCsv', () => {
  const notes: NoteRow[] = [
    {
      date: '2026-06-15',
      time: '14:00',
      studentId: 'stu-1',
      studentName: 'Eliza',
      author: 'Teacher One',
      body: 'Had a great day, "loved" the sandbox 🎉',
      mediaCount: 1,
      mediaFiles: ['photos/2026-06-15_photo-abcd.jpg'],
    },
    {
      date: '2026-06-14',
      time: '',
      studentId: 'stu-1',
      studentName: 'Eliza',
      author: 'Teacher Two',
      body: 'Multi\nline\nnote, with a comma',
      mediaCount: 0,
      mediaFiles: [],
    },
  ];

  it('emits a UTF-8 BOM as the first bytes', () => {
    const bytes = writeNotesCsv(notes);
    // BOM is 0xEF 0xBB 0xBF.
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
  });

  it('round-trips through a CSV parser with the expected shape', () => {
    const text = decode(writeNotesCsv(notes));
    const rows = parseCsv(text);
    expect(rows[0]).toEqual([
      'Date',
      'Time',
      'Student ID',
      'Student',
      'Author',
      'Body',
      'Media count',
      'Media files',
    ]);
    // 2 data rows.
    expect(rows).toHaveLength(3);
    expect(rows[1]![5]).toContain('"loved"');
    expect(rows[1]![7]).toBe('photos/2026-06-15_photo-abcd.jpg');
    expect(rows[2]![5]).toBe('Multi\nline\nnote, with a comma');
  });
});

describe('writeMessagesCsv', () => {
  it('renders a header + rows for the message layout', () => {
    const messages: MessageRow[] = [
      {
        date: '2026-06-01',
        time: '10:00',
        sender: 'Parent',
        body: 'Hello 👋',
        mediaFiles: [],
      },
    ];
    const rows = parseCsv(decode(writeMessagesCsv(messages)));
    expect(rows[0]).toEqual(['Date', 'Time', 'Sender', 'Body', 'Media files']);
    expect(rows[1]![3]).toBe('Hello 👋');
  });

  it('emits only the header when there are no rows', () => {
    const bytes = writeMessagesCsv([]);
    const text = decode(bytes);
    expect(text).toBe('Date,Time,Sender,Body,Media files');
  });
});

describe('writePhotoManifestCsv', () => {
  it('produces the expected columns and joins media paths', () => {
    const photos: PhotoRow[] = [
      {
        filename: 'photos/2026-06-16_photo-1.jpg',
        date: '2026-06-16',
        time: '09:30',
        studentId: 'stu-1',
        studentName: 'Eliza',
        author: 'Teacher',
        attachedNote: 'sand play',
      },
    ];
    const rows = parseCsv(decode(writePhotoManifestCsv(photos)));
    expect(rows[0]).toEqual([
      'Filename',
      'Date',
      'Time',
      'Student ID',
      'Student',
      'Author',
      'Attached note',
    ]);
    expect(rows[1]![0]).toBe('photos/2026-06-16_photo-1.jpg');
    expect(rows[1]![6]).toBe('sand play');
  });
});
