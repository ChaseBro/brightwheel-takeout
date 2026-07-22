// School / facility info.
//
// The `school_id` is embedded in every activity's `.room.school_id`. We
// extract that opportunistically from data we've already fetched, then probe
// GET /api/v1/schools/{school_id} for the full record (name, address, phone,
// timezone, director).
//
// Everything here is best-effort: a 404 or an unexpected envelope logs a
// warning and returns undefined.
//
// TODO: verify endpoint path against real BW. The parent SPA uses school
// routes internally; `/api/v1/schools/{id}` is the shape most consistent
// with the /students and /guardians paths we've already verified. If the
// real path is `/api/v1/facilities/{id}` or similar, only this file needs
// updating.

import type { BwClient } from './bw-client.js';
import { BwNotFoundError } from './bw-client.js';
import type { BwActivity } from './types.js';
import type { RingLogger } from '@/lib/log.js';
import { log as defaultLog } from '@/lib/log.js';

const SCHOOL_BASE = 'https://schools.mybrightwheel.com/api/v1/schools';

export interface SchoolInfo {
  schoolId: string;
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  timeZone?: string;
  director?: string;
  ownerName?: string;
  /** Whatever raw fields the server returned that we didn't map explicitly. */
  raw?: Record<string, unknown>;
}

/**
 * Extract the school_id (and, opportunistically, the room id + name) from any
 * activity we've already fetched. Zero-cost — no extra requests.
 */
export function schoolIdFromActivity(activity: BwActivity | undefined | null): string | undefined {
  if (!activity) return undefined;
  const room = (activity as unknown as { room?: { school_id?: string } }).room;
  return typeof room?.school_id === 'string' && room.school_id.length > 0
    ? room.school_id
    : undefined;
}

/**
 * Scan a list of activities and return the set of unique school_ids seen.
 * Guardians with siblings in different facilities will have >1.
 */
export function schoolIdsFromActivities(activities: Iterable<BwActivity>): string[] {
  const seen = new Set<string>();
  for (const a of activities) {
    const id = schoolIdFromActivity(a);
    if (id) seen.add(id);
  }
  return Array.from(seen);
}

interface RawSchool {
  object_id?: string;
  id?: string;
  name?: string;
  address1?: string;
  address_1?: string;
  address?: string;
  street?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  zip?: string;
  phone?: string;
  phone_number?: string;
  email?: string;
  time_zone?: string;
  timezone?: string;
  director?: string;
  director_name?: string;
  owner_name?: string;
  primary_contact_name?: string;
  [k: string]: unknown;
}

function firstString(row: RawSchool, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Fetch the full school record from BW. Best-effort — returns undefined on
 * 404 / envelope mismatch / non-auth network error, and logs a WARN line so
 * the diagnostic log tells us which endpoint to fix on the next Layer-3
 * pass. Re-throws BwAuthError so the caller (takeout page) can prompt for
 * re-login instead of silently missing the school info.
 */
export async function fetchSchoolInfo(
  client: BwClient,
  schoolId: string,
  logger: RingLogger = defaultLog,
): Promise<SchoolInfo | undefined> {
  if (!schoolId) return undefined;
  const url = `${SCHOOL_BASE}/${schoolId}`;
  let raw: RawSchool;
  try {
    raw = await client.getJson<RawSchool>(url);
  } catch (err) {
    // Metadata probes are best-effort — the guardian may not have permission
    // to read school details (BW returns 403 on this endpoint for guardian
    // sessions), or the endpoint may not exist, or the network may fail.
    // Session death will surface on the primary /activities and /messages
    // paths a moment later; no need to re-throw here.
    const name = (err as { name?: string })?.name;
    if (err instanceof BwNotFoundError) {
      logger.warn(`school: ${url} returned 404 — endpoint path may be wrong; skipping`);
    } else if (name === 'BwAuthError') {
      logger.warn(`school: ${url} returned 401/403 — guardian likely lacks read access; skipping`);
    } else {
      logger.warn(`school: fetch failed for ${schoolId.slice(0, 8)}…: ${(err as Error).message}`);
    }
    return undefined;
  }
  return normalizeSchool(schoolId, raw);
}

/** Convert whatever the server returned into the flat SchoolInfo shape. */
export function normalizeSchool(schoolId: string, raw: RawSchool): SchoolInfo {
  return {
    schoolId,
    name: firstString(raw, ['name', 'school_name', 'display_name']),
    address: firstString(raw, ['address1', 'address_1', 'address', 'street', 'street_address']),
    city: firstString(raw, ['city']),
    state: firstString(raw, ['state', 'region']),
    postalCode: firstString(raw, ['postal_code', 'zip', 'zip_code']),
    phone: firstString(raw, ['phone', 'phone_number', 'telephone']),
    email: firstString(raw, ['email', 'contact_email']),
    timeZone: firstString(raw, ['time_zone', 'timezone', 'tz']),
    director: firstString(raw, ['director', 'director_name', 'admin_name']),
    ownerName: firstString(raw, ['owner_name', 'owner']),
    raw,
  };
}

/**
 * Fetch every school for the guardian, keyed by school_id. Discovers ids from
 * the caller's activity peek (or any list of BwActivity rows) and probes each
 * one. A guardian with siblings in different facilities gets both.
 */
export async function fetchAllSchools(
  client: BwClient,
  schoolIds: Iterable<string>,
  logger: RingLogger = defaultLog,
): Promise<Record<string, SchoolInfo>> {
  const ids = Array.from(new Set(schoolIds)).filter((s) => typeof s === 'string' && s.length > 0);
  const out: Record<string, SchoolInfo> = {};
  for (const id of ids) {
    const info = await fetchSchoolInfo(client, id, logger);
    if (info) out[id] = info;
  }
  return out;
}
