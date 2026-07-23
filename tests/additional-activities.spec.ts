import { describe, expect, it, vi } from 'vitest';
import { BwClient } from '@/scraper/bw-client';
import {
  DAILY_REPORT_ACTION_TYPES,
  fetchAdditionalActivities,
  flattenDailyReports,
  summarizeDailyReport,
  type DailyReportKind,
} from '@/scraper/additional-activities';
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

function fakeAct(kind: string, id: string, note?: string): Partial<BwActivity> {
  return {
    object_id: id,
    action_type: kind,
    event_date: '2026-07-17T12:00:00.000Z',
    actor: { object_id: 'a', first_name: 'Amanda', last_name: 'T' },
    target: { object_id: 'stu-1' },
    ...(note ? { note } : {}),
  } as Partial<BwActivity>;
}

describe('additional-activities', () => {
  it('DAILY_REPORT_ACTION_TYPES includes the parent-facing kinds', () => {
    expect(DAILY_REPORT_ACTION_TYPES).toContain('ac_food');
    expect(DAILY_REPORT_ACTION_TYPES).toContain('ac_nap');
    expect(DAILY_REPORT_ACTION_TYPES).toContain('ac_health_check');
    expect(DAILY_REPORT_ACTION_TYPES).toContain('ac_video');
  });

  it('fetchAdditionalActivities returns per-kind arrays and totalCount', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('action_type=ac_food')) {
        return json(200, { count: 1, activities: [fakeAct('ac_food', 'f-1', 'ate cheese')] });
      }
      if (url.includes('action_type=ac_nap')) {
        return json(200, { count: 2, activities: [fakeAct('ac_nap', 'n-1'), fakeAct('ac_nap', 'n-2')] });
      }
      return json(200, { count: 0, activities: [] });
    }) as unknown as typeof fetch;

    const out = await fetchAdditionalActivities(client(fetchImpl), ['stu-1'], {
      kinds: ['ac_food', 'ac_nap'],
      delayMs: 0,
    });
    expect(out.totalCount).toBe(3);
    expect(out.byKind.ac_food).toHaveLength(1);
    expect(out.byKind.ac_nap).toHaveLength(2);
    expect(out.emptyProbes).toHaveLength(0);
  });

  it('fetchAdditionalActivities records empty probes without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { count: 0, activities: [] })) as unknown as typeof fetch;
    const out = await fetchAdditionalActivities(client(fetchImpl), ['stu-1'], {
      kinds: ['ac_incident', 'ac_medication'],
      delayMs: 0,
    });
    expect(out.totalCount).toBe(0);
    expect(out.emptyProbes.map((e) => e.kind).sort()).toEqual(['ac_incident', 'ac_medication']);
  });

  it('fetchAdditionalActivities swallows 404 (endpoint absent) and continues to next kind', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('action_type=ac_medication')) return json(404, {});
      if (url.includes('action_type=ac_food')) {
        return json(200, { count: 1, activities: [fakeAct('ac_food', 'f-1')] });
      }
      return json(200, { count: 0, activities: [] });
    }) as unknown as typeof fetch;
    const out = await fetchAdditionalActivities(client(fetchImpl), ['stu-1'], {
      kinds: ['ac_medication', 'ac_food'],
      delayMs: 0,
    });
    expect(out.byKind.ac_food).toHaveLength(1);
    expect(out.byKind.ac_medication).toHaveLength(0);
    // ac_medication is 404 → treated as empty probe.
    expect(out.emptyProbes.some((e) => e.kind === 'ac_medication')).toBe(true);
  });

  it('fetchAdditionalActivities degrades on 401 (metadata probe, not a primary path)', async () => {
    // Additional-activity kinds are best-effort probes — a 401 from any kind
    // should log a warning and return that kind as empty, not kill the run.
    // Session expiry still surfaces on the primary notes/photos/messages paths.
    const fetchImpl = vi.fn().mockResolvedValue(json(401, {})) as unknown as typeof fetch;
    const out = await fetchAdditionalActivities(client(fetchImpl), ['stu-1'], {
      kinds: ['ac_food'],
      delayMs: 0,
    });
    expect(out.byKind.ac_food).toEqual([]);
  });

  it('fetchAdditionalActivities honors AbortSignal between kinds', async () => {
    let called = 0;
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(async () => {
      called++;
      if (called >= 1) controller.abort();
      return json(200, { count: 0, activities: [] });
    }) as unknown as typeof fetch;
    const out = await fetchAdditionalActivities(client(fetchImpl), ['stu-1'], {
      kinds: ['ac_food', 'ac_nap', 'ac_potty'],
      delayMs: 0,
      signal: controller.signal,
    });
    expect(called).toBeLessThan(3);
    expect(out.totalCount).toBe(0);
  });

  it('summarizeDailyReport prefers note, falls back to details_blob, then health_check', () => {
    expect(
      summarizeDailyReport({ note: 'ate 3/4' } as unknown as BwActivity, 'ac_food'),
    ).toBe('ate 3/4');
    expect(
      summarizeDailyReport(
        { details_blob: { amount: 'most', kind: 'lunch' } } as unknown as BwActivity,
        'ac_food',
      ),
    ).toContain('amount: most');
    expect(
      summarizeDailyReport(
        { health_check: { temp: 98.6 } } as unknown as BwActivity,
        'ac_health_check',
      ),
    ).toContain('temp');
  });

  it('flattenDailyReports orders newest first and hydrates studentName via callback', () => {
    const byKind: Record<DailyReportKind, BwActivity[]> = {
      ac_health_check: [],
      ac_food: [
        {
          object_id: 'f-2',
          action_type: 'ac_food',
          event_date: '2026-07-18T09:00:00.000Z',
          target: { object_id: 'stu-1' },
          note: 'newer',
        } as unknown as BwActivity,
      ],
      ac_nap: [
        {
          object_id: 'n-1',
          action_type: 'ac_nap',
          event_date: '2026-07-17T13:00:00.000Z',
          target: { object_id: 'stu-1' },
          note: 'older',
        } as unknown as BwActivity,
      ],
      ac_bathroom: [],
      ac_potty: [],
      ac_incident: [],
      ac_medication: [],
      ac_video: [],
    };
    const rows = flattenDailyReports(byKind, () => 'Eliza');
    expect(rows[0]!.summary).toBe('newer');
    expect(rows[1]!.summary).toBe('older');
    expect(rows[0]!.studentName).toBe('Eliza');
    expect(rows[0]!.kindLabel).toBe('food');
  });
});
