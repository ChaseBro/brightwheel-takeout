// Orchestrator for the "richer context" metadata: school, student profile,
// staff roster. Runs in the run.ts pipeline AFTER notes are fetched (so we
// have activities to derive room/school/staff from) and BEFORE the manifest
// + viewer are emitted (so both can render the enriched data).
//
// Everything here is best-effort. A single fetch failure logs a warning
// and returns whatever was derivable — nothing here can block the export.
// Session expiry (BwAuthError) is the one exception: it propagates so the
// takeout page can prompt re-login.

import type { BwClient } from './bw-client.js';
import type { BwActivity, BwMessage } from './types.js';
import type { RingLogger } from '@/lib/log.js';
import { log as defaultLog } from '@/lib/log.js';
import { fetchAllSchools, schoolIdsFromActivities, type SchoolInfo } from './school.js';
import { fetchStudentProfiles, type StudentProfile } from './student-profile.js';
import { fetchStaffRoster, type StaffRoster } from './staff.js';

export interface Metadata {
  /** Per-school info keyed by school_id. Empty object when the probe failed. */
  schools: Record<string, SchoolInfo>;
  /** Per-student rich profile keyed by student_id. */
  studentProfiles: Record<string, StudentProfile>;
  /** Full staff roster (probed + derived). */
  staff: StaffRoster;
  /** studentId → primary schoolId (used by staff.derive to attribute members). */
  studentToSchool: Record<string, string>;
}

export interface CollectMetadataOptions {
  logger?: RingLogger;
  /** Skip endpoint probes entirely (derive-only). Used by tests / dev builds. */
  skipProbes?: boolean;
}

/**
 * Collect all four metadata sections. Callers pass in the notes + photos +
 * messages that have already been fetched so we can derive rich info without
 * an extra roundtrip.
 *
 * Returns an EMPTY metadata skeleton on catastrophic failure rather than
 * throwing — the export must always complete.
 */
export async function collectMetadata(
  client: BwClient,
  session: { guardianId: string; studentIds: string[]; studentNames?: Record<string, string> },
  data: {
    notes: BwActivity[];
    photos: BwActivity[];
    messages: BwMessage[];
  },
  opts: CollectMetadataOptions = {},
): Promise<Metadata> {
  const logger = opts.logger ?? defaultLog;
  const skipProbes = opts.skipProbes ?? false;

  // 1) Group activities per student so profile-derivation gets what it needs.
  const perStudent = new Map<string, BwActivity[]>();
  for (const sid of session.studentIds) perStudent.set(sid, []);
  for (const a of data.notes) {
    const sid = a.target?.object_id;
    if (sid && perStudent.has(sid)) perStudent.get(sid)!.push(a);
  }
  for (const a of data.photos) {
    const sid = a.target?.object_id;
    if (sid && perStudent.has(sid)) perStudent.get(sid)!.push(a);
  }

  // 2) Student profiles — derive per-student, then probe (best-effort).
  let studentProfiles: Record<string, StudentProfile> = {};
  try {
    studentProfiles = await fetchStudentProfiles(
      client,
      session.studentIds.map((sid) => ({
        studentId: sid,
        displayName: session.studentNames?.[sid],
      })),
      perStudent,
      { logger, skipProbe: skipProbes },
    );
  } catch (err) {
    // Only re-thrown case is BwAuthError; anything else the module already
    // swallowed internally.
    if ((err as Error).name === 'BwAuthError') throw err;
    logger.warn(`metadata: student-profile step failed: ${(err as Error).message}`);
  }

  // 3) School(s) — discover school_ids from the activities we already have,
  //    then probe each in sequence.
  const schoolIds = new Set<string>();
  for (const p of Object.values(studentProfiles)) {
    if (p.primarySchoolId) schoolIds.add(p.primarySchoolId);
  }
  for (const id of schoolIdsFromActivities([...data.notes, ...data.photos])) {
    schoolIds.add(id);
  }
  let schools: Record<string, SchoolInfo> = {};
  if (!skipProbes) {
    try {
      schools = await fetchAllSchools(client, schoolIds, logger);
    } catch (err) {
      if ((err as Error).name === 'BwAuthError') throw err;
      logger.warn(`metadata: schools step failed: ${(err as Error).message}`);
    }
  }
  // If a school probe returned nothing, seed a minimal SchoolInfo so the
  // viewer can at least render the id (rare — most guardians will have a
  // known school even without a probe endpoint).
  for (const id of schoolIds) {
    if (!schools[id]) schools[id] = { schoolId: id };
  }

  // 4) studentToSchool map for staff derivation.
  const studentToSchool: Record<string, string> = {};
  for (const [sid, p] of Object.entries(studentProfiles)) {
    if (p.primarySchoolId) studentToSchool[sid] = p.primarySchoolId;
  }

  // 5) Staff — probe /schools/{id}/staff, always merge with derived actors.
  //    Skip probes → use ONLY derived (activity actors + message senders).
  let staff: StaffRoster = { members: {}, probedSchools: [], unreachableSchools: [] };
  try {
    staff = await fetchStaffRoster(
      client,
      skipProbes ? [] : Array.from(schoolIds),
      data.notes,
      data.photos,
      data.messages,
      new Map(Object.entries(studentToSchool)),
      logger,
    );
  } catch (err) {
    if ((err as Error).name === 'BwAuthError') throw err;
    logger.warn(`metadata: staff step failed: ${(err as Error).message}`);
  }

  return { schools, studentProfiles, staff, studentToSchool };
}

/**
 * A compact, JSON-friendly view of the metadata for the manifest. Keeps
 * the same shape whether or not the probes succeeded so downstream
 * consumers (viewer, takeout page) can always index the same keys.
 */
export interface ManifestMetadata {
  schools: Record<string, Omit<SchoolInfo, 'raw'>>;
  student_profiles: Record<string, Omit<StudentProfile, 'raw'>>;
  staff: Record<string, unknown>;
}

/**
 * Strip the `raw` payload before writing to the manifest / viewer — those
 * are large blobs meant for debug capture, not for user-facing archives.
 */
export function toManifestSection(meta: Metadata): ManifestMetadata {
  const schools: Record<string, Omit<SchoolInfo, 'raw'>> = {};
  for (const [id, s] of Object.entries(meta.schools)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { raw, ...rest } = s;
    schools[id] = rest;
  }
  const student_profiles: Record<string, Omit<StudentProfile, 'raw'>> = {};
  for (const [id, p] of Object.entries(meta.studentProfiles)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { raw, ...rest } = p;
    student_profiles[id] = rest;
  }
  const staff: Record<string, unknown> = {};
  for (const [id, m] of Object.entries(meta.staff.members)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { raw, ...rest } = m;
    staff[id] = rest;
  }
  return { schools, student_profiles, staff };
}
