// Discovery: full student roster + message thread IDs.
//
// The content script gives us a guardian id from the URL (and maybe a single
// student id, if the parent happens to be on a /students/<id>/… page). That's
// not enough — we need EVERY student the signed-in guardian has, and EVERY
// message thread they can see, otherwise `messages.json` is empty and any
// sibling gets silently skipped.
//
// Endpoints (matching the shape download_notes.py uses):
//   GET /api/v1/guardians/current
//     → { object_id, first_name, last_name, students: [{ object_id, first_name, last_name, … }, …], … }
//     TODO: verify against real BW. `download_notes.py` doesn't hit this
//     endpoint directly, but the extension needs SOMETHING to enumerate
//     students without asking the parent to open each student page. The
//     shape above is what the Brightwheel guardian web app appears to consume
//     internally. If the real endpoint differs, only this file needs updating.
//
//   GET /api/v2/guardians/{guardian_id}/message_threads
//     → { threads: [{ object_id, … }, …] } OR { results: [{ object_id | thread_id, … }, …] }
//     TODO: verify against real BW. `download_notes.py` accepts a hardcoded
//     thread_id from .secrets.json; the messages endpoint we know for sure
//     is /api/v2/guardians/{gid}/message_threads/{tid}/messages, so the
//     listing endpoint is very likely the parent path. Both envelopes are
//     accepted below so the code doesn't break on either shape.

import type { BwClient } from './bw-client.js';
import { BwNotFoundError, BwAuthError } from './bw-client.js';
import type { RingLogger } from '@/lib/log.js';
import { log as defaultLog } from '@/lib/log.js';
import { PACING } from './pacing.js';

/**
 * Thrown by discoverRoster when a non-auth, non-notfound error (5xx,
 * network) knocks out one of the discovery calls. The caller (enrichSession)
 * catches this, stashes the reason on `session.discoveryWarning`, and the
 * takeout page renders a banner so the user knows the export scope may
 * silently exclude students or threads.
 */
export class DiscoveryPartialError extends Error {
  readonly name = 'DiscoveryPartialError';
  /** Which discovery step failed. Used for user-facing wording. */
  readonly step: 'roster' | 'threads' | 'users-me';
  /** The underlying error message (verbatim). */
  readonly detail: string;
  constructor(step: 'roster' | 'threads' | 'users-me', detail: string) {
    super(`discovery partial: ${step} failed: ${detail}`);
    this.step = step;
    this.detail = detail;
  }
}

export interface DiscoveredStudent {
  studentId: string;
  displayName: string;
}

export interface DiscoveredRoster {
  guardianId?: string;
  students: DiscoveredStudent[];
  threadIds: string[];
  /** Field-level source flags so callers can label anything best-effort. */
  studentsSource: 'guardians/current' | 'fallback' | 'unknown';
  threadsSource: 'message_threads' | 'fallback' | 'unknown';
  /**
   * Non-fatal partial-discovery warnings (M4). Populated when one of the
   * discovery calls threw a non-404, non-401 error (5xx / network) and
   * degraded to an empty list. The caller (enrichSession) surfaces this
   * on the takeout page so parents know the export scope may be
   * incomplete rather than genuinely empty.
   */
  warnings?: Array<{ step: 'roster' | 'threads' | 'users-me'; detail: string }>;
}

interface UsersMeResponse {
  object_id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  [k: string]: unknown;
}

/**
 * The /guardians/{id}/students envelope. Each row is a guardian↔student
 * relationship record with the actual student nested under `.student`.
 */
interface GuardianStudentsResponse {
  count?: number;
  students?: Array<{
    relationship_type?: string;
    guardian_id?: string;
    student?: Record<string, unknown>;
    [k: string]: unknown;
  }>;
}

interface MessageThreadsResponse {
  threads?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
  message_threads?: Array<Record<string, unknown>>;
  has_more?: boolean;
  count?: number;
  [k: string]: unknown;
}

function readId(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function displayNameFrom(row: Record<string, unknown>): string {
  const first = typeof row['first_name'] === 'string' ? row['first_name'] : '';
  const last = typeof row['last_name'] === 'string' ? row['last_name'] : '';
  const joined = `${first} ${last}`.trim();
  if (joined) return joined;
  const nick = typeof row['nickname'] === 'string' ? row['nickname'] : '';
  if (nick) return nick;
  const id = readId(row, ['object_id', 'id']) ?? '';
  return id ? `Student ${id.slice(0, 8)}…` : 'Unknown student';
}

/**
 * Fetch the guardian id + full student roster.
 *
 *   1. GET /api/v1/users/me → {object_id, first_name, ...}. The user's
 *      object_id is the guardian_id used in subsequent URLs.
 *   2. GET /api/v1/guardians/{object_id}/students → {count, students:[
 *        {relationship_type, guardian_id, student:{object_id, first_name, ...}}
 *      ]}. Each row wraps the actual student under `.student`.
 *
 * Returns undefined only if /users/me itself is unreachable (caller falls
 * back to content-script hints). 401 is re-thrown so the takeout page can
 * prompt for re-login.
 */
export async function fetchGuardianCurrent(
  client: BwClient,
  logger: RingLogger = defaultLog,
  warnings?: Array<{ step: 'roster' | 'threads' | 'users-me'; detail: string }>,
  opts: { sleep?: (ms: number) => Promise<void>; delayMs?: number } = {},
): Promise<{ guardianId?: string; students: DiscoveredStudent[] } | undefined> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delayMs = opts.delayMs ?? PACING.jsonDelayMs;
  // Step 1: who am I?
  let userId: string | undefined;
  try {
    const me = await client.getJson<UsersMeResponse>(
      'https://schools.mybrightwheel.com/api/v1/users/me',
    );
    userId = readId(me, ['object_id']);
  } catch (err) {
    if (err instanceof BwAuthError) throw err;
    if (err instanceof BwNotFoundError) {
      logger.warn('discovery: /users/me not found — falling back to content-script hints');
      return undefined;
    }
    // M4: this is a "silent empty" fallback — record the reason so the
    // caller can surface it as a partial-discovery warning.
    const detail = (err as Error).message;
    logger.warn(`discovery: /users/me failed: ${detail}`);
    warnings?.push({ step: 'users-me', detail });
    return undefined;
  }
  if (!userId) {
    logger.warn('discovery: /users/me returned no object_id');
    return undefined;
  }

  // Feed userId back into the client so the very-next call carries
  // x-user-uuid. BW's guardian API tolerates its absence on /users/me
  // itself, but every subsequent guardian-scoped call expects it — waiting
  // until after discoverRoster returns means the first three requests all
  // go out without the header.
  client.updateUserUuid(userId);

  // Step 2: who are my kids?
  if (delayMs > 0) await sleep(delayMs);
  const rosterUrl = `https://schools.mybrightwheel.com/api/v1/guardians/${userId}/students`;
  try {
    const roster = await client.getJson<GuardianStudentsResponse>(rosterUrl);
    const rows = roster.students ?? [];
    const students: DiscoveredStudent[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      // Each row wraps the actual student — unwrap first.
      const stu = (row && typeof row === 'object' ? row.student : undefined) ?? row;
      if (!stu || typeof stu !== 'object') continue;
      const sid = readId(stu as Record<string, unknown>, ['object_id', 'id', 'student_id']);
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      students.push({
        studentId: sid,
        displayName: displayNameFrom(stu as Record<string, unknown>),
      });
    }
    return { guardianId: userId, students };
  } catch (err) {
    if (err instanceof BwAuthError) throw err;
    if (err instanceof BwNotFoundError) {
      logger.warn(`discovery: ${rosterUrl} not found`);
      return { guardianId: userId, students: [] };
    }
    const detail = (err as Error).message;
    logger.warn(`discovery: roster fetch failed: ${detail}`);
    warnings?.push({ step: 'roster', detail });
    return { guardianId: userId, students: [] };
  }
}

/**
 * Fetch all message thread IDs for the guardian. Best-effort: an empty array
 * means "no threads discovered" (which is what F2's default was), NOT an
 * error — parents with a brand-new school may genuinely have zero threads.
 */
export async function fetchMessageThreads(
  client: BwClient,
  guardianId: string,
  logger: RingLogger = defaultLog,
  warnings?: Array<{ step: 'roster' | 'threads' | 'users-me'; detail: string }>,
): Promise<string[]> {
  // Same reasoning as fetchGuardianCurrent: the caller may not have set
  // userUuid on the client yet (e.g. discoverRoster's very first call
  // before /users/me), so seed it here to guarantee the header ships.
  client.updateUserUuid(guardianId);
  const base = `https://schools.mybrightwheel.com/api/v2/guardians/${guardianId}/message_threads`;
  // M3: paginate. The threads-list endpoint's actual pagination shape
  // isn't documented in `download_notes.py`; we probe conservatively by
  // requesting page=0..N with page_size=1000, stopping when the row list
  // shrinks / repeats / an explicit has_more flag turns false. Falls
  // gracefully back to a single-page fetch if the server ignores `page`.
  const PAGE_SIZE = 1000;
  const HARD_PAGE_CAP = 100;
  const out: string[] = [];
  const seen = new Set<string>();
  try {
    for (let page = 0; page < HARD_PAGE_CAP; page++) {
      const url = page === 0
        ? `${base}?page_size=${PAGE_SIZE}`
        : `${base}?page_size=${PAGE_SIZE}&page=${page}`;
      const data = await client.getJson<MessageThreadsResponse>(url);
      const rows = data.threads ?? data.results ?? data.message_threads ?? [];
      let newInPage = 0;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        // The row has a distinct `object_id` and `thread_id`; empirically only
        // object_id resolves the /messages sub-resource. thread_id is a
        // reference that appears to belong to a different table.
        const tid = readId(row as Record<string, unknown>, [
          'object_id',
          'message_thread_id',
          'thread_id',
          'id',
        ]);
        if (!tid || seen.has(tid)) continue;
        seen.add(tid);
        out.push(tid);
        newInPage++;
      }
      // Stop when the server signals end-of-input in any of the shapes
      // we've seen. `has_more` is the canonical field; a short page or a
      // page of pure duplicates both indicate we've drained the list.
      if (rows.length < PAGE_SIZE) break;
      if (data.has_more === false) break;
      if (newInPage === 0) break;
    }
    return out;
  } catch (err) {
    if (err instanceof BwNotFoundError) {
      logger.warn('discovery: /message_threads not found — messages.json will be empty');
      return [];
    }
    if (err instanceof BwAuthError) throw err;
    const detail = (err as Error).message;
    logger.warn(`discovery: /message_threads failed: ${detail}`);
    warnings?.push({ step: 'threads', detail });
    return [];
  }
}

/**
 * One-shot roster discovery. Merges the content-script hints (guardianId,
 * partial studentIds) with the /guardians/current + /message_threads results.
 * Any student the content script surfaced but the API didn't is kept — the
 * content script's hint is trusted (it came from a live BW page).
 */
export async function discoverRoster(
  client: BwClient,
  hint: { guardianId?: string; studentIds?: string[] } = {},
  logger: RingLogger = defaultLog,
  opts: { sleep?: (ms: number) => Promise<void>; delayMs?: number } = {},
): Promise<DiscoveredRoster> {
  // M8: pace the three discovery calls (/users/me → /students → /message_threads)
  // by PACING.jsonDelayMs so a fresh popup open doesn't look bot-like from BW's
  // edge (three back-to-back calls in <100ms).
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delayMs = opts.delayMs ?? PACING.jsonDelayMs;
  const warnings: Array<{ step: 'roster' | 'threads' | 'users-me'; detail: string }> = [];
  const roster: DiscoveredRoster = {
    guardianId: hint.guardianId,
    students: [],
    threadIds: [],
    studentsSource: 'unknown',
    threadsSource: 'unknown',
  };

  const current = await fetchGuardianCurrent(client, logger, warnings, { sleep, delayMs });
  if (current) {
    if (current.guardianId) roster.guardianId = current.guardianId;
    if (current.students.length > 0) {
      roster.students = current.students.slice();
      roster.studentsSource = 'guardians/current';
    }
  }

  // Preserve any content-script hint student IDs the API didn't return.
  const known = new Set(roster.students.map((s) => s.studentId));
  for (const sid of hint.studentIds ?? []) {
    if (!sid || known.has(sid)) continue;
    known.add(sid);
    roster.students.push({ studentId: sid, displayName: `Student ${sid.slice(0, 8)}…` });
    if (roster.studentsSource === 'unknown') roster.studentsSource = 'fallback';
  }

  if (roster.guardianId) {
    if (delayMs > 0) await sleep(delayMs);
    const threads = await fetchMessageThreads(client, roster.guardianId, logger, warnings);
    if (threads.length > 0) {
      roster.threadIds = threads;
      roster.threadsSource = 'message_threads';
    }
  }

  if (warnings.length > 0) roster.warnings = warnings;
  return roster;
}
