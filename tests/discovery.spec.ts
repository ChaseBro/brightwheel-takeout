import { describe, expect, it, vi } from 'vitest';
import { BwClient } from '@/scraper/bw-client';
import {
  discoverRoster,
  fetchGuardianCurrent,
  fetchMessageThreads,
} from '@/scraper/discovery';

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

// Helper that routes a two-call flow: /users/me → then /guardians/{id}/students.
function twoCallFetch(meResp: Response, rosterResp: Response): typeof fetch {
  return vi.fn().mockImplementation(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/users/me')) return meResp.clone();
    if (url.includes('/students')) return rosterResp.clone();
    return json(404, {});
  }) as unknown as typeof fetch;
}

describe('discovery', () => {
  it('fetchGuardianCurrent hits /users/me then /guardians/{id}/students and unwraps nested student rows', async () => {
    const me = json(200, { object_id: 'g-1', first_name: 'Alex', last_name: 'Parent' });
    const roster = json(200, {
      count: 2,
      students: [
        {
          relationship_type: 'parent',
          guardian_id: 'g-1',
          student: { object_id: 'stu-a', first_name: 'Eliza' },
        },
        {
          relationship_type: 'parent',
          guardian_id: 'g-1',
          student: { object_id: 'stu-b', first_name: 'Milo', last_name: 'X' },
        },
      ],
    });
    const r = await fetchGuardianCurrent(client(twoCallFetch(me, roster)), undefined, undefined, { delayMs: 0 });
    expect(r?.guardianId).toBe('g-1');
    expect(r?.students).toEqual([
      { studentId: 'stu-a', displayName: 'Eliza' },
      { studentId: 'stu-b', displayName: 'Milo X' },
    ]);
  });

  it('fetchGuardianCurrent tolerates flat student rows too (defensive)', async () => {
    const me = json(200, { object_id: 'g-2' });
    // Some future BW variant might inline the student fields at the row root.
    const roster = json(200, { count: 1, students: [{ object_id: 'stu-c', first_name: 'C' }] });
    const r = await fetchGuardianCurrent(client(twoCallFetch(me, roster)), undefined, undefined, { delayMs: 0 });
    expect(r?.guardianId).toBe('g-2');
    expect(r?.students[0]?.studentId).toBe('stu-c');
  });

  it('fetchGuardianCurrent returns undefined when /users/me is 404 (endpoint moved)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(404, {})) as unknown as typeof fetch;
    const r = await fetchGuardianCurrent(client(fetchImpl), undefined, undefined, { delayMs: 0 });
    expect(r).toBeUndefined();
  });

  it('seeds x-user-uuid on the client after /users/me so the roster request carries it', async () => {
    // Repro of H2: without the inline updateUserUuid, /students went out
    // with an empty x-user-uuid because the SW only seeded userUuid AFTER
    // discovery finished.
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.endsWith('/api/v1/users/me')) return json(200, { object_id: 'g-uuid-fresh' });
      if (url.includes('/students')) return json(200, { count: 0, students: [] });
      return json(404, {});
    }) as unknown as typeof fetch;
    // Deliberately construct the client with a BLANK userUuid to mirror the
    // enrichSession call site.
    const c = new BwClient(
      { clientUuid: 'c', userUuid: '', csrfToken: 't' },
      { fetchImpl, sleep: async () => {}, retries: 0 },
    );
    await fetchGuardianCurrent(c, undefined, undefined, { delayMs: 0 });
    const rosterCall = calls.find((c) => c.url.includes('/guardians/g-uuid-fresh/students'));
    expect(rosterCall).toBeTruthy();
    expect(rosterCall!.headers['x-user-uuid']).toBe('g-uuid-fresh');
  });

  it('seeds x-user-uuid on the client before /message_threads', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return json(200, { results: [] });
    }) as unknown as typeof fetch;
    const c = new BwClient(
      { clientUuid: 'c', userUuid: '', csrfToken: 't' },
      { fetchImpl, sleep: async () => {}, retries: 0 },
    );
    await fetchMessageThreads(c, 'g-uuid-fresh');
    expect(calls[0]!.headers['x-user-uuid']).toBe('g-uuid-fresh');
  });

  it('fetchGuardianCurrent returns guardianId + empty students when only the roster is 404', async () => {
    const me = json(200, { object_id: 'g-3' });
    const roster = json(404, {});
    const r = await fetchGuardianCurrent(client(twoCallFetch(me, roster)), undefined, undefined, { delayMs: 0 });
    expect(r?.guardianId).toBe('g-3');
    expect(r?.students).toEqual([]);
  });

  it('fetchMessageThreads accepts `threads`, `results`, or `message_threads`', async () => {
    for (const shape of [
      { threads: [{ object_id: 't-1' }, { object_id: 't-2' }] },
      { results: [{ object_id: 't-1' }, { object_id: 't-2' }] },
      { message_threads: [{ id: 't-1' }, { id: 't-2' }] },
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue(json(200, shape)) as unknown as typeof fetch;
      const t = await fetchMessageThreads(client(fetchImpl), 'g-1');
      expect(t).toEqual(['t-1', 't-2']);
    }
  });

  it('fetchMessageThreads prefers object_id over the sibling thread_id', async () => {
    // Live-verified: /messages sub-resource only resolves via object_id;
    // thread_id on the same row is a foreign reference and 404s.
    const shape = { results: [
      { object_id: 'use-me', thread_id: 'do-not-use' },
      { object_id: 'use-me-2', thread_id: 'do-not-use-2' },
    ] };
    const fetchImpl = vi.fn().mockResolvedValue(json(200, shape)) as unknown as typeof fetch;
    const t = await fetchMessageThreads(client(fetchImpl), 'g-1');
    expect(t).toEqual(['use-me', 'use-me-2']);
  });

  it('fetchMessageThreads paginates (M3) — page=0 short → single request; full page → follow-up', async () => {
    // Short first page: fetchMessageThreads must NOT hit page=1.
    let calls: string[] = [];
    let fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      return json(200, { results: [{ object_id: 't-a' }, { object_id: 't-b' }] });
    }) as unknown as typeof fetch;
    let t = await fetchMessageThreads(client(fetchImpl), 'g-1');
    expect(t).toEqual(['t-a', 't-b']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('&page=');

    // Full page (1000 rows) → we should follow up with page=1.
    calls = [];
    const bigPage = Array.from({ length: 1000 }, (_, i) => ({ object_id: `t-${i}` }));
    fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (calls.length === 1) return json(200, { results: bigPage, has_more: true });
      return json(200, { results: [{ object_id: 't-last' }], has_more: false });
    }) as unknown as typeof fetch;
    t = await fetchMessageThreads(client(fetchImpl), 'g-1');
    expect(t.length).toBe(1001);
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('&page=1');
  });

  it('fetchMessageThreads returns [] on 404 (best-effort)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(404, {})) as unknown as typeof fetch;
    const t = await fetchMessageThreads(client(fetchImpl), 'g-1');
    expect(t).toEqual([]);
  });

  it('discoverRoster merges content-script hint students the API didn’t return', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/users/me')) {
        return json(200, { object_id: 'g-1', first_name: 'Alex' });
      }
      if (url.endsWith('/guardians/g-1/students')) {
        return json(200, {
          count: 1,
          students: [
            { relationship_type: 'parent', guardian_id: 'g-1', student: { object_id: 'stu-a', first_name: 'A' } },
          ],
        });
      }
      if (url.includes('/message_threads')) {
        // object_id wins over the sibling thread_id (empirical live behavior).
        return json(200, { results: [{ object_id: 't-1', thread_id: 'ignore-me' }] });
      }
      return json(200, {});
    }) as unknown as typeof fetch;
    const r = await discoverRoster(
      client(fetchImpl),
      { guardianId: 'g-1', studentIds: ['stu-a', 'stu-hint-only'] },
      undefined,
      { delayMs: 0 },
    );
    expect(r.guardianId).toBe('g-1');
    expect(r.students.map((s) => s.studentId).sort()).toEqual(['stu-a', 'stu-hint-only']);
    expect(r.threadIds).toEqual(['t-1']);
    expect(r.studentsSource).toBe('guardians/current');
    expect(r.threadsSource).toBe('message_threads');
  });
});
