import { describe, expect, it, vi } from 'vitest';
import { BwClient } from '@/scraper/bw-client';
import {
  deriveStaffFromActivities,
  fetchSchoolStaff,
  fetchStaffRoster,
} from '@/scraper/staff';
import type { BwActivity, BwMessage } from '@/scraper/types';

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

describe('staff', () => {
  it('deriveStaffFromActivities merges actor + sender records, dedupes by object_id', () => {
    const notes: Partial<BwActivity>[] = [
      {
        object_id: 'n-1',
        event_date: '2026-07-17T12:00:00.000Z',
        actor: { object_id: 'a-1', first_name: 'Amanda', last_name: 'T', user_type: 'teacher' },
        target: { object_id: 'stu-1' },
        room: { school_id: 'sch-1' },
      } as unknown as Partial<BwActivity>,
      {
        object_id: 'n-2',
        event_date: '2026-07-18T12:00:00.000Z',
        actor: { object_id: 'a-1', first_name: 'Amanda', last_name: 'T' },
        target: { object_id: 'stu-1' },
        room: { school_id: 'sch-1' },
      } as unknown as Partial<BwActivity>,
    ];
    const messages: Partial<BwMessage>[] = [
      {
        object_id: 'm-1',
        created_at: '2026-07-16T00:00:00.000Z',
        sender: { object_id: 'a-2', first_name: 'Karen', last_name: 'E', user_type: 'teacher' },
      } as unknown as Partial<BwMessage>,
      // A staff member who both posts a note AND sends a message is merged.
      {
        object_id: 'm-2',
        created_at: '2026-07-19T00:00:00.000Z',
        sender: { object_id: 'a-1', first_name: 'Amanda', last_name: 'T' },
      } as unknown as Partial<BwMessage>,
    ];
    const map = new Map<string, string>([['stu-1', 'sch-1']]);
    const staff = deriveStaffFromActivities(notes as BwActivity[], messages as BwMessage[], map);
    expect(Object.keys(staff).sort()).toEqual(['a-1', 'a-2']);
    expect(staff['a-1']!.displayName).toBe('Amanda T');
    expect(staff['a-1']!.source).toBe('derived');
    expect(staff['a-1']!.schoolIds).toEqual(['sch-1']);
    // firstSeenAt is the earliest, lastSeenAt is the latest across sources.
    expect(staff['a-1']!.firstSeenAt).toBe('2026-07-17T12:00:00.000Z');
    expect(staff['a-1']!.lastSeenAt).toBe('2026-07-19T00:00:00.000Z');
  });

  it('deriveStaffFromActivities falls back to studentToSchool map when room lacks school_id', () => {
    const notes: Partial<BwActivity>[] = [
      {
        object_id: 'n-1',
        event_date: '2026-07-17T12:00:00.000Z',
        actor: { object_id: 'a-1' },
        target: { object_id: 'stu-1' },
        room: {},
      } as unknown as Partial<BwActivity>,
    ];
    const map = new Map<string, string>([['stu-1', 'sch-9']]);
    const staff = deriveStaffFromActivities(notes as BwActivity[], [], map);
    expect(staff['a-1']!.schoolIds).toEqual(['sch-9']);
  });

  it('fetchSchoolStaff tries /staff first, falls back to /teachers on 404', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url.endsWith('/staff')) return json(404, {});
      if (url.endsWith('/teachers')) {
        return json(200, {
          teachers: [
            { object_id: 't-1', first_name: 'T', last_name: 'One', role: 'Teacher' },
            { object_id: 't-2', first_name: 'T', last_name: 'Two' },
          ],
        });
      }
      return json(404, {});
    }) as unknown as typeof fetch;
    const list = await fetchSchoolStaff(client(fetchImpl), 'sch-1');
    expect(list).toBeDefined();
    expect(list!.length).toBe(2);
    expect(list![0]!.role).toBe('Teacher');
    expect(list![0]!.source).toBe('probe');
    expect(calls[0]).toContain('/staff');
    expect(calls[1]).toContain('/teachers');
  });

  it('fetchSchoolStaff returns undefined when both /staff and /teachers 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(404, {})) as unknown as typeof fetch;
    const list = await fetchSchoolStaff(client(fetchImpl), 'sch-1');
    expect(list).toBeUndefined();
  });

  it('fetchSchoolStaff degrades on 403/401 (BW forbids guardians from reading staff — metadata is best-effort)', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn().mockResolvedValue(json(status, {})) as unknown as typeof fetch;
      const list = await fetchSchoolStaff(client(fetchImpl), 'sch-1');
      expect(list).toBeUndefined();
    }
  });

  it('fetchStaffRoster merges probe wins over derived and tracks unreachableSchools', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/sch-a/staff')) {
        return json(200, {
          staff: [{ object_id: 'a-1', first_name: 'Amanda', last_name: 'T', role: 'Lead Teacher' }],
        });
      }
      if (url.endsWith('/sch-b/staff') || url.endsWith('/sch-b/teachers')) {
        return json(404, {});
      }
      return json(404, {});
    }) as unknown as typeof fetch;

    const notes: Partial<BwActivity>[] = [
      {
        object_id: 'n-1',
        event_date: '2026-07-17T12:00:00.000Z',
        actor: { object_id: 'a-1', first_name: 'Amanda', last_name: 'T' },
        target: { object_id: 'stu-1' },
        room: { school_id: 'sch-a' },
      } as unknown as Partial<BwActivity>,
      {
        object_id: 'n-2',
        event_date: '2026-07-17T12:00:00.000Z',
        actor: { object_id: 'a-3', first_name: 'Bob', last_name: 'Z' },
        target: { object_id: 'stu-2' },
        room: { school_id: 'sch-b' },
      } as unknown as Partial<BwActivity>,
    ];

    const roster = await fetchStaffRoster(
      client(fetchImpl),
      ['sch-a', 'sch-b'],
      notes as BwActivity[],
      [],
      [],
      new Map(),
    );
    expect(roster.probedSchools).toEqual(['sch-a']);
    expect(roster.unreachableSchools).toEqual(['sch-b']);
    // a-1 is a probe hit (Lead Teacher) merged over the derived record.
    expect(roster.members['a-1']!.source).toBe('probe');
    expect(roster.members['a-1']!.role).toBe('Lead Teacher');
    // a-3 came only from derived.
    expect(roster.members['a-3']!.source).toBe('derived');
    // Both schools associated for a-1.
    expect(roster.members['a-1']!.schoolIds.sort()).toEqual(['sch-a']);
  });

  it('fetchStaffRoster tolerates an unexpected envelope shape (unknown fields)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(200, { unexpected: 'shape' }),
    ) as unknown as typeof fetch;
    const roster = await fetchStaffRoster(
      client(fetchImpl),
      ['sch-a'],
      [],
      [],
      [],
      new Map(),
    );
    // Envelope had no staff/teachers/results — treated as empty probe.
    expect(roster.probedSchools).toEqual(['sch-a']);
    expect(Object.keys(roster.members)).toHaveLength(0);
  });
});
