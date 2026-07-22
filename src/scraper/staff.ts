// Staff / teacher roster.
//
// Two sources, always merged:
//   1. Probe — GET /api/v1/schools/{school_id}/staff (fallback
//      /teachers). Best-effort — 404 keeps only the derived roster.
//   2. Derived — every unique `actor` on the notes we already fetched
//      plus every `sender` on the messages. Guaranteed to work; misses
//      silent staff (front-desk, director) who never posted content.
//
// The output is one flat StaffMember list per school_id.
//
// TODO: verify endpoint paths against real BW.

import type { BwClient } from './bw-client.js';
import { BwNotFoundError } from './bw-client.js';
import type { BwActivity, BwMedia, BwMessage } from './types.js';
import type { RingLogger } from '@/lib/log.js';
import { log as defaultLog } from '@/lib/log.js';

const SCHOOL_BASE = 'https://schools.mybrightwheel.com/api/v1/schools';

export interface StaffMember {
  objectId: string;
  firstName?: string;
  lastName?: string;
  displayName: string;
  userType?: string;
  role?: string;
  email?: string;
  profilePhoto?: BwMedia;
  /**
   * Where the record was seen: 'probe' means we got it from the /staff or
   * /teachers endpoint; 'derived' means we saw them post a note/message.
   * A staff member seen in both sources gets 'probe' (fresher metadata).
   */
  source: 'probe' | 'derived';
  /** Which schools we've associated this staff member with. */
  schoolIds: string[];
  /** First time we saw this staff member posting to the guardian's feed. */
  firstSeenAt?: string;
  /** Most recent time we saw this staff member posting to the feed. */
  lastSeenAt?: string;
  /** Whatever else the probe returned that we didn't map. */
  raw?: Record<string, unknown>;
}

export interface StaffRoster {
  /** Keyed by staff object_id, deduped across schools. */
  members: Record<string, StaffMember>;
  /** Which school_ids we successfully probed via /staff or /teachers. */
  probedSchools: string[];
  /** Which school_ids returned 404 on both probe paths. */
  unreachableSchools: string[];
}

function displayNameFrom(first?: string | null, last?: string | null, fallbackId?: string): string {
  const joined = `${first ?? ''} ${last ?? ''}`.trim();
  if (joined) return joined;
  return fallbackId ? `Staff ${fallbackId.slice(0, 8)}…` : 'Unknown staff';
}

function upsertMember(
  roster: Record<string, StaffMember>,
  incoming: StaffMember,
): void {
  const prior = roster[incoming.objectId];
  if (!prior) {
    roster[incoming.objectId] = incoming;
    return;
  }
  // Probe wins over derived; otherwise fill in missing fields.
  const winner = incoming.source === 'probe' ? incoming : prior;
  const loser = winner === incoming ? prior : incoming;
  const merged: StaffMember = { ...loser, ...winner };
  // Merge schoolIds + first/last seen — keep the widest data on both.
  const schools = new Set<string>([...prior.schoolIds, ...incoming.schoolIds]);
  merged.schoolIds = Array.from(schools);
  const firsts = [prior.firstSeenAt, incoming.firstSeenAt].filter(Boolean) as string[];
  const lasts = [prior.lastSeenAt, incoming.lastSeenAt].filter(Boolean) as string[];
  if (firsts.length > 0) merged.firstSeenAt = firsts.sort()[0];
  if (lasts.length > 0) merged.lastSeenAt = lasts.sort().reverse()[0];
  roster[incoming.objectId] = merged;
}

/**
 * Build the derived roster from activities + messages we've already fetched.
 * `actor` on activities and `sender` on messages give us every teacher who
 * touched the guardian's feed. Silent staff (never posted) are missed here;
 * the /staff probe covers those.
 *
 * `activitySchoolId` is used when the activity carries a room.school_id but
 * we want to attribute the actor's teachings to a specific facility.
 */
export function deriveStaffFromActivities(
  activities: Iterable<BwActivity>,
  messages: Iterable<BwMessage>,
  studentToSchool: Map<string, string>,
): Record<string, StaffMember> {
  const out: Record<string, StaffMember> = {};
  for (const a of activities) {
    const actor = a.actor;
    if (!actor?.object_id) continue;
    const activityRoom = (a as unknown as { room?: { school_id?: string } }).room;
    const schoolId =
      activityRoom?.school_id ??
      studentToSchool.get(a.target?.object_id ?? '');
    const when = a.event_date ?? a.created_at;
    const member: StaffMember = {
      objectId: actor.object_id,
      firstName: actor.first_name ?? undefined,
      lastName: actor.last_name ?? undefined,
      displayName: displayNameFrom(actor.first_name, actor.last_name, actor.object_id),
      userType: actor.user_type,
      email: actor.email ?? undefined,
      profilePhoto: actor.profile_photo ?? undefined,
      source: 'derived',
      schoolIds: schoolId ? [schoolId] : [],
      firstSeenAt: when,
      lastSeenAt: when,
    };
    upsertMember(out, member);
  }
  for (const m of messages) {
    const sender = m.sender;
    if (!sender?.object_id) continue;
    const when = m.created_at;
    const member: StaffMember = {
      objectId: sender.object_id,
      firstName: sender.first_name ?? undefined,
      lastName: sender.last_name ?? undefined,
      displayName: displayNameFrom(sender.first_name, sender.last_name, sender.object_id),
      userType: sender.user_type,
      email: sender.email ?? undefined,
      profilePhoto: sender.profile_photo ?? undefined,
      source: 'derived',
      schoolIds: [],
      firstSeenAt: when,
      lastSeenAt: when,
    };
    upsertMember(out, member);
  }
  return out;
}

interface RawStaffRow {
  object_id?: string;
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  user_type?: string;
  role?: string;
  title?: string;
  profile_photo?: BwMedia | null;
  [k: string]: unknown;
}

interface RawStaffResponse {
  staff?: RawStaffRow[];
  teachers?: RawStaffRow[];
  results?: RawStaffRow[];
  users?: RawStaffRow[];
  count?: number;
}

function normalizeStaff(row: RawStaffRow, schoolId: string): StaffMember | null {
  const id = row.object_id ?? row.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return {
    objectId: id,
    firstName: row.first_name ?? undefined,
    lastName: row.last_name ?? undefined,
    displayName: displayNameFrom(row.first_name, row.last_name, id),
    userType: row.user_type,
    role: row.role ?? row.title,
    email: row.email ?? undefined,
    profilePhoto: row.profile_photo ?? undefined,
    source: 'probe',
    schoolIds: [schoolId],
    raw: row as unknown as Record<string, unknown>,
  };
}

async function tryProbe(
  client: BwClient,
  url: string,
  schoolId: string,
  logger: RingLogger,
): Promise<StaffMember[] | undefined> {
  try {
    const data = await client.getJson<RawStaffResponse>(url);
    const rows = data.staff ?? data.teachers ?? data.results ?? data.users ?? [];
    if (!Array.isArray(rows)) {
      logger.warn(`staff: ${url} returned unexpected envelope (no staff/teachers/results); skipping`);
      return undefined;
    }
    const out: StaffMember[] = [];
    for (const row of rows) {
      const m = normalizeStaff(row, schoolId);
      if (m) out.push(m);
    }
    return out;
  } catch (err) {
    // Metadata probes never kill the export; every error class degrades to
    // "no probe data, use derived only".
    const name = (err as { name?: string })?.name;
    if (err instanceof BwNotFoundError) return undefined;
    if (name === 'BwAuthError') {
      logger.warn(`staff: ${url} returned 401/403 — guardian likely lacks read access; skipping`);
    } else {
      logger.warn(`staff: ${url} failed: ${(err as Error).message}`);
    }
    return undefined;
  }
}

/**
 * Fetch the staff roster for a single school. Tries /staff first, then
 * /teachers. Returns the list of members OR undefined if both probe paths
 * 404 (caller marks the school as "unreachable via probe" and falls back
 * to derived data).
 */
export async function fetchSchoolStaff(
  client: BwClient,
  schoolId: string,
  logger: RingLogger = defaultLog,
): Promise<StaffMember[] | undefined> {
  if (!schoolId) return undefined;
  const first = await tryProbe(client, `${SCHOOL_BASE}/${schoolId}/staff`, schoolId, logger);
  if (first !== undefined) return first;
  const second = await tryProbe(client, `${SCHOOL_BASE}/${schoolId}/teachers`, schoolId, logger);
  if (second !== undefined) return second;
  logger.warn(
    `staff: both /schools/${schoolId.slice(0, 8)}…/staff and /teachers returned 404 — falling back to derived (activity actors only)`,
  );
  return undefined;
}

/**
 * Build the full staff roster for the guardian:
 *   - probe each school in parallel
 *   - derive from activities + messages
 *   - merge, probe wins over derived where both agree
 *
 * Never throws for a 404 — a school that doesn't expose a staff endpoint
 * still ends up with derived members. BwAuthError propagates so the
 * takeout page can prompt re-login.
 */
export async function fetchStaffRoster(
  client: BwClient,
  schoolIds: string[],
  notes: BwActivity[],
  photos: BwActivity[],
  messages: BwMessage[],
  studentToSchool: Map<string, string>,
  logger: RingLogger = defaultLog,
): Promise<StaffRoster> {
  const roster: Record<string, StaffMember> = {};
  const probedSchools: string[] = [];
  const unreachableSchools: string[] = [];
  const uniqueIds = Array.from(new Set(schoolIds)).filter((s) => s && s.length > 0);
  for (const sid of uniqueIds) {
    const probed = await fetchSchoolStaff(client, sid, logger);
    if (probed !== undefined) {
      probedSchools.push(sid);
      for (const m of probed) upsertMember(roster, m);
    } else {
      unreachableSchools.push(sid);
    }
  }
  const derived = deriveStaffFromActivities(
    (function* () {
      yield* notes;
      yield* photos;
    })(),
    messages,
    studentToSchool,
  );
  for (const m of Object.values(derived)) upsertMember(roster, m);
  return { members: roster, probedSchools, unreachableSchools };
}
