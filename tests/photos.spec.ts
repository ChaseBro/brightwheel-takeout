import { describe, expect, it, vi } from 'vitest';
import { BwClient, BwAuthError } from '@/scraper/bw-client';
import { bestUrl, planPhotoEntry, downloadPhoto, downloadPhotoStream, makeRefetchUrl } from '@/scraper/photos';
import type { BwActivity } from '@/scraper/types';

function bytesResp(bytes: Uint8Array, status = 200): Response {
  // TS 5.7's DOM Response typings dislike Uint8Array<ArrayBufferLike>; cast.
  return new Response(bytes as unknown as BodyInit, { status });
}
function client(fetchImpl: typeof fetch) {
  return new BwClient(
    { clientUuid: 'c', userUuid: 'u', csrfToken: 't' },
    { fetchImpl, sleep: async () => {}, retries: 0 },
  );
}

describe('photos', () => {
  it('bestUrl prefers image_url over thumbnail_url', () => {
    expect(bestUrl({ image_url: 'A', thumbnail_url: 'B' })).toBe('A');
    expect(bestUrl({ image_url: null, thumbnail_url: 'B' })).toBe('B');
    expect(bestUrl(null)).toBe(null);
  });

  it('planPhotoEntry uses full object_id + date prefix', () => {
    const a: BwActivity = {
      object_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      action_type: 'ac_photo',
      event_date: '2026-06-15T14:22:07.000Z',
      media: { image_url: 'https://cdn.mybrightwheel.com/x/y/cover/photo.jpg?sig=1' },
      target: { object_id: 'stu-1' },
    };
    const entry = planPhotoEntry(a);
    expect(entry?.filename).toBe('2026-06-15_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg');
    expect(entry?.url).toContain('cover/photo.jpg');
    expect(entry?.studentId).toBe('stu-1');
  });

  it('planPhotoEntry returns null when no media URL', () => {
    const a: BwActivity = {
      object_id: 'x',
      action_type: 'ac_photo',
      event_date: '2025-01-01T00:00:00Z',
      media: null,
    };
    expect(planPhotoEntry(a)).toBeNull();
  });

  it('downloadPhoto returns bytes on happy path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(bytesResp(new Uint8Array([1, 2, 3, 4]))) as unknown as typeof fetch;
    const entry = { objectId: 'o', studentId: 's', eventDate: '2025-01-01T00:00:00Z', url: 'https://x/', filename: 'a.jpg' };
    const res = await downloadPhoto(client(fetchImpl), entry);
    expect(Array.from(res.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('downloadPhoto retries with refetched URL on 403', async () => {
    const responses = [
      bytesResp(new Uint8Array(), 403),
      bytesResp(new Uint8Array([9, 9])),
    ];
    const fetchImpl = vi.fn().mockImplementation(async () => responses.shift()!) as unknown as typeof fetch;
    const refetchUrl = vi.fn().mockResolvedValue('https://x/fresh.jpg');
    const entry = { objectId: 'o', studentId: 's', eventDate: '2025-01-01T00:00:00Z', url: 'https://x/stale', filename: 'a.jpg' };
    const res = await downloadPhoto(client(fetchImpl), entry, { refetchUrl });
    expect(refetchUrl).toHaveBeenCalledOnce();
    expect(res.entry.url).toBe('https://x/fresh.jpg');
    expect(Array.from(res.bytes)).toEqual([9, 9]);
  });

  it('downloadPhoto surfaces 403 as BwAuthError if no refetch is provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(bytesResp(new Uint8Array(), 403)) as unknown as typeof fetch;
    const entry = { objectId: 'o', studentId: 's', eventDate: '2025-01-01T00:00:00Z', url: 'https://x/', filename: 'a.jpg' };
    await expect(downloadPhoto(client(fetchImpl), entry)).rejects.toBeInstanceOf(BwAuthError);
  });

  it('downloadPhotoStream respects concurrency and yields per-item results', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return bytesResp(new Uint8Array([1]));
    }) as unknown as typeof fetch;
    const entries = Array.from({ length: 10 }, (_, i) => ({
      objectId: `o-${i}`,
      studentId: 's',
      eventDate: '2025-01-01T00:00:00Z',
      url: `https://x/${i}`,
      filename: `${i}.jpg`,
    }));
    const results: string[] = [];
    for await (const r of downloadPhotoStream(client(fetchImpl), entries, { concurrency: 3 })) {
      results.push(r.entry.objectId);
    }
    expect(results.length).toBe(10);
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(maxInflight).toBeGreaterThanOrEqual(2);
  });

  it('makeRefetchUrl does NOT poison the cache when the underlying load throws', async () => {
    // If the first load() rejects, the cache should stay clear so the
    // next call can retry — the memoized null/error must not persist.
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        // First /activities call fails hard.
        return new Response('{}', { status: 500 });
      }
      return new Response(
        JSON.stringify({
          activities: [
            {
              object_id: 'p-1',
              action_type: 'ac_photo',
              event_date: '2026-01-01T00:00:00Z',
              media: { image_url: 'https://x/recovered.jpg' },
              target: { object_id: 's-1' },
            },
          ],
          count: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const c = client(fetchImpl);
    const refetch = makeRefetchUrl(c, ['s-1']);
    // First call throws (server error propagates because retries=0).
    await expect(refetch('p-1')).rejects.toBeTruthy();
    // Second call recovers with a fresh load — cache was NOT poisoned by
    // the failed attempt.
    const u = await refetch('p-1');
    expect(u).toBe('https://x/recovered.jpg');
  });

  it('makeRefetchUrl caches within TTL and refetches after (M5)', async () => {
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      call++;
      // /activities is the only URL makeRefetchUrl hits — fresh URL per call.
      if (url.includes('/activities')) {
        return new Response(
          JSON.stringify({
            activities: [
              {
                object_id: 'p-1',
                action_type: 'ac_photo',
                event_date: '2026-01-01T00:00:00Z',
                media: { image_url: `https://x/fresh-${call}.jpg` },
                target: { object_id: 's-1' },
              },
            ],
            count: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    let clockNow = 1_000_000;
    const c = client(fetchImpl);
    const refetch = makeRefetchUrl(c, ['s-1'], { now: () => clockNow, ttlMs: 30_000 });
    // First call → load.
    const u1 = await refetch('p-1');
    expect(u1).toBe('https://x/fresh-1.jpg');
    // Second call within TTL → cached (call count stays at 1 for /activities).
    clockNow += 10_000;
    const u2 = await refetch('p-1');
    expect(u2).toBe('https://x/fresh-1.jpg');
    // Advance past TTL → refresh.
    clockNow += 30_001;
    const u3 = await refetch('p-1');
    expect(u3).toBe('https://x/fresh-2.jpg');
  });

  it('downloadPhotoStream surfaces errors when continueOnError is on', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/2')) return bytesResp(new Uint8Array(), 500);
      return bytesResp(new Uint8Array([1]));
    }) as unknown as typeof fetch;
    const entries = Array.from({ length: 5 }, (_, i) => ({
      objectId: `o-${i}`,
      studentId: 's',
      eventDate: '2025-01-01T00:00:00Z',
      url: `https://x/${i}`,
      filename: `${i}.jpg`,
    }));
    const errors: string[] = [];
    for await (const r of downloadPhotoStream(client(fetchImpl), entries, {
      concurrency: 2,
      continueOnError: true,
    })) {
      if (r.error) errors.push(r.entry.objectId);
    }
    expect(errors).toEqual(['o-2']);
  });
});
