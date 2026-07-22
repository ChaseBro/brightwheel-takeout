// @vitest-environment node
//
// End-to-end coverage for the metadata + daily-reports wiring in run(): the
// enriched sections (school, student_profiles, staff) should land in
// manifest.json, and opting into daily-reports should emit a sidecar
// daily-reports.csv without disturbing the primary CSV outputs.

import { describe, expect, it, vi } from 'vitest';
import { run } from '@/scraper/run';
import { NullSync } from '@/lib/sync';
import type { DirectoryHandleLike, FileHandleLike, WritableLike } from '@/scraper/sinks';
import { FolderSink } from '@/scraper/sinks';
import type { Session } from '@/scraper/types';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function jsonStatus(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Minimal in-memory folder sink harness — captures every file the run
 * emitted so specific paths (manifest.json, daily-reports.csv) can be
 * asserted on directly without ZIP parsing.
 */
function memFolder(): {
  root: DirectoryHandleLike;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  const mkFile = (name: string): FileHandleLike => ({
    async createWritable(): Promise<WritableLike> {
      let buf = new Uint8Array(0);
      return {
        async write(data: Uint8Array): Promise<void> {
          const merged = new Uint8Array(buf.length + data.length);
          merged.set(buf);
          merged.set(data, buf.length);
          buf = merged;
        },
        async close(): Promise<void> {
          files.set(name, buf);
        },
      };
    },
  });
  function mkDir(prefix: string): DirectoryHandleLike {
    return {
      async getDirectoryHandle(name: string) {
        return mkDir(prefix ? `${prefix}/${name}` : name);
      },
      async getFileHandle(name: string) {
        return mkFile(prefix ? `${prefix}/${name}` : name);
      },
    };
  }
  return { root: mkDir(''), files };
}

const SCHOOL_ID = 'sch-1';
const ROOM = { object_id: 'room-1', name: 'Pre3', school_id: SCHOOL_ID, color: '#FECC38' };

function makeSession(): Session {
  return {
    guardianId: 'g-1',
    clientUuid: 'c-1',
    userUuid: 'u-1',
    csrfToken: 'csrf',
    studentIds: ['stu-1'],
    threadIds: ['thr-1'],
  };
}

describe('run + metadata + daily reports', () => {
  it('writes school/student_profiles/staff sections into manifest.json', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/message_threads/thr-1/messages')) return json({ results: [], has_more: false });
      if (url.includes('/api/v1/students/stu-1/activities')) {
        const u = new URL(url);
        if (u.searchParams.get('page') !== '0') return json({ activities: [] });
        if (u.searchParams.get('action_type') === 'ac_note') {
          return json({
            activities: [
              {
                object_id: 'note-1',
                action_type: 'ac_note',
                event_date: '2026-07-17T12:00:00Z',
                actor: { object_id: 'a-1', first_name: 'Amanda', last_name: 'T' },
                target: { object_id: 'stu-1', first_name: 'Eliza', last_name: 'B' },
                room: ROOM,
                note: 'A note',
              },
            ],
            count: 1,
          });
        }
        return json({ activities: [] });
      }
      if (url.endsWith(`/api/v1/students/stu-1`)) {
        return json({
          object_id: 'stu-1',
          first_name: 'Eliza',
          last_name: 'Brownell',
          birthdate: '2022-06-15',
        });
      }
      if (url.endsWith(`/api/v1/schools/${SCHOOL_ID}`)) {
        return json({ name: 'Lexington Playcare Center', time_zone: 'America/New_York' });
      }
      if (url.endsWith(`/api/v1/schools/${SCHOOL_ID}/staff`)) {
        return json({
          staff: [
            { object_id: 'a-1', first_name: 'Amanda', last_name: 'T', role: 'Lead Teacher' },
            { object_id: 'a-9', first_name: 'Karen', last_name: 'D', role: 'Director' },
          ],
        });
      }
      return jsonStatus(404, {});
    }) as unknown as typeof fetch;

    const { root, files } = memFolder();
    const result = await run({
      session: makeSession(),
      sink: new FolderSink(root),
      progress: { post: () => {} },
      sync: new NullSync(),
      fetchImpl,
      clock: () => 1_700_000_000_000,
      extensionVersion: '0.1.0-test',
      format: 'json',
      // Photos off so the test doesn't need JPG fixtures.
      include: { photos: false, notes: true, messages: true, viewer: true, dailyReports: false },
    });

    // Manifest exists and carries the enriched sections.
    const manifestBytes = files.get('manifest.json');
    expect(manifestBytes).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!)) as {
      school?: Record<string, { name?: string; timeZone?: string }>;
      student_profiles?: Record<string, { birthdate?: string; primaryRoom?: { name?: string } }>;
      staff?: Record<string, { role?: string; displayName: string }>;
    };
    expect(manifest.school?.[SCHOOL_ID]?.name).toBe('Lexington Playcare Center');
    expect(manifest.school?.[SCHOOL_ID]?.timeZone).toBe('America/New_York');
    expect(manifest.student_profiles?.['stu-1']?.birthdate).toBe('2022-06-15');
    expect(manifest.student_profiles?.['stu-1']?.primaryRoom?.name).toBe('Pre3');
    expect(manifest.staff?.['a-1']?.role).toBe('Lead Teacher');
    expect(manifest.staff?.['a-9']?.role).toBe('Director');

    // Result-level guardian id unchanged; new fields are additive.
    expect(result.guardianId).toBe('g-1');
    expect(result.counts.notes).toBe(1);
  }, 15_000);

  it('emits daily-reports.csv when dailyReports include-flag is on, with counts_by_kind in manifest', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/message_threads/')) return json({ results: [], has_more: false });
      if (url.includes('/api/v1/students/stu-1/activities')) {
        const u = new URL(url);
        if (u.searchParams.get('page') !== '0') return json({ activities: [] });
        const type = u.searchParams.get('action_type');
        if (type === 'ac_note') return json({ activities: [] });
        if (type === 'ac_food') {
          return json({
            activities: [
              {
                object_id: 'f-1',
                action_type: 'ac_food',
                event_date: '2026-07-17T12:00:00Z',
                actor: { object_id: 'a-1', first_name: 'Amanda', last_name: 'T' },
                target: { object_id: 'stu-1' },
                note: 'ate 3/4 cheese',
              },
            ],
            count: 1,
          });
        }
        if (type === 'ac_nap') {
          return json({
            activities: [
              {
                object_id: 'n-1',
                action_type: 'ac_nap',
                event_date: '2026-07-17T13:00:00Z',
                actor: { object_id: 'a-1', first_name: 'Amanda', last_name: 'T' },
                target: { object_id: 'stu-1' },
                details_blob: { duration_minutes: 90 },
              },
            ],
            count: 1,
          });
        }
        return json({ activities: [] });
      }
      if (url.endsWith('/api/v1/students/stu-1')) return jsonStatus(404, {});
      if (url.includes('/api/v1/schools/')) return jsonStatus(404, {});
      return jsonStatus(404, {});
    }) as unknown as typeof fetch;

    const { root, files } = memFolder();
    await run({
      session: makeSession(),
      sink: new FolderSink(root),
      progress: { post: () => {} },
      sync: new NullSync(),
      fetchImpl,
      clock: () => 1_700_000_000_000,
      extensionVersion: '0.1.0-test',
      format: 'csv',
      include: { photos: false, notes: true, messages: true, viewer: false, dailyReports: true },
    });

    const dailyBytes = files.get('daily-reports.csv');
    expect(dailyBytes).toBeDefined();
    const text = new TextDecoder().decode(dailyBytes!);
    expect(text).toMatch(/food/);
    expect(text).toMatch(/ate 3\/4 cheese/);
    expect(text).toMatch(/nap/);
    expect(text).toMatch(/duration_minutes/);

    const manifestBytes = files.get('manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!)) as {
      daily_reports?: { counts_by_kind?: Record<string, number>; empty_kinds?: string[] };
      counts?: { dailyReports?: number };
    };
    expect(manifest.daily_reports?.counts_by_kind?.ac_food).toBe(1);
    expect(manifest.daily_reports?.counts_by_kind?.ac_nap).toBe(1);
    expect(manifest.counts?.dailyReports).toBe(2);
    // Every non-food, non-nap kind returned zero → recorded as empty.
    expect(manifest.daily_reports?.empty_kinds).toContain('ac_health_check');
    expect(manifest.daily_reports?.empty_kinds).toContain('ac_video');
  }, 20_000);

  it('does not emit daily-reports.csv when the include-flag is off (default)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/message_threads/')) return json({ results: [], has_more: false });
      if (url.includes('/api/v1/students/stu-1/activities')) return json({ activities: [] });
      return jsonStatus(404, {});
    }) as unknown as typeof fetch;
    const { root, files } = memFolder();
    await run({
      session: makeSession(),
      sink: new FolderSink(root),
      progress: { post: () => {} },
      sync: new NullSync(),
      fetchImpl,
      clock: () => 1_700_000_000_000,
      format: 'csv',
      include: { photos: false, notes: true, messages: false, viewer: false }, // dailyReports omitted
    });
    expect(files.has('daily-reports.csv')).toBe(false);
    // And we didn't spuriously hit any additional-activity URLs.
    const called = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c[0])
      .filter((u): u is string => typeof u === 'string');
    expect(called.some((u) => u.includes('action_type=ac_food'))).toBe(false);
    expect(called.some((u) => u.includes('action_type=ac_nap'))).toBe(false);
  }, 15_000);
});
