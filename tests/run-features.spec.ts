// @vitest-environment node
//
// End-to-end coverage for the include-set / date-range / skip-exported /
// debug / sink-picking wiring in run(). Complements run.spec.ts, which
// already exercises the happy JSON-into-ZIP path.
//
// Each test uses the same shape of mock fetch as run.spec.ts, filtered
// by the currently-relevant query parameter so a single test can drive
// notes-only or photos-only paths without a big shared harness.

import { describe, expect, it, vi } from 'vitest';
import { run } from '@/scraper/run';
import { NullSync } from '@/lib/sync';
import {
  FolderSink,
  SingleFileSink,
  ZipSink,
  type DirectoryHandleLike,
  type FileHandleLike,
  type WritableLike,
} from '@/scraper/sinks';
import { DebugCapture } from '@/scraper/debug-capture';
import type { Session } from '@/scraper/types';

const ONE_PIXEL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

function fakeJpeg(): Uint8Array {
  return Uint8Array.from(atob(ONE_PIXEL_JPEG_BASE64), (c) => c.charCodeAt(0));
}
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function bytesResp(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200 });
}

interface CallLog {
  urls: string[];
}
function trackingFetch(): { fetch: typeof fetch; calls: CallLog } {
  const jpg = fakeJpeg();
  const calls: CallLog = { urls: [] };
  const fn = vi.fn().mockImplementation(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.urls.push(url);
    if (url.includes('/message_threads/')) {
      return json({
        results: [
          {
            message: {
              object_id: 'msg-old',
              body: 'old',
              created_at: '2024-01-01T00:00:00Z',
            },
          },
          {
            message: {
              object_id: 'msg-recent',
              body: 'recent',
              created_at: '2026-06-01T10:00:00Z',
            },
          },
        ],
        count: 2,
        has_more: false,
      });
    }
    if (url.includes('/activities')) {
      const u = new URL(url);
      const page = u.searchParams.get('page');
      const type = u.searchParams.get('action_type');
      if (page !== '0') return json({ activities: [] });
      if (type === 'ac_note') {
        return json({
          activities: [
            { object_id: 'note-1', action_type: 'ac_note', event_date: '2026-06-15T14:00:00Z', note: 'a', target: { object_id: 'stu-1' } },
            { object_id: 'note-2', action_type: 'ac_note', event_date: '2026-06-16T14:00:00Z', note: 'b', target: { object_id: 'stu-1' } },
          ],
          count: 2,
        });
      }
      if (type === 'ac_photo') {
        return json({
          activities: [
            {
              object_id: 'photo-1',
              action_type: 'ac_photo',
              event_date: '2026-06-16T09:30:00Z',
              media: { image_url: 'https://x.cloudfront.net/cover/photo-1.jpg' },
              target: { object_id: 'stu-1' },
            },
          ],
          count: 1,
        });
      }
    }
    if (url.includes('cloudfront.net')) return bytesResp(jpg);
    return json({ activities: [] });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const session: Session = {
  guardianId: 'g-1',
  clientUuid: 'c-1',
  userUuid: 'u-1',
  csrfToken: 't',
  studentIds: ['stu-1'],
  threadIds: ['thr-1'],
};

function makeZipSink(): { sink: ZipSink; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(c) {
      chunks.push(c);
    },
  });
  return { sink: new ZipSink(writable), chunks };
}

function zipNames(bytes: Uint8Array): string[] {
  let eocd = -1;
  const u16 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8);
  const u32 = (o: number) =>
    ((bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0);
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const cdCount = u16(eocd + 10);
  const cdOff = u32(eocd + 16);
  const names: string[] = [];
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    names.push(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function merge(chunks: Uint8Array[]): Uint8Array {
  const t = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(t);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// ---- Include set (F-B) ---------------------------------------------------

describe('run include-set', () => {
  it('skips ac_photo API calls when photos are unchecked', async () => {
    const { fetch, calls } = trackingFetch();
    const { sink, chunks } = makeZipSink();
    await run({
      session,
      sink,
      progress: { post: () => {} },
      sync: new NullSync(),
      fetchImpl: fetch,
      clock: () => 1_700_000_000_000,
      format: 'csv',
      include: { photos: false, notes: true, messages: true, viewer: false },
    });
    // No ac_photo request should have gone out.
    expect(calls.urls.some((u) => u.includes('action_type=ac_photo'))).toBe(false);
    const names = zipNames(merge(chunks));
    expect(names).toContain('notes.csv');
    expect(names).toContain('messages.csv');
    expect(names).not.toContain('photos.csv');
    expect(names.some((n) => n.startsWith('photos/'))).toBe(false);
  });

  it('skips /messages fetch when messages are unchecked', async () => {
    const { fetch, calls } = trackingFetch();
    const { sink } = makeZipSink();
    await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'csv',
      include: { photos: false, notes: true, messages: false, viewer: false },
    });
    expect(calls.urls.some((u) => u.includes('/message_threads/'))).toBe(false);
  });
});

// ---- Date range (F-D) -----------------------------------------------------

describe('run date range', () => {
  it('passes from/to into /activities as start_date + end_date', async () => {
    const { fetch, calls } = trackingFetch();
    const { sink } = makeZipSink();
    await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'json',
      dateRange: { from: '2026-06-01', to: '2026-06-30' },
      include: { photos: false, notes: true, messages: false, viewer: false },
    });
    const noteCall = calls.urls.find((u) => u.includes('action_type=ac_note'));
    expect(noteCall).toBeTruthy();
    const q = new URL(noteCall!);
    expect(q.searchParams.get('start_date')).toBe('2026-06-01T00:00:00.000Z');
    expect(q.searchParams.get('end_date')).toBe('2026-06-30T23:59:59.999Z');
  });

  it('client-side messages date filter is INCLUSIVE on both boundaries', async () => {
    // Guard against off-by-one on the day boundary. A message created at
    // 00:00:00 on `from` should pass; a message at 23:59:59.999 on `to`
    // should also pass; anything one tick outside should drop.
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/message_threads/')) {
        return json({
          results: [
            { message: { object_id: 'm-before', body: 'x', created_at: '2026-05-31T23:59:59.999Z' } },
            { message: { object_id: 'm-start',  body: 'x', created_at: '2026-06-01T00:00:00.000Z' } },
            { message: { object_id: 'm-end',    body: 'x', created_at: '2026-06-30T23:59:59.999Z' } },
            { message: { object_id: 'm-after',  body: 'x', created_at: '2026-07-01T00:00:00.001Z' } },
          ],
          count: 4,
          has_more: false,
        });
      }
      return json({ results: [], activities: [] });
    }) as unknown as typeof fetch;
    const { sink } = makeZipSink();
    const result = await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl,
      format: 'csv',
      dateRange: { from: '2026-06-01', to: '2026-06-30' },
      include: { photos: false, notes: false, messages: true, viewer: false },
    });
    // m-start and m-end must pass; m-before and m-after must drop.
    expect(result.processedIds.messages.sort()).toEqual(['m-end', 'm-start']);
  });

  it('filters messages client-side against created_at', async () => {
    const { fetch } = trackingFetch();
    const { sink, chunks } = makeZipSink();
    await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'json',
      // "recent" message is 2026-06-01; "old" message is 2024. Filter to
      // 2025+ so the old one is dropped.
      dateRange: { from: '2025-01-01', to: null },
      include: { photos: false, notes: false, messages: true, viewer: false },
    });
    const names = zipNames(merge(chunks));
    expect(names).toContain('messages.json');
    // Manifest counts should reflect the filter.
    const cdContent = new TextDecoder().decode(merge(chunks));
    expect(cdContent).toContain('messages.json');
  });
});

// ---- Skip already exported (F-F) -----------------------------------------

describe('run skipAlreadyExported', () => {
  it('drops object_ids listed in the skip set even if the API returns them', async () => {
    const { fetch } = trackingFetch();
    const { sink, chunks } = makeZipSink();
    const manifest = await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'csv',
      skipAlreadyExported: {
        photos: new Set(['photo-1']),
        notes: new Set(['note-1']),
        messages: new Set(),
      },
      include: { photos: true, notes: true, messages: false, viewer: false },
    });
    // photo-1 filtered → no photo download.
    expect(manifest.counts.photos).toBe(0);
    // note-1 filtered → only note-2 remains.
    expect(manifest.counts.notes).toBe(1);
    const names = zipNames(merge(chunks));
    expect(names.some((n) => n.startsWith('photos/') && n.endsWith('.jpg'))).toBe(false);
  });
});

// ---- Debug mode (F-G) -----------------------------------------------------

describe('run debug capture', () => {
  it('writes captured request bodies under debug/ and a request-log.jsonl', async () => {
    const { fetch } = trackingFetch();
    const { sink, chunks } = makeZipSink();
    const debug = new DebugCapture(true);
    await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'csv',
      debug,
      include: { photos: false, notes: true, messages: true, viewer: false },
    });
    const names = zipNames(merge(chunks));
    expect(names).toContain('debug/request-log.jsonl');
    expect(names).toContain('debug/takeout.log');
    // At least one raw activity body should have been captured under debug/.
    expect(names.some((n) => n.startsWith('debug/') && n.endsWith('.json'))).toBe(true);
  });
});

// ---- Single-file sink (F-C) ----------------------------------------------

describe('run + SingleFileSink', () => {
  it('writes a single CSV directly into the underlying WritableStream', async () => {
    const { fetch } = trackingFetch();
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(c) {
        chunks.push(c);
      },
    });
    const sink = new SingleFileSink(writable);
    await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'csv',
      // Notes only + CSV → single-file eligible.
      include: { photos: false, notes: true, messages: false, viewer: false },
    });
    const bytes = merge(chunks);
    // BOM + at least the header must be present.
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('Date,Time,Student ID,Student,Author,Body');
    // Two note bodies from the fixture are present.
    expect(text).toMatch(/2026-06-15.*,a,/);
    expect(text).toMatch(/2026-06-16.*,b,/);
  });
});

// ---- FolderSink (F-J) -----------------------------------------------------

class MemFile implements FileHandleLike {
  bytes = new Uint8Array();
  createWritable(): Promise<WritableLike> {
    const self = this;
    self.bytes = new Uint8Array();
    return Promise.resolve({
      async write(data: Uint8Array) {
        const combined = new Uint8Array(self.bytes.length + data.length);
        combined.set(self.bytes, 0);
        combined.set(data, self.bytes.length);
        self.bytes = combined;
      },
      async close() {},
    });
  }
}
class MemDir implements DirectoryHandleLike {
  dirs = new Map<string, MemDir>();
  files = new Map<string, MemFile>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d && opts?.create) {
      d = new MemDir();
      this.dirs.set(name, d);
    }
    if (!d) throw new Error(`NotFoundError: ${name}`);
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f && opts?.create) {
      f = new MemFile();
      this.files.set(name, f);
    }
    if (!f) throw new Error(`NotFoundError: ${name}`);
    return f;
  }
  listPaths(prefix = ''): string[] {
    const out: string[] = [];
    for (const [n] of this.files) out.push(prefix + n);
    for (const [n, d] of this.dirs) out.push(...d.listPaths(prefix + n + '/'));
    return out.sort();
  }
}

// ---- Edge cases ----------------------------------------------------------

describe('run edge cases', () => {
  it('empty-set path: everything already exported → still emits manifest + empty CSVs', async () => {
    const { fetch } = trackingFetch();
    const { sink, chunks } = makeZipSink();
    const result = await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'csv',
      skipAlreadyExported: {
        photos: new Set(['photo-1']),
        notes: new Set(['note-1', 'note-2']),
        messages: new Set(['msg-old', 'msg-recent']),
      },
    });
    expect(result.counts).toEqual({ notes: 0, messages: 0, photos: 0 });
    const names = zipNames(merge(chunks));
    expect(names).toContain('manifest.json');
    expect(names).toContain('notes.csv');
    expect(names).toContain('messages.csv');
    expect(names).toContain('photos.csv');
    // CSVs contain the header row only — merge the archive and probe.
    const raw = new TextDecoder('latin1').decode(merge(chunks));
    // Header for notes CSV contains "Body".
    expect(raw).toContain('Body');
  });

  it('cross-kind object_id collision: photo and note with the same id both land', async () => {
    // Defensive: BW's ids are namespaced today, but if a photo and a note
    // ever share an object_id, the L2 kind-keyed skip set must not
    // silently drop one because of the other.
    const jpg = fakeJpeg();
    const shared = 'shared-object-id';
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('cloudfront.net')) return bytesResp(jpg);
      if (url.includes('/activities')) {
        const u = new URL(url);
        if (u.searchParams.get('page') !== '0') return json({ activities: [] });
        if (u.searchParams.get('action_type') === 'ac_note') {
          return json({
            activities: [
              { object_id: shared, action_type: 'ac_note', event_date: '2026-06-15T14:00:00Z', note: 'shared-note', target: { object_id: 'stu-1' } },
            ],
            count: 1,
          });
        }
        if (u.searchParams.get('action_type') === 'ac_photo') {
          return json({
            activities: [
              { object_id: shared, action_type: 'ac_photo', event_date: '2026-06-16T09:30:00Z', media: { image_url: 'https://x.cloudfront.net/shared.jpg' }, target: { object_id: 'stu-1' } },
            ],
            count: 1,
          });
        }
      }
      return json({ activities: [], results: [] });
    }) as unknown as typeof fetch;
    const { sink, chunks } = makeZipSink();
    const result = await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl,
      format: 'csv',
      include: { photos: true, notes: true, messages: false, viewer: false },
    });
    expect(result.counts.notes).toBe(1);
    expect(result.counts.photos).toBe(1);
    const names = zipNames(merge(chunks));
    // The photo file must be present — the note-side seen set must NOT
    // spuriously mask the photo.
    expect(names.some((n) => n.startsWith('photos/') && n.endsWith('.jpg'))).toBe(true);
  });
});

// ---- Perma-failed photos (H6) --------------------------------------------

describe('run permaFailedPhotos', () => {
  it('records photos that fail permanently to the result', async () => {
    // Fetch that resolves everything JSON-ish but 500s on the CloudFront
    // photo URL — no refetch will save it.
    const jpg = fakeJpeg();
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('cloudfront.net')) {
        // 500 → BwServerError → continueOnError yields it as an error.
        return new Response(jpg as unknown as BodyInit, { status: 500 });
      }
      if (url.includes('/activities')) {
        const u = new URL(url);
        if (u.searchParams.get('page') !== '0') return json({ activities: [] });
        if (u.searchParams.get('action_type') === 'ac_photo') {
          return json({
            activities: [{
              object_id: 'photo-doomed',
              action_type: 'ac_photo',
              event_date: '2026-06-16T09:30:00Z',
              media: { image_url: 'https://x.cloudfront.net/cover/doomed.jpg' },
              target: { object_id: 'stu-1' },
            }],
            count: 1,
          });
        }
      }
      return json({ activities: [], results: [] });
    }) as unknown as typeof fetch;
    const { sink } = makeZipSink();
    const result = await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl,
      format: 'csv',
      include: { photos: true, notes: false, messages: false, viewer: false },
    });
    expect(result.counts.photos).toBe(0);
    expect(result.permaFailedPhotoIds).toEqual(['photo-doomed']);
  }, 15_000);

  it('rejects with BwAuthError when the session expires mid photo-download (does NOT mark them perma-failed and finish "successfully")', async () => {
    // Contrast with the 500-error case above: a 500 is a per-photo failure that
    // continueOnError tolerates. A 401 is session death — the whole run must
    // abort, not silently mark every remaining photo perma-failed (which would
    // also poison future runs) and report success.
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('cloudfront.net')) {
        // 401 on the photo bytes → BwClient flips sessionExpired, throws BwAuthError(401).
        return new Response('', { status: 401 });
      }
      if (url.includes('/activities')) {
        const u = new URL(url);
        if (u.searchParams.get('page') !== '0') return json({ activities: [] });
        if (u.searchParams.get('action_type') === 'ac_photo') {
          return json({
            activities: [{
              object_id: 'photo-1',
              action_type: 'ac_photo',
              event_date: '2026-06-16T09:30:00Z',
              media: { image_url: 'https://x.cloudfront.net/cover/photo-1.jpg' },
              target: { object_id: 'stu-1' },
            }],
            count: 1,
          });
        }
      }
      return json({ activities: [], results: [] });
    }) as unknown as typeof fetch;
    const { sink } = makeZipSink();
    await expect(
      run({
        session,
        sink,
        progress: { post: () => {} },
        fetchImpl,
        format: 'csv',
        include: { photos: true, notes: false, messages: false, viewer: false },
      }),
    ).rejects.toMatchObject({ name: 'BwAuthError' });
  }, 15_000);

  it('skips photos in the caller-supplied permaFailedPhotos set (no download attempted)', async () => {
    const { fetch, calls } = trackingFetch();
    const { sink } = makeZipSink();
    const result = await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'csv',
      include: { photos: true, notes: false, messages: false, viewer: false },
      permaFailedPhotos: new Set(['photo-1']),
    });
    expect(result.counts.photos).toBe(0);
    // No CloudFront call for photo-1 — we filtered before downloading.
    expect(calls.urls.some((u) => u.includes('cloudfront.net'))).toBe(false);
  });
});

// ---- Sync round-trip (H4) ------------------------------------------------

describe('run + sync recording', () => {
  // H4 regression: previously the messages loop never called
  // sync.recordExported(), so once RemoteSync ships, messages would
  // re-download forever across devices.
  it('records messages, notes, and photos to sync', async () => {
    const { fetch } = trackingFetch();
    const { sink } = makeZipSink();
    const recorded: Array<{ kind: string; brightwheelObjectId: string }> = [];
    const knownRequested: string[] = [];
    const sync = {
      async fetchKnown(kind: string) {
        knownRequested.push(kind);
        return new Set<string>();
      },
      async recordExported(events: Array<{ kind: string; brightwheelObjectId: string }>) {
        recorded.push(...events);
      },
    };
    await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      sync,
      format: 'csv',
      include: { photos: true, notes: true, messages: true, viewer: false },
    });
    // fetchKnown must be probed for each kind (F-F cross-device dedupe).
    expect(new Set(knownRequested)).toEqual(new Set(['note', 'message', 'photo']));
    const kinds = new Set(recorded.map((e) => e.kind));
    expect(kinds.has('note')).toBe(true);
    expect(kinds.has('message')).toBe(true);
    expect(kinds.has('photo')).toBe(true);
    expect(recorded.some((e) => e.brightwheelObjectId === 'msg-old')).toBe(true);
    expect(recorded.some((e) => e.brightwheelObjectId === 'msg-recent')).toBe(true);
  });

  it('honors sync.fetchKnown for messages (already-exported cross-device)', async () => {
    const { fetch } = trackingFetch();
    const { sink } = makeZipSink();
    const sync = {
      async fetchKnown(kind: string) {
        return kind === 'message' ? new Set<string>(['msg-old']) : new Set<string>();
      },
      async recordExported() {},
    };
    const result = await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      sync,
      format: 'csv',
      include: { photos: false, notes: false, messages: true, viewer: false },
    });
    // msg-old is skipped by fetchKnown; only msg-recent counts.
    expect(result.counts.messages).toBe(1);
    expect(result.processedIds.messages).toEqual(['msg-recent']);
  });
});

// ---- Resume semantics documentation --------------------------------------

describe('run + ZipSink resume', () => {
  // The takeout page's UI still disables ZIP save on resume so the pre-crash
  // photo file bytes aren't lost. But NOTES and MESSAGES are always
  // re-emitted from a Resume — they're buffered and only written at
  // end-of-run, so if we skipped them on Resume the CSV would ship empty
  // (this was a real bug: the initial run crashed on message discovery,
  // notes got cp.marked but the CSV was never written; Resume then dropped
  // all notes because they were "already seen").
  it('re-emits notes on Resume even when the checkpoint says they were seen', async () => {
    const { fetch } = trackingFetch();
    const { sink, chunks } = makeZipSink();
    const result = await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'csv',
      include: { photos: false, notes: true, messages: false, viewer: false },
      // Checkpoint claims note-1 was already "seen" pre-crash — but nothing
      // was actually written to disk yet, so we must still emit both notes.
      resumeFrom: {
        runId: 'run_prior',
        guardianId: 'g-1',
        studentIds: ['stu-1'],
        seenObjectIds: { photos: [], notes: ['note-1'], messages: [] },
        startedAt: 1_699_000_000_000,
        updatedAt: 1_699_000_000_000,
      },
    });
    expect(result.counts.notes).toBe(2);
    expect(new Set(result.processedIds.notes)).toEqual(new Set(['note-1', 'note-2']));
    const bytes = merge(chunks);
    const raw = new TextDecoder('latin1').decode(bytes);
    // Both note bodies land in the CSV — no silent drop of note-1.
    expect(raw).toContain(',a,');
    expect(raw).toContain(',b,');
  });
});

describe('run + FolderSink', () => {
  it('writes each expected file into the picked directory', async () => {
    const { fetch } = trackingFetch();
    const root = new MemDir();
    const sink = new FolderSink(root);
    await run({
      session,
      sink,
      progress: { post: () => {} },
      fetchImpl: fetch,
      format: 'csv',
      include: { photos: true, notes: true, messages: true, viewer: true },
    });
    const paths = root.listPaths();
    expect(paths).toContain('notes.csv');
    expect(paths).toContain('messages.csv');
    expect(paths).toContain('photos.csv');
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('viewer/index.html');
    expect(paths.some((p) => p.startsWith('photos/') && p.endsWith('.jpg'))).toBe(true);
  });
});
