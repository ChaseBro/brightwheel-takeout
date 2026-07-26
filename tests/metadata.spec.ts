import { describe, expect, it, vi } from 'vitest';
import { BwClient } from '@/scraper/bw-client';
import { collectMetadata, toManifestSection } from '@/scraper/metadata';
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

const noteActivity = {
  object_id: 'n-1',
  action_type: 'ac_note',
  event_date: '2026-07-17T12:00:00.000Z',
  actor: { object_id: 'a-1', first_name: 'Amanda', last_name: 'T' },
  target: {
    object_id: 'stu-1',
    first_name: 'Eliza',
    last_name: 'B',
    enrollment_status: 'Active',
  },
  room: { object_id: 'room-1', name: 'Pre3', school_id: 'sch-1', color: '#FECC38' },
  note: 'happy',
} as unknown as BwActivity;

describe('metadata orchestrator', () => {
  it('collectMetadata derives schools + student profiles + staff from activities alone (skipProbes)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const meta = await collectMetadata(
      client(fetchImpl),
      { guardianId: 'g-1', studentIds: ['stu-1'], studentNames: { 'stu-1': 'Eliza B' } },
      { notes: [noteActivity], photos: [], messages: [] },
      { skipProbes: true },
    );
    expect(meta.schools['sch-1']).toBeDefined();
    // Placeholder schoolInfo with just the id — probe was skipped.
    expect(meta.schools['sch-1']!.name).toBeUndefined();
    expect(meta.studentProfiles['stu-1']!.displayName).toBe('Eliza B');
    expect(meta.studentProfiles['stu-1']!.primaryRoom?.name).toBe('Pre3');
    expect(meta.studentProfiles['stu-1']!.primarySchoolId).toBe('sch-1');
    expect(meta.staff.members['a-1']!.displayName).toBe('Amanda T');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('collectMetadata probes /schools, /students, /schools/{id}/staff and merges results', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/students/stu-1')) {
        return json(200, {
          object_id: 'stu-1',
          first_name: 'Eliza',
          last_name: 'Brownell',
          birthdate: '2022-06-15',
          allergies: 'peanuts',
        });
      }
      if (url.endsWith('/api/v1/schools/sch-1')) {
        return json(200, { name: 'Lexington Playcare Center', time_zone: 'America/New_York' });
      }
      if (url.endsWith('/api/v1/schools/sch-1/staff')) {
        return json(200, {
          staff: [
            { object_id: 'a-1', first_name: 'Amanda', last_name: 'T', role: 'Lead Teacher' },
            { object_id: 'a-9', first_name: 'Karen', last_name: 'D', role: 'Director' },
          ],
        });
      }
      return json(404, {});
    }) as unknown as typeof fetch;
    const meta = await collectMetadata(
      client(fetchImpl),
      { guardianId: 'g-1', studentIds: ['stu-1'] },
      { notes: [noteActivity], photos: [], messages: [] },
    );
    expect(meta.schools['sch-1']!.name).toBe('Lexington Playcare Center');
    expect(meta.schools['sch-1']!.timeZone).toBe('America/New_York');
    expect(meta.studentProfiles['stu-1']!.birthdate).toBe('2022-06-15');
    expect(meta.studentProfiles['stu-1']!.allergies).toBe('peanuts');
    // Probe wins over derived for staff (role field is present).
    expect(meta.staff.members['a-1']!.role).toBe('Lead Teacher');
    // Director came only from the probe (they never posted).
    expect(meta.staff.members['a-9']!.role).toBe('Director');
  });

  it('collectMetadata never throws for probe 404s — falls back to derived', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(404, {})) as unknown as typeof fetch;
    const meta = await collectMetadata(
      client(fetchImpl),
      { guardianId: 'g-1', studentIds: ['stu-1'] },
      { notes: [noteActivity], photos: [], messages: [] },
    );
    // Derived profile survives.
    expect(meta.studentProfiles['stu-1']!.primaryRoom?.name).toBe('Pre3');
    // Derived staff survives.
    expect(meta.staff.members['a-1']!.displayName).toBe('Amanda T');
    // School placeholder retained.
    expect(meta.schools['sch-1']).toBeDefined();
    expect(meta.schools['sch-1']!.name).toBeUndefined();
    // staff module logged both schools/staff and schools/teachers as unreachable.
    expect(meta.staff.unreachableSchools).toContain('sch-1');
  });

  it('collectMetadata rethrows BwAuthError so session-expiry is not swallowed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401, {})) as unknown as typeof fetch;
    await expect(
      collectMetadata(
        client(fetchImpl),
        { guardianId: 'g-1', studentIds: ['stu-1'] },
        { notes: [noteActivity], photos: [], messages: [] },
      ),
    ).rejects.toMatchObject({ name: 'BwAuthError' });
  });

  it('toManifestSection strips the `raw` blob so the manifest stays small', async () => {
    const meta = await collectMetadata(
      client(vi.fn() as unknown as typeof fetch),
      { guardianId: 'g', studentIds: ['stu-1'] },
      { notes: [noteActivity], photos: [], messages: [] },
      { skipProbes: true },
    );
    // Stuff a raw blob in as if the probe had returned one.
    meta.schools['sch-1'] = { ...meta.schools['sch-1']!, raw: { huge: 'blob' } };
    meta.studentProfiles['stu-1'] = { ...meta.studentProfiles['stu-1']!, raw: { huge: 'blob' } };
    const section = toManifestSection(meta);
    expect((section.schools['sch-1'] as unknown as { raw?: unknown }).raw).toBeUndefined();
    expect((section.student_profiles['stu-1'] as unknown as { raw?: unknown }).raw).toBeUndefined();
  });

  it('collectMetadata falls back to messages senders for staff even when notes are absent', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const messages: Partial<BwMessage>[] = [
      {
        object_id: 'm-1',
        created_at: '2026-07-01T00:00:00.000Z',
        sender: { object_id: 'sender-1', first_name: 'S', last_name: 'One' },
      } as Partial<BwMessage>,
    ];
    const meta = await collectMetadata(
      client(fetchImpl),
      { guardianId: 'g', studentIds: [] },
      { notes: [], photos: [], messages: messages as BwMessage[] },
      { skipProbes: true },
    );
    expect(meta.staff.members['sender-1']!.displayName).toBe('S One');
  });
});
