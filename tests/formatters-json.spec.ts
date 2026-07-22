// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  writeMessagesJson,
  writeNotesJson,
  writePhotoManifestJson,
} from '@/scraper/formatters/json';

function parse(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe('json formatters', () => {
  it('writes the notes envelope in the historical shape', () => {
    const bytes = writeNotesJson({
      source: 'brightwheel',
      kind: 'notes',
      guardian_id: 'g-1',
      student_ids: ['stu-1'],
      fetched_at: '2026-06-15T00:00:00.000Z',
      count: 1,
      notes: [{ object_id: 'note-1', note: 'ok' }],
    });
    const obj = parse(bytes) as { kind: string; count: number; notes: unknown[] };
    expect(obj.kind).toBe('notes');
    expect(obj.count).toBe(1);
    expect(obj.notes).toHaveLength(1);
  });

  it('writes messages envelope', () => {
    const bytes = writeMessagesJson({
      source: 'brightwheel',
      kind: 'messages',
      guardian_id: 'g-1',
      thread_ids: ['thr-1'],
      fetched_at: '2026-06-15T00:00:00.000Z',
      count: 0,
      messages: [],
    });
    const obj = parse(bytes) as { thread_ids: string[]; count: number };
    expect(obj.thread_ids).toEqual(['thr-1']);
    expect(obj.count).toBe(0);
  });

  it('writes photo manifest with count + photos array', () => {
    const bytes = writePhotoManifestJson({ count: 2, photos: [{ file: 'a.jpg' }, { file: 'b.jpg' }] });
    const obj = parse(bytes) as { count: number; photos: unknown[] };
    expect(obj.count).toBe(2);
    expect(obj.photos).toHaveLength(2);
  });

  it('emits pretty-printed JSON so parents can eyeball it', () => {
    const bytes = writeNotesJson({
      source: 'brightwheel',
      kind: 'notes',
      guardian_id: 'g-1',
      student_ids: [],
      fetched_at: '',
      count: 0,
      notes: [],
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('\n');
    expect(text).toContain('  ');
  });
});
