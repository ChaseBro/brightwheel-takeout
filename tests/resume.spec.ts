// @vitest-environment node
// Resume path: kill a run mid-photos via a mock that throws on the 2nd photo,
// verify the checkpoint on disk captured the completed items, then start
// again with resumeFrom and confirm the finished ZIP contains what it should.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// In-memory idb-keyval — same trick as tests/checkpoint.spec.ts.
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>();
  return {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => {
      store.set(k, v);
    },
    del: async (k: string) => {
      store.delete(k);
    },
    __store: store,
  };
});

import { run } from '@/scraper/run';
import { NullSync } from '@/lib/sync';
import { ZipSink } from '@/scraper/sinks';
import { loadCheckpoint, clearCheckpoint } from '@/lib/checkpoint';
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
function bytesResp(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes as unknown as BodyInit, { status });
}

function bytesFromU16LE(u8: Uint8Array, off: number): number {
  return u8[off]! | (u8[off + 1]! << 8);
}
function bytesFromU32LE(u8: Uint8Array, off: number): number {
  return (
    u8[off]! |
    (u8[off + 1]! << 8) |
    (u8[off + 2]! << 16) |
    (u8[off + 3]! << 24)
  ) >>> 0;
}
function zipFilenames(bytes: Uint8Array): string[] {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytesFromU32LE(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const cdCount = bytesFromU16LE(bytes, eocd + 10);
  const cdOff = bytesFromU32LE(bytes, eocd + 16);
  const names: string[] = [];
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    const nameLen = bytesFromU16LE(bytes, p + 28);
    const extraLen = bytesFromU16LE(bytes, p + 30);
    const commentLen = bytesFromU16LE(bytes, p + 32);
    names.push(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

interface FetchPlan {
  noteIds: string[];
  photoIds: string[];
  /** If true, throw a non-retriable auth error when the ac_photo listing is
   *  requested — simulates auth loss right after notes are done. */
  failOnPhotoListing?: boolean;
}

function buildFetch(plan: FetchPlan): typeof fetch {
  const jpg = fakeJpeg();
  return vi.fn().mockImplementation(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/message_threads/')) {
      return json({ results: [], count: 0, has_more: false });
    }
    if (url.includes('/activities')) {
      const u = new URL(url);
      const page = u.searchParams.get('page');
      const type = u.searchParams.get('action_type');
      if (page !== '0') return json({ activities: [] });
      if (type === 'ac_note') {
        return json({
          activities: plan.noteIds.map((nid) => ({
            object_id: nid,
            action_type: 'ac_note',
            event_date: '2026-06-15T14:00:00Z',
            note: 'a note',
            target: { object_id: 'stu-1' },
          })),
          count: plan.noteIds.length,
        });
      }
      if (type === 'ac_photo') {
        if (plan.failOnPhotoListing) {
          return bytesResp(new Uint8Array(), 401);
        }
        return json({
          activities: plan.photoIds.map((pid) => ({
            object_id: pid,
            action_type: 'ac_photo',
            event_date: '2026-06-16T09:30:00Z',
            media: { image_url: `https://x.cloudfront.net/cover/${pid}.jpg` },
            target: { object_id: 'stu-1' },
          })),
          count: plan.photoIds.length,
        });
      }
    }
    if (url.includes('cloudfront.net')) {
      return bytesResp(jpg);
    }
    return json({});
  }) as unknown as typeof fetch;
}

const session: Session = {
  guardianId: 'g-1',
  clientUuid: 'c-1',
  userUuid: 'u-1',
  csrfToken: 'csrf',
  studentIds: ['stu-1'],
  threadIds: [],
};

async function drainToZipBytes(chunks: Uint8Array[]): Promise<Uint8Array> {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return bytes;
}

describe('resume from checkpoint', () => {
  beforeEach(async () => {
    await clearCheckpoint();
  });

  it('checkpoint captures completed items after a mid-run crash; second attempt with resumeFrom completes', async () => {
    const noteIds = ['n-1', 'n-2'];
    const photoIds = ['p-a', 'p-b', 'p-c'];
    // First attempt: notes succeed, then the photo-activities listing 401s
    // and aborts the run — a realistic mid-run auth-expiration scenario.
    const firstFetch = buildFetch({ noteIds, photoIds, failOnPhotoListing: true });

    const chunks1: Uint8Array[] = [];
    const w1 = new WritableStream<Uint8Array>({ write(c) { chunks1.push(c); } });
    let failed = false;
    try {
      await run({
        session,
        sink: new ZipSink(w1),
        progress: { post: () => {} },
        sync: new NullSync(),
        fetchImpl: firstFetch,
        clock: () => 1_700_000_000_000,
        timeZone: 'UTC',
        format: 'json',
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    // Checkpoint should contain both notes (they were marked before the
    // photo listing 401'd).
    const cp = await loadCheckpoint();
    expect(cp).toBeDefined();
    expect(new Set(cp!.seenObjectIds.notes)).toEqual(new Set(noteIds));

    // Attempt #2: fetch succeeds; resume from the checkpoint. Notes must be
    // skipped (their IDs already in seenObjectIds); photos process normally.
    const secondFetch = buildFetch({ noteIds, photoIds });
    const chunks2: Uint8Array[] = [];
    const w2 = new WritableStream<Uint8Array>({ write(c) { chunks2.push(c); } });
    const manifest = await run({
      session,
      sink: new ZipSink(w2),
      progress: { post: () => {} },
      sync: new NullSync(),
      fetchImpl: secondFetch,
      clock: () => 1_700_000_000_000,
      timeZone: 'UTC',
      resumeFrom: cp,
      format: 'json',
    });

    // Notes are always re-emitted on Resume — they're cheap to re-fetch
    // and are only actually written to disk at end-of-run, so if the crash
    // happened before that write (as it did here) the notes CSV would have
    // been empty otherwise. Photos honor the checkpoint (heavy IO).
    expect(manifest.counts.notes).toBe(noteIds.length);
    expect(manifest.counts.photos).toBe(3);
    // Same runId as the crashed attempt — the checkpoint's identity persists.
    expect(manifest.runId).toBe(cp!.runId);

    const bytes = await drainToZipBytes(chunks2);
    const names = zipFilenames(bytes);
    expect(names).toContain('viewer/index.html');
    expect(names).toContain('manifest.json');
    const photoFiles = names.filter((n) => n.startsWith('photos/') && n.endsWith('.jpg'));
    expect(photoFiles.length).toBe(3);

    // Successful run clears the checkpoint.
    expect(await loadCheckpoint()).toBeUndefined();
  }, 15_000);
});
