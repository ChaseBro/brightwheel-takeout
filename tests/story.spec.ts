// Tests for the story.md formatter — a chronological, human/LLM-readable
// narrative that lets guardians drag the file into ChatGPT/Claude/etc.

import { describe, expect, it } from 'vitest';
import { writeStoryMd } from '@/scraper/formatters/story.js';
import type {
  FormatterManifest,
  MessageRow,
  NoteRow,
  PhotoRow,
} from '@/scraper/formatters/types.js';

const decoder = new TextDecoder();

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

const baseManifest: FormatterManifest = {
  guardianId: 'g-1',
  studentIds: ['stu-ana'],
  exportedAt: '2026-07-22T12:34:56.000Z',
  extensionVersion: '0.1.0',
  counts: { notes: 0, messages: 0, photos: 0 },
};

describe('writeStoryMd', () => {
  it('produces a valid markdown document even when the archive is empty', () => {
    const out = decode(writeStoryMd({
      notes: [],
      messages: [],
      photos: [],
      manifest: baseManifest,
    }));
    expect(out).toMatch(/^# your family — Brightwheel archive/);
    expect(out).toContain('Exported 2026-07-22');
    expect(out).toContain('_No entries in this export._');
    expect(out).toContain('Takeout for Brightwheel');
    expect(out).toContain('Not affiliated with Brightwheel');
  });

  it('greets the guardian by family name when student names are provided', () => {
    const solo = decode(writeStoryMd({
      notes: [], messages: [], photos: [],
      manifest: baseManifest,
      studentNames: ['Ana'],
    }));
    expect(solo).toMatch(/^# Ana — Brightwheel archive/);
    expect(solo).toContain(`"Tell me about Ana's year."`);

    const siblings = decode(writeStoryMd({
      notes: [], messages: [], photos: [],
      manifest: baseManifest,
      studentNames: ['Ana', 'Beto', 'Cai'],
    }));
    expect(siblings).toContain('# Ana, Beto & Cai — Brightwheel archive');
  });

  it('includes school name in the export byline when known', () => {
    const out = decode(writeStoryMd({
      notes: [], messages: [], photos: [],
      manifest: baseManifest,
      schoolName: 'Sunny Days Preschool',
    }));
    expect(out).toContain('Exported 2026-07-22 from Sunny Days Preschool.');
  });

  it('groups entries by year-month with human-readable headers and sorts chronologically', () => {
    const notes: NoteRow[] = [
      row<NoteRow>('note', {
        date: '2026-06-15', time: '09:14', author: 'Ms. Kim',
        studentId: 'stu-ana', studentName: 'Ana',
        body: 'Ana painted a rainbow.', mediaCount: 0, mediaFiles: [],
      }),
      row<NoteRow>('note', {
        date: '2026-05-02', time: '10:00', author: 'Ms. Kim',
        studentId: 'stu-ana', studentName: 'Ana',
        body: 'Started potty training.', mediaCount: 0, mediaFiles: [],
      }),
    ];
    const out = decode(writeStoryMd({
      notes, messages: [], photos: [], manifest: baseManifest,
    }));
    const mayIdx = out.indexOf('## May 2026');
    const juneIdx = out.indexOf('## June 2026');
    expect(mayIdx).toBeGreaterThan(-1);
    expect(juneIdx).toBeGreaterThan(mayIdx);
    // Entries within the same month sort by date, then time.
    expect(out.indexOf('Started potty training')).toBeLessThan(
      out.indexOf('Ana painted a rainbow'),
    );
  });

  it('renders note, message, and standalone-photo entries with distinct headers', () => {
    const notes: NoteRow[] = [row<NoteRow>('note', {
      date: '2026-06-01', time: '09:00', author: 'Ms. Kim',
      studentId: 'stu-ana', studentName: 'Ana',
      body: 'Kicked off the summer session.', mediaCount: 1,
      mediaFiles: ['photos/2026-06-01_summer-abcd.jpg'],
    })];
    const messages: MessageRow[] = [row<MessageRow>('message', {
      date: '2026-06-01', time: '15:22', sender: 'Ms. Kim',
      body: 'Bring a hat Friday.', mediaFiles: [],
    })];
    // A standalone photo (no attachedNote) → surfaces as a "photo" entry.
    const photos: PhotoRow[] = [row<PhotoRow>('photo', {
      filename: 'photos/2026-06-02_playground.jpg',
      date: '2026-06-02', time: '11:00', studentId: 'stu-ana',
      studentName: 'Ana', author: 'Ms. Kim', attachedNote: '',
    })];
    const out = decode(writeStoryMd({
      notes, messages, photos, manifest: baseManifest,
    }));
    expect(out).toContain('### 2026-06-01 · 09:00 · note from Ms. Kim · about Ana');
    expect(out).toContain('### 2026-06-01 · 15:22 · message from Ms. Kim');
    expect(out).toContain('### 2026-06-02 · 11:00 · photo from Ms. Kim · about Ana');
    expect(out).toContain('Photos: photos/2026-06-01_summer-abcd.jpg');
    expect(out).toContain('Photos: photos/2026-06-02_playground.jpg');
  });

  it('does NOT double-emit a photo that is already attached to a note', () => {
    // A note carries the photo file in mediaFiles AND the photo row has an
    // attachedNote — the photo shouldn't appear as its own entry.
    const notes: NoteRow[] = [row<NoteRow>('note', {
      date: '2026-06-15', time: '09:14', author: 'Ms. Kim',
      studentId: 'stu-ana', studentName: 'Ana',
      body: 'Rainbow painting.', mediaCount: 1,
      mediaFiles: ['photos/2026-06-15_paint.jpg'],
    })];
    const photos: PhotoRow[] = [row<PhotoRow>('photo', {
      filename: 'photos/2026-06-15_paint.jpg',
      date: '2026-06-15', time: '09:14', studentId: 'stu-ana',
      studentName: 'Ana', author: 'Ms. Kim',
      attachedNote: 'Rainbow painting.',
    })];
    const out = decode(writeStoryMd({
      notes, messages: [], photos, manifest: baseManifest,
    }));
    // Only ONE H3 header referencing this photo path.
    const matches = out.match(/photos\/2026-06-15_paint\.jpg/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('escapes note bodies whose lines start with `#` so they do not become headings', () => {
    const notes: NoteRow[] = [row<NoteRow>('note', {
      date: '2026-06-01', time: '', author: 'Ms. Kim',
      studentId: 'stu-ana', studentName: 'Ana',
      body: '# not a heading\nregular line',
      mediaCount: 0, mediaFiles: [],
    })];
    const out = decode(writeStoryMd({
      notes, messages: [], photos: [], manifest: baseManifest,
    }));
    expect(out).toContain('\\# not a heading');
    expect(out).toContain('regular line');
  });

  it('is deterministic — byte-identical output for identical input', () => {
    const notes: NoteRow[] = [row<NoteRow>('note', {
      date: '2026-06-01', time: '09:00', author: 'Ms. Kim',
      studentId: 'stu-ana', studentName: 'Ana',
      body: 'hello', mediaCount: 0, mediaFiles: [],
    })];
    const a = writeStoryMd({ notes, messages: [], photos: [], manifest: baseManifest });
    const b = writeStoryMd({ notes, messages: [], photos: [], manifest: baseManifest });
    expect(a.byteLength).toBe(b.byteLength);
    expect(decode(a)).toBe(decode(b));
  });

  it('surfaces the date-range block when a range was applied', () => {
    const out = decode(writeStoryMd({
      notes: [], messages: [], photos: [],
      manifest: { ...baseManifest, dateRange: { from: '2026-01-01', to: '2026-06-30' } },
    }));
    expect(out).toContain('Covering 2026-01-01 to 2026-06-30');
  });

  it('renders reasonable output for large-enough exports (smoke)', () => {
    // 200 notes spread over 12 months — verify we get all months + no crash.
    const notes: NoteRow[] = [];
    for (let i = 0; i < 200; i++) {
      const month = String((i % 12) + 1).padStart(2, '0');
      const day = String((i % 28) + 1).padStart(2, '0');
      notes.push(row<NoteRow>('note', {
        date: `2026-${month}-${day}`, time: '09:00', author: 'Ms. Kim',
        studentId: 'stu-ana', studentName: 'Ana',
        body: `Note ${i}`, mediaCount: 0, mediaFiles: [],
      }));
    }
    const out = decode(writeStoryMd({
      notes, messages: [], photos: [],
      manifest: { ...baseManifest, counts: { notes: 200, messages: 0, photos: 0 } },
    }));
    for (const m of ['January', 'February', 'June', 'December']) {
      expect(out).toContain(`## ${m} 2026`);
    }
    expect(out).toContain('**Counts:** 200 notes');
  });
});

// Test-shape helper — TypeScript-narrows to the row we're building.
function row<T>(_kind: 'note' | 'message' | 'photo', shape: T): T {
  return shape;
}
