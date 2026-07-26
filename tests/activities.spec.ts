import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BwClient } from '@/scraper/bw-client';
import { fetchAllActivities, iterateActivities } from '@/scraper/activities';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/eliza-notes.json'), 'utf8'),
) as { notes: Array<{ object_id: string; event_date: string }> };

function json(body: unknown, status = 200): Response {
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

describe('activities pagination', () => {
  it('stops when a page returns fewer than page_size rows', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      const page = new URL(u).searchParams.get('page');
      if (page === '0') return json({ activities: fixture.notes.slice(0, 3), count: 5 });
      if (page === '1') return json({ activities: fixture.notes.slice(3, 5), count: 5 });
      return json({ activities: [], count: 5 });
    }) as unknown as typeof fetch;
    const acts = await fetchAllActivities(client(fetchImpl), 'student-1', {
      actionType: 'ac_note',
      pageSize: 3,
      delayMs: 0,
    });
    expect(acts.length).toBe(5);
  });

  it('dedupes by object_id across pages', async () => {
    const first = fixture.notes.slice(0, 3);
    const overlap = fixture.notes.slice(2, 5); // note 2 is duplicated
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
      const page = new URL(typeof url === 'string' ? url : url.toString()).searchParams.get('page');
      if (page === '0') return json({ activities: first, count: 10 });
      if (page === '1') return json({ activities: overlap, count: 10 });
      return json({ activities: [], count: 10 });
    }) as unknown as typeof fetch;
    const acts = await fetchAllActivities(client(fetchImpl), 'student-1', {
      actionType: 'ac_note',
      pageSize: 3,
      delayMs: 0,
    });
    // 3 + (3 - 1 duplicate) = 5 unique
    expect(acts.length).toBe(5);
    const seen = new Set(acts.map((a) => a.object_id));
    expect(seen.size).toBe(acts.length);
  });

  it('sorts by event_date descending', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ activities: fixture.notes.slice(0, 5), count: 5 }),
    ) as unknown as typeof fetch;
    const acts = await fetchAllActivities(client(fetchImpl), 'student-1', {
      actionType: 'ac_note',
      pageSize: 1000,
      delayMs: 0,
    });
    for (let i = 1; i < acts.length; i++) {
      expect((acts[i - 1]!.event_date ?? '') >= (acts[i]!.event_date ?? '')).toBe(true);
    }
  });

  it('iterateActivities is an async generator that streams items', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
      const page = new URL(typeof url === 'string' ? url : url.toString()).searchParams.get('page');
      if (page === '0') return json({ activities: fixture.notes.slice(0, 2), count: 3 });
      if (page === '1') return json({ activities: fixture.notes.slice(2, 3), count: 3 });
      return json({ activities: [], count: 3 });
    }) as unknown as typeof fetch;
    const got: string[] = [];
    for await (const a of iterateActivities(client(fetchImpl), 'student-1', {
      actionType: 'ac_note',
      pageSize: 2,
      delayMs: 0,
    })) {
      got.push(a.object_id);
    }
    expect(got.length).toBe(3);
  });

  it('terminates cleanly on repeated full pages of duplicates (no infinite loop)', async () => {
    // Guardrail: a misbehaving server that returns the same 3 items on every
    // page must not loop. We now tolerate ONE transient all-duplicate page
    // (the feed can shift under concurrent writes), so termination happens
    // after two consecutive all-duplicate pages — still bounded, still no loop.
    const first = fixture.notes.slice(0, 3);
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call++;
      return json({ activities: first, count: 3 });
    }) as unknown as typeof fetch;
    const acts = await fetchAllActivities(client(fetchImpl), 'student-1', {
      actionType: 'ac_note',
      pageSize: 3,
      delayMs: 0,
    });
    expect(acts.length).toBe(3);
    // page 0 filled seen (3 new); page 1 all-dup (1st); page 2 all-dup (2nd) → bail.
    expect(call).toBe(3);
  });

  it('does NOT truncate when a single all-duplicate page is followed by new items', async () => {
    // The scenario the old single-page bail got wrong: a live feed shifts so
    // page 1 fully overlaps page 0, but genuinely-new items still exist on
    // page 2. The old code bailed at page 1 and lost them; now they're kept.
    const pageA = fixture.notes.slice(0, 3); // page 0
    const pageC = fixture.notes.slice(3, 6); // page 2 — new items
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
      const page = new URL(typeof url === 'string' ? url : url.toString()).searchParams.get('page');
      if (page === '0') return json({ activities: pageA, count: 6 });
      if (page === '1') return json({ activities: pageA, count: 6 }); // transient full overlap
      if (page === '2') return json({ activities: pageC, count: 6 });
      return json({ activities: [], count: 6 });
    }) as unknown as typeof fetch;
    const acts = await fetchAllActivities(client(fetchImpl), 'student-1', {
      actionType: 'ac_note',
      pageSize: 3,
      delayMs: 0,
    });
    // All 6 unique items survive — the transient duplicate page did not stop us.
    expect(acts.length).toBe(6);
  });

  it('respects an onPage callback for progress reporting', async () => {
    const pages: number[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
      const page = new URL(typeof url === 'string' ? url : url.toString()).searchParams.get('page');
      if (page === '0') return json({ activities: fixture.notes.slice(0, 2), count: 3 });
      return json({ activities: [], count: 3 });
    }) as unknown as typeof fetch;
    await fetchAllActivities(client(fetchImpl), 'student-1', {
      actionType: 'ac_note',
      pageSize: 2,
      delayMs: 0,
      onPage: (i) => pages.push(i.page),
    });
    // pageSize was 2, page 0 returned exactly 2 items → we fetch page 1
    // (which returns 0 items and terminates the loop). onPage fires for
    // both pages.
    expect(pages).toEqual([0, 1]);
  });
});
