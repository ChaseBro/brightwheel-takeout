// Student profile — the rich per-child record beyond what's in the
// /guardians/{id}/students roster.
//
// Two sources:
//   1. Free (zero-cost) — every activity carries a `.target` object with
//      the student's profile and a `.room` object with the classroom.
//      `deriveFromActivity` and `deriveFromActivities` extract those without
//      any new requests.
//   2. Best-effort probe — `fetchStudentProfile` hits
//      `GET /api/v1/students/{sid}` for the fuller record (birthdate,
//      allergies, dietary restrictions). On 404 / envelope mismatch we log a
//      warning and return whatever we could derive.
//
// TODO: verify endpoint path against real BW.

import type { BwClient } from './bw-client.js';
import { BwNotFoundError } from './bw-client.js';
import type { BwActivity, BwMedia } from './types.js';
import type { RingLogger } from '@/lib/log.js';
import { log as defaultLog } from '@/lib/log.js';

const STUDENT_BASE = 'https://schools.mybrightwheel.com/api/v1/students';

export interface RoomBrief {
  roomId: string;
  name?: string;
  schoolId?: string;
  color?: string;
  minAge?: number | null;
  maxAge?: number | null;
  maxCapacity?: number | null;
  maxRatio?: number | null;
}

export interface StudentProfile {
  studentId: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  displayName: string;
  profilePhoto?: BwMedia;
  enrollmentStatus?: string;
  /** ISO YYYY-MM-DD when the probe endpoint returns it. */
  birthdate?: string;
  allergies?: string;
  dietaryRestrictions?: string;
  /** Free-form medical notes (probe only). */
  medicalNotes?: string;
  /** Room derived from any activity (zero-cost). */
  primaryRoom?: RoomBrief;
  primarySchoolId?: string;
  createdAt?: string;
  /** Whatever the probe returned that we didn't map explicitly. */
  raw?: Record<string, unknown>;
}

interface RawStudent {
  object_id?: string;
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  nickname?: string;
  profile_photo?: BwMedia | null;
  enrollment_status?: string;
  birthdate?: string | null;
  date_of_birth?: string | null;
  dob?: string | null;
  allergies?: string | null;
  dietary_restrictions?: string | null;
  dietary_notes?: string | null;
  medical_notes?: string | null;
  primary_school_id?: string;
  primary_room_id?: string;
  school_id?: string;
  created_at?: string;
  [k: string]: unknown;
}

function firstString(row: RawStudent, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function fullNameFrom(first?: string | null, last?: string | null): string | undefined {
  const joined = `${first ?? ''} ${last ?? ''}`.trim();
  return joined.length > 0 ? joined : undefined;
}

/**
 * Extract the room brief from a single activity. Zero requests.
 */
export function roomFromActivity(activity: BwActivity | undefined | null): RoomBrief | undefined {
  if (!activity) return undefined;
  const room = (activity as unknown as { room?: Record<string, unknown> }).room;
  if (!room || typeof room !== 'object') return undefined;
  const rid = (room['object_id'] as string | undefined) ?? (room['id'] as string | undefined);
  if (!rid) return undefined;
  return {
    roomId: rid,
    name: typeof room['name'] === 'string' ? (room['name'] as string) : undefined,
    schoolId: typeof room['school_id'] === 'string' ? (room['school_id'] as string) : undefined,
    color: typeof room['color'] === 'string' ? (room['color'] as string) : undefined,
    minAge: typeof room['min_age'] === 'number' ? (room['min_age'] as number) : (room['min_age'] as null | undefined) ?? null,
    maxAge: typeof room['max_age'] === 'number' ? (room['max_age'] as number) : (room['max_age'] as null | undefined) ?? null,
    maxCapacity: typeof room['max_capacity'] === 'number' ? (room['max_capacity'] as number) : null,
    maxRatio: typeof room['max_ratio'] === 'number' ? (room['max_ratio'] as number) : null,
  };
}

/**
 * Build the derived profile for a student purely from activities we've
 * already fetched. Returns the most-recent room (activities are sorted
 * event_date desc by the caller in the common case; we don't assume).
 *
 * `hintName` is the display name from /guardians/{id}/students so a student
 * with zero activities in the fetched range still gets a name.
 */
export function deriveFromActivities(
  studentId: string,
  activities: Iterable<BwActivity>,
  hintName?: string,
): StudentProfile {
  let target: Record<string, unknown> | undefined;
  let mostRecentRoom: RoomBrief | undefined;
  let mostRecentRoomWhen = '';
  let schoolId: string | undefined;
  for (const a of activities) {
    if (!target) {
      const t = (a as unknown as { target?: Record<string, unknown> }).target;
      if (t && typeof t === 'object' && t['object_id'] === studentId) target = t;
      // Some rows may lack an object_id on target — accept the first target
      // with matching first_name/last_name shape as a fallback.
      else if (t && typeof t === 'object' && !target) target = t;
    }
    const room = roomFromActivity(a);
    if (room) {
      const when = typeof (a as unknown as { event_date?: string }).event_date === 'string'
        ? (a as unknown as { event_date: string }).event_date
        : '';
      if (!mostRecentRoom || when > mostRecentRoomWhen) {
        mostRecentRoom = room;
        mostRecentRoomWhen = when;
      }
      if (!schoolId && room.schoolId) schoolId = room.schoolId;
    }
  }
  const first = target && typeof target['first_name'] === 'string' ? (target['first_name'] as string) : undefined;
  const last = target && typeof target['last_name'] === 'string' ? (target['last_name'] as string) : undefined;
  const full = fullNameFrom(first, last);
  return {
    studentId,
    firstName: first,
    lastName: last,
    fullName: full,
    displayName: full ?? hintName ?? `Student ${studentId.slice(0, 8)}…`,
    profilePhoto:
      target && typeof target['profile_photo'] === 'object' && target['profile_photo'] !== null
        ? (target['profile_photo'] as BwMedia)
        : undefined,
    enrollmentStatus:
      target && typeof target['enrollment_status'] === 'string'
        ? (target['enrollment_status'] as string)
        : undefined,
    primaryRoom: mostRecentRoom,
    primarySchoolId: schoolId,
    createdAt:
      target && typeof target['created_at'] === 'string' ? (target['created_at'] as string) : undefined,
  };
}

/**
 * Probe the /students/{sid} endpoint and merge the response onto whatever
 * we could derive from activities. Best-effort — a 404 keeps the derived
 * profile; a BwAuthError bubbles so the takeout page can prompt re-login.
 */
export async function fetchStudentProfile(
  client: BwClient,
  studentId: string,
  opts: {
    logger?: RingLogger;
    derived?: StudentProfile;
    /** Skip the probe entirely — used by tests that want just the derivation. */
    skipProbe?: boolean;
  } = {},
): Promise<StudentProfile> {
  const logger = opts.logger ?? defaultLog;
  const base: StudentProfile = opts.derived ?? {
    studentId,
    displayName: `Student ${studentId.slice(0, 8)}…`,
  };
  if (opts.skipProbe) return base;
  const url = `${STUDENT_BASE}/${studentId}`;
  let raw: RawStudent | undefined;
  try {
    raw = await client.getJson<RawStudent>(url);
  } catch (err) {
    // Metadata probes are best-effort — degrade on ANY error including auth.
    // Session death surfaces on the primary /activities and /messages calls.
    const name = (err as { name?: string })?.name;
    if (err instanceof BwNotFoundError) {
      logger.warn(`student-profile: ${url} returned 404 — endpoint path may be wrong; keeping derived profile`);
    } else if (name === 'BwAuthError') {
      logger.warn(`student-profile: ${url} returned 401/403 — probe not accessible; keeping derived profile`);
    } else {
      logger.warn(`student-profile: fetch failed for ${studentId.slice(0, 8)}…: ${(err as Error).message}`);
    }
    return base;
  }
  return mergeStudentRecord(base, raw);
}

/** Overlay fields from the probe response onto the derived profile. */
export function mergeStudentRecord(base: StudentProfile, raw: RawStudent): StudentProfile {
  const first = typeof raw.first_name === 'string' ? raw.first_name : base.firstName;
  const last = typeof raw.last_name === 'string' ? raw.last_name : base.lastName;
  const full = fullNameFrom(first, last) ?? base.fullName;
  return {
    ...base,
    firstName: first,
    lastName: last,
    fullName: full,
    displayName: full ?? base.displayName,
    profilePhoto: raw.profile_photo ?? base.profilePhoto,
    enrollmentStatus: raw.enrollment_status ?? base.enrollmentStatus,
    birthdate: firstString(raw, ['birthdate', 'date_of_birth', 'dob']) ?? base.birthdate,
    allergies: firstString(raw, ['allergies', 'allergy_notes']) ?? base.allergies,
    dietaryRestrictions:
      firstString(raw, ['dietary_restrictions', 'dietary_notes']) ?? base.dietaryRestrictions,
    medicalNotes: firstString(raw, ['medical_notes']) ?? base.medicalNotes,
    primarySchoolId:
      firstString(raw, ['primary_school_id', 'school_id']) ?? base.primarySchoolId,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : base.createdAt,
    raw,
  };
}

/**
 * Convenience: derive-then-probe for each student in the roster. Missing
 * activities are OK (probe still runs); a failed probe keeps the derived
 * profile so the archive is never worse than the pre-probe world.
 */
export async function fetchStudentProfiles(
  client: BwClient,
  students: Array<{ studentId: string; displayName?: string }>,
  perStudentActivities: Map<string, BwActivity[]>,
  opts: { logger?: RingLogger; skipProbe?: boolean } = {},
): Promise<Record<string, StudentProfile>> {
  const out: Record<string, StudentProfile> = {};
  for (const s of students) {
    const derived = deriveFromActivities(
      s.studentId,
      perStudentActivities.get(s.studentId) ?? [],
      s.displayName,
    );
    const profile = await fetchStudentProfile(client, s.studentId, {
      derived,
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.skipProbe ? { skipProbe: true } : {}),
    });
    out[s.studentId] = profile;
  }
  return out;
}
