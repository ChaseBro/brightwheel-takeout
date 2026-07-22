import { describe, expect, it, vi } from 'vitest';
import { BwClient } from '@/scraper/bw-client';
import {
  estimateBytes,
  estimateMs,
  formatBytes,
  formatDuration,
  previewScope,
} from '@/scraper/preview';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch) {
  return new BwClient(
    { clientUuid: 'c', userUuid: 'u', csrfToken: 't' },
    { fetchImpl, sleep: async () => {}, retries: 0 },
  );
}

describe('previewScope', () => {
  it('sums per-student photo + note counts and per-thread message counts', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/students/stu-a/activities') && url.includes('ac_photo')) return json(200, { count: 2000, activities: [] });
      if (url.includes('/students/stu-a/activities') && url.includes('ac_note')) return json(200, { count: 400, activities: [] });
      if (url.includes('/students/stu-b/activities') && url.includes('ac_photo')) return json(200, { count: 1000, activities: [] });
      if (url.includes('/students/stu-b/activities') && url.includes('ac_note')) return json(200, { count: 200, activities: [] });
      if (url.includes('/message_threads/thr-1/messages')) return json(200, { count: 120, results: [] });
      return json(404, {});
    }) as unknown as typeof fetch;

    const scope = await previewScope(client(fetchImpl), {
      guardianId: 'g-1',
      studentIds: ['stu-a', 'stu-b'],
      threadIds: ['thr-1'],
      studentNames: { 'stu-a': 'Eliza', 'stu-b': 'Milo' },
    }, () => 1_700_000_000_000);

    expect(scope.perStudent).toEqual([
      { studentId: 'stu-a', studentName: 'Eliza', photos: 2000, notes: 400 },
      { studentId: 'stu-b', studentName: 'Milo', photos: 1000, notes: 200 },
    ]);
    expect(scope.threads).toEqual([{ threadId: 'thr-1', messages: 120 }]);
    expect(scope.totalPhotos).toBe(3000);
    expect(scope.totalNotes).toBe(600);
    expect(scope.totalMessages).toBe(120);
    expect(scope.computedAt).toBe(1_700_000_000_000);
  });

  it('returns 0 counts (not throws) when a peek endpoint 404s', async () => {
    // Preview is best-effort; a 404 on one call shouldn't take down the rest.
    const fetchImpl = vi.fn().mockResolvedValue(json(404, {})) as unknown as typeof fetch;
    const scope = await previewScope(client(fetchImpl), {
      guardianId: 'g-1',
      studentIds: ['stu-a'],
      threadIds: [],
    });
    expect(scope.totalPhotos).toBe(0);
    expect(scope.totalNotes).toBe(0);
    expect(scope.totalMessages).toBe(0);
    expect(scope.estimatedBytes).toBe(0);
  });

  it('handles empty studentIds + threadIds without hitting the API at all', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(500, {}))) as unknown as typeof fetch;
    const scope = await previewScope(client(fetchImpl), {
      guardianId: 'g-1', studentIds: [], threadIds: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(scope.totalPhotos).toBe(0);
  });
});

describe('estimateBytes', () => {
  it('is dominated by photos at realistic scale', () => {
    const bytes = estimateBytes(2000, 500, 300);
    // 2000 * 350KB should be the bulk; notes + messages are noise
    expect(bytes).toBeGreaterThan(2000 * 350 * 1024 * 0.99);
    expect(bytes).toBeLessThan(2000 * 350 * 1024 * 1.01);
  });
  it('is zero for empty scope', () => {
    expect(estimateBytes(0, 0, 0)).toBe(0);
  });
});

describe('estimateMs', () => {
  it('divides photo count by concurrency', () => {
    // 3000 photos / 3 concurrency = 1000 slots × 500ms = 500,000ms photos + JSON pages
    const ms = estimateMs(3000, 100, 50);
    expect(ms).toBeGreaterThan(500_000);
    expect(ms).toBeLessThan(510_000);
  });
});

describe('formatBytes', () => {
  it.each([
    [500, '500 B'],
    [2048, '2 KB'],
    [5 * 1024 * 1024, '5 MB'],
    [1.2 * 1024 * 1024 * 1024, '1.2 GB'],
  ])('formats %d as %s', (b, expected) => {
    expect(formatBytes(b)).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    [30_000, '~1 min'],
    [15 * 60_000, '~15 min'],
    [45 * 60_000, '~45 min'],
    [60 * 60_000, '~1 hr'],
    [2.25 * 60 * 60_000, '~2 hr 15 min'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
