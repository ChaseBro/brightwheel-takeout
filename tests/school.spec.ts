import { describe, expect, it, vi } from 'vitest';
import { BwClient } from '@/scraper/bw-client';
import {
  fetchAllSchools,
  fetchSchoolInfo,
  normalizeSchool,
  schoolIdFromActivity,
  schoolIdsFromActivities,
} from '@/scraper/school';
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

describe('school', () => {
  it('schoolIdFromActivity reads .room.school_id', () => {
    const act = { room: { school_id: 'sch-1' } } as unknown as BwActivity;
    expect(schoolIdFromActivity(act)).toBe('sch-1');
    expect(schoolIdFromActivity(undefined)).toBeUndefined();
    expect(schoolIdFromActivity(null)).toBeUndefined();
    expect(schoolIdFromActivity({ room: {} } as unknown as BwActivity)).toBeUndefined();
  });

  it('schoolIdsFromActivities dedupes across activities', () => {
    const acts = [
      { room: { school_id: 'sch-1' } },
      { room: { school_id: 'sch-2' } },
      { room: { school_id: 'sch-1' } },
      { room: {} },
      {},
    ] as unknown as BwActivity[];
    expect(schoolIdsFromActivities(acts).sort()).toEqual(['sch-1', 'sch-2']);
  });

  it('fetchSchoolInfo maps the shape and preserves raw', async () => {
    const raw = {
      object_id: 'sch-1',
      name: 'Lexington Playcare Center',
      address1: '1 Main St',
      city: 'Lexington',
      state: 'MA',
      postal_code: '02420',
      phone: '555-1212',
      time_zone: 'America/New_York',
      director: 'Karen Espinola',
      extra_field: 'value',
    };
    const fetchImpl = vi.fn().mockResolvedValue(json(200, raw)) as unknown as typeof fetch;
    const info = await fetchSchoolInfo(client(fetchImpl), 'sch-1');
    expect(info).toBeDefined();
    expect(info!.schoolId).toBe('sch-1');
    expect(info!.name).toBe('Lexington Playcare Center');
    expect(info!.address).toBe('1 Main St');
    expect(info!.city).toBe('Lexington');
    expect(info!.state).toBe('MA');
    expect(info!.postalCode).toBe('02420');
    expect(info!.phone).toBe('555-1212');
    expect(info!.timeZone).toBe('America/New_York');
    expect(info!.director).toBe('Karen Espinola');
    expect(info!.raw).toEqual(raw);
  });

  it('fetchSchoolInfo returns undefined on 404 (endpoint path wrong)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(404, {})) as unknown as typeof fetch;
    const info = await fetchSchoolInfo(client(fetchImpl), 'sch-missing');
    expect(info).toBeUndefined();
  });

  it('fetchSchoolInfo degrades on 403 (BW forbids guardians from reading school details)', async () => {
    // Live-observed: BW returns 403 on /api/v1/schools/{id} for guardian
    // sessions. That's a policy result, not session death — the primary
    // /activities calls succeed just fine on the same session. Metadata
    // probes are best-effort; a 403 must not kill the whole export.
    const fetchImpl = vi.fn().mockResolvedValue(json(403, {})) as unknown as typeof fetch;
    const info = await fetchSchoolInfo(client(fetchImpl), 'sch-1');
    expect(info).toBeUndefined();
  });

  it('fetchSchoolInfo degrades on 401 too (session expiry will surface on the primary paths)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401, {})) as unknown as typeof fetch;
    const info = await fetchSchoolInfo(client(fetchImpl), 'sch-1');
    expect(info).toBeUndefined();
  });

  it('fetchSchoolInfo returns undefined and logs on 500 (best-effort)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(500, {})) as unknown as typeof fetch;
    const info = await fetchSchoolInfo(client(fetchImpl), 'sch-1');
    expect(info).toBeUndefined();
  });

  it('fetchSchoolInfo returns undefined for empty schoolId', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const info = await fetchSchoolInfo(client(fetchImpl), '');
    expect(info).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalizeSchool tolerates alt field names', () => {
    const info = normalizeSchool('sch-1', {
      school_name: 'Alt Name Field',
      street_address: '123 Other',
      zip: '12345',
      phone_number: '999',
      timezone: 'UTC',
      director_name: 'D',
    });
    expect(info.name).toBe('Alt Name Field');
    expect(info.address).toBe('123 Other');
    expect(info.postalCode).toBe('12345');
    expect(info.phone).toBe('999');
    expect(info.timeZone).toBe('UTC');
    expect(info.director).toBe('D');
  });

  it('fetchAllSchools dedupes and returns a map keyed by id', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url.endsWith('/sch-a')) return json(200, { name: 'A' });
      if (url.endsWith('/sch-b')) return json(200, { name: 'B' });
      return json(404, {});
    }) as unknown as typeof fetch;
    const out = await fetchAllSchools(client(fetchImpl), ['sch-a', 'sch-b', 'sch-a', '']);
    expect(Object.keys(out).sort()).toEqual(['sch-a', 'sch-b']);
    expect(out['sch-a']!.name).toBe('A');
    expect(out['sch-b']!.name).toBe('B');
    expect(calls).toHaveLength(2);
  });
});
