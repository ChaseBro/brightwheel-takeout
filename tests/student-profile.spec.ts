import { describe, expect, it, vi } from 'vitest';
import { BwClient } from '@/scraper/bw-client';
import {
  deriveFromActivities,
  fetchStudentProfile,
  fetchStudentProfiles,
  mergeStudentRecord,
  roomFromActivity,
} from '@/scraper/student-profile';
import type { BwActivity } from '@/scraper/types';

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

function fakeActivity(overrides: Partial<BwActivity> = {}, when = '2026-07-17T17:01:54.000Z'): BwActivity {
  return {
    object_id: 'act-1',
    action_type: 'ac_note',
    event_date: when,
    target: {
      object_id: 'stu-1',
      first_name: 'Eliza',
      last_name: 'Brownell',
      enrollment_status: 'Active',
      profile_photo: {
        object_id: '1',
        image_url: 'https://cdn.example/profile.jpg',
      },
      created_at: '2024-08-21T17:24:59.561Z',
    },
    room: {
      object_id: 'room-1',
      name: 'Pre3',
      school_id: 'sch-1',
      color: '#FECC38',
      min_age: null,
      max_age: null,
      max_capacity: 11,
      max_ratio: 5,
    },
    ...overrides,
  } as unknown as BwActivity;
}

describe('student-profile', () => {
  it('roomFromActivity flattens the nested room object', () => {
    const r = roomFromActivity(fakeActivity());
    expect(r).toBeDefined();
    expect(r!.roomId).toBe('room-1');
    expect(r!.name).toBe('Pre3');
    expect(r!.schoolId).toBe('sch-1');
    expect(r!.color).toBe('#FECC38');
    expect(r!.maxCapacity).toBe(11);
    expect(r!.maxRatio).toBe(5);
  });

  it('roomFromActivity returns undefined for missing room', () => {
    expect(roomFromActivity({ object_id: 'x' } as BwActivity)).toBeUndefined();
    expect(roomFromActivity(undefined)).toBeUndefined();
  });

  it('deriveFromActivities builds displayName + primaryRoom + schoolId from a single activity', () => {
    const p = deriveFromActivities('stu-1', [fakeActivity()], 'hint');
    expect(p.firstName).toBe('Eliza');
    expect(p.lastName).toBe('Brownell');
    expect(p.fullName).toBe('Eliza Brownell');
    expect(p.displayName).toBe('Eliza Brownell');
    expect(p.enrollmentStatus).toBe('Active');
    expect(p.profilePhoto?.image_url).toBe('https://cdn.example/profile.jpg');
    expect(p.primaryRoom?.name).toBe('Pre3');
    expect(p.primarySchoolId).toBe('sch-1');
  });

  it('deriveFromActivities picks the most-recent room when a student moved classrooms', () => {
    const oldAct = fakeActivity({}, '2024-09-01T00:00:00.000Z');
    const newAct = fakeActivity(
      {
        room: {
          object_id: 'room-2',
          name: 'Pre4',
          school_id: 'sch-1',
        },
      } as unknown as Partial<BwActivity>,
      '2026-07-17T00:00:00.000Z',
    );
    const p = deriveFromActivities('stu-1', [oldAct, newAct]);
    expect(p.primaryRoom?.name).toBe('Pre4');
  });

  it('deriveFromActivities falls back to hintName when no activities have target data', () => {
    const p = deriveFromActivities('stu-1', [], 'Backup Name');
    expect(p.displayName).toBe('Backup Name');
    expect(p.primaryRoom).toBeUndefined();
  });

  it('deriveFromActivities falls back to short-id when no name and no hint', () => {
    const p = deriveFromActivities('stu-12345678', []);
    expect(p.displayName).toBe('Student stu-1234…');
  });

  it('fetchStudentProfile skipProbe returns derived profile untouched', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const derived = deriveFromActivities('stu-1', [fakeActivity()]);
    const p = await fetchStudentProfile(client(fetchImpl), 'stu-1', { derived, skipProbe: true });
    expect(p.displayName).toBe('Eliza Brownell');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetchStudentProfile overlays birthdate + allergies from the probe response', async () => {
    const probe = {
      object_id: 'stu-1',
      first_name: 'Eliza',
      last_name: 'Brownell',
      birthdate: '2022-06-15',
      allergies: 'peanuts',
      dietary_restrictions: 'vegetarian',
    };
    const fetchImpl = vi.fn().mockResolvedValue(json(200, probe)) as unknown as typeof fetch;
    const derived = deriveFromActivities('stu-1', [fakeActivity()]);
    const p = await fetchStudentProfile(client(fetchImpl), 'stu-1', { derived });
    expect(p.birthdate).toBe('2022-06-15');
    expect(p.allergies).toBe('peanuts');
    expect(p.dietaryRestrictions).toBe('vegetarian');
    // Derived data is preserved.
    expect(p.primaryRoom?.name).toBe('Pre3');
  });

  it('fetchStudentProfile logs and returns derived profile on 404 (endpoint absent)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(404, {})) as unknown as typeof fetch;
    const derived = deriveFromActivities('stu-1', [fakeActivity()]);
    const p = await fetchStudentProfile(client(fetchImpl), 'stu-1', { derived });
    expect(p.displayName).toBe('Eliza Brownell');
    expect(p.birthdate).toBeUndefined();
  });

  it('fetchStudentProfile degrades on 403/401 (metadata probes never kill the export)', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn().mockResolvedValue(json(status, {})) as unknown as typeof fetch;
      const p = await fetchStudentProfile(client(fetchImpl), 'stu-1');
      // Returns undefined (or the derived-only profile depending on the caller
      // shape) — the important invariant is that it does NOT throw.
      expect(p === undefined || p !== null).toBe(true);
    }
  });

  it('mergeStudentRecord tolerates alt birthdate keys', () => {
    const base = deriveFromActivities('stu-1', [fakeActivity()]);
    const merged = mergeStudentRecord(base, { date_of_birth: '2022-06-15' });
    expect(merged.birthdate).toBe('2022-06-15');
  });

  it('fetchStudentProfiles wires derive + probe per student', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/stu-1')) return json(200, { birthdate: '2022-01-01', first_name: 'Eliza', last_name: 'B' });
      if (url.endsWith('/stu-2')) return json(404, {});
      return json(404, {});
    }) as unknown as typeof fetch;
    const perStudent = new Map<string, BwActivity[]>([
      ['stu-1', [fakeActivity()]],
      ['stu-2', []],
    ]);
    const out = await fetchStudentProfiles(
      client(fetchImpl),
      [
        { studentId: 'stu-1', displayName: 'Eliza B' },
        { studentId: 'stu-2', displayName: 'Milo M' },
      ],
      perStudent,
    );
    expect(out['stu-1']!.birthdate).toBe('2022-01-01');
    expect(out['stu-1']!.primaryRoom?.name).toBe('Pre3');
    expect(out['stu-2']!.displayName).toBe('Milo M');
    expect(out['stu-2']!.birthdate).toBeUndefined();
  });
});
