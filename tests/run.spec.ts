// @vitest-environment node
// End-to-end orchestrator test with mocked fetch.
//
// Drives run() with a fake BW API + fake photo bytes, into an in-memory
// WritableStream, and asserts the resulting ZIP contains the expected files.
// Uses the node env because client-zip constructs a ReadableStream and
// jsdom's polyfill misses getReader in the version we're on.
import { describe, expect, it, vi } from 'vitest';
import { run } from '@/scraper/run';
import { NullSync } from '@/lib/sync';
import { ZipSink } from '@/scraper/sinks';
import type { Session } from '@/scraper/types';

// Same 1x1 JPEG used in exif.spec.ts (see comment there).
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

describe('run (end-to-end)', () => {
  it('produces a ZIP containing notes.json, messages.json, photo files, viewer, manifest, log', async () => {
    const jpg = fakeJpeg();
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/message_threads/')) {
        return json({
          results: [
            { message: { object_id: 'msg-1', body: 'Hi', created_at: '2026-06-01T10:00:00Z' } },
          ],
          count: 1,
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
              {
                object_id: 'note-1',
                action_type: 'ac_note',
                event_date: '2026-06-15T14:00:00Z',
                actor: { first_name: 'T', last_name: 'One' },
                note: 'A test note',
                target: { object_id: 'stu-1' },
              },
            ],
            count: 1,
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
      if (url.includes('cloudfront.net') || url.includes('cdn.mybrightwheel.com')) {
        return bytesResp(jpg);
      }
      return json({ activities: [] });
    }) as unknown as typeof fetch;

    const session: Session = {
      guardianId: 'g-1',
      clientUuid: 'c-1',
      userUuid: 'u-1',
      csrfToken: 'csrf',
      studentIds: ['stu-1'],
      threadIds: ['thr-1'],
    };

    // In-memory WritableStream that accumulates chunks.
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const progressEvents: string[] = [];
    const manifest = await run({
      session,
      sink: new ZipSink(writable),
      progress: { post: (u) => progressEvents.push(u.step) },
      sync: new NullSync(),
      fetchImpl,
      clock: () => 1_700_000_000_000,
      timeZone: 'America/New_York',
      extensionVersion: '0.1.0-test',
      format: 'json',
    });

    expect(manifest.counts.notes).toBe(1);
    expect(manifest.counts.messages).toBe(1);
    expect(manifest.counts.photos).toBe(1);

    // Reassemble the bytes and inspect the archive layout.
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    const names = zipFilenames(bytes);
    expect(names).toContain('notes.json');
    expect(names).toContain('messages.json');
    expect(names).toContain('viewer/index.html');
    expect(names).toContain('manifest.json');
    expect(names).toContain('takeout.log');
    expect(names).toContain('photos/manifest.json');
    // At least one photo file present, with the FULL object_id in the name.
    const photoFiles = names.filter((n) => n.startsWith('photos/') && n.endsWith('.jpg'));
    expect(photoFiles.length).toBe(1);
    expect(photoFiles[0]!).toContain('photo-1');

    expect(progressEvents).toContain('notes');
    expect(progressEvents).toContain('messages');
    expect(progressEvents).toContain('photos');
    expect(progressEvents).toContain('done');
  }, 15_000);
});
