// Scope preview — a fast pre-flight peek that tells the user how big the
// export is *before* they hit Start. Fires ~1 tiny request per (student x
// kind) + 1 per message thread, each with page_size=1 so the server returns
// just the `count` and we ignore the single-row payload.
//
// Costs: for a two-student, three-thread account that's 2*2 + 3 = 7 HTTP
// calls, sub-second wall-clock. Cheap.

import type { BwClient } from './bw-client.js';
import type { Session } from './types.js';

export interface StudentScope {
  studentId: string;
  studentName?: string;
  photos: number;
  notes: number;
}

export interface ThreadScope {
  threadId: string;
  messages: number;
}

export interface ScopePreview {
  perStudent: StudentScope[];
  threads: ThreadScope[];
  totalPhotos: number;
  totalNotes: number;
  totalMessages: number;
  /** Rough estimate — see `estimateBytes`/`estimateMs`. */
  estimatedBytes: number;
  estimatedMs: number;
  /** Timestamp so the takeout page can decide when to re-preview. */
  computedAt: number;
}

// Empirical average from a real 2-year LPC account: ~350 KB per cover-variant
// JPEG. Notes/messages are negligible next to photos.
const AVG_PHOTO_BYTES = 350 * 1024;
const AVG_NOTE_BYTES = 800;       // note body + media metadata as CSV row
const AVG_MESSAGE_BYTES = 500;    // typical message JSON

// Download-time estimate: photos at concurrency=3 with ~500ms mean per photo,
// plus JSON pacing budget for the pages we'll fetch.
const MEAN_PHOTO_MS = 500;
const PHOTO_CONCURRENCY = 3;
const MEAN_JSON_MS = 400; // includes pacing delay + server latency

interface CountEnvelope {
  count?: number;
}

async function peekActivitiesCount(
  client: BwClient,
  studentId: string,
  actionType: 'ac_photo' | 'ac_note',
): Promise<number> {
  const url =
    `https://schools.mybrightwheel.com/api/v1/students/${studentId}/activities` +
    `?action_type=${actionType}&page=0&page_size=1&include_parent_actions=true`;
  try {
    const data = await client.getJson<CountEnvelope>(url);
    return typeof data.count === 'number' ? data.count : 0;
  } catch {
    return 0; // preview is best-effort; a failed peek shouldn't block Start
  }
}

async function peekThreadCount(
  client: BwClient,
  guardianId: string,
  threadId: string,
): Promise<number> {
  const url =
    `https://schools.mybrightwheel.com/api/v2/guardians/${guardianId}` +
    `/message_threads/${threadId}/messages?page_limit=1`;
  try {
    const data = await client.getJson<CountEnvelope>(url);
    return typeof data.count === 'number' ? data.count : 0;
  } catch {
    return 0;
  }
}

export function estimateBytes(
  photos: number,
  notes: number,
  messages: number,
): number {
  return photos * AVG_PHOTO_BYTES + notes * AVG_NOTE_BYTES + messages * AVG_MESSAGE_BYTES;
}

export function estimateMs(
  photos: number,
  notes: number,
  messages: number,
): number {
  const photoMs = Math.ceil(photos / PHOTO_CONCURRENCY) * MEAN_PHOTO_MS;
  // rough page count: 1000 items per page for activities, 1000 per page for messages
  const activityPages = Math.max(1, Math.ceil((photos + notes) / 1000));
  const messagePages = Math.max(1, Math.ceil(messages / 1000));
  const jsonMs = (activityPages + messagePages) * MEAN_JSON_MS;
  return photoMs + jsonMs;
}

/**
 * Peek at each student's photo + note counts and each thread's message count.
 * Runs the peeks concurrently (single-digit total) so wall-clock stays sub-1s.
 * Returns `undefined` if the session is unusable for a preview.
 */
export async function previewScope(
  client: BwClient,
  session: Pick<Session, 'guardianId' | 'studentIds' | 'threadIds'> & {
    studentNames?: Record<string, string>;
  },
  now: () => number = () => Date.now(),
): Promise<ScopePreview> {
  const studentPeeks = session.studentIds.map(async (sid) => {
    const [photos, notes] = await Promise.all([
      peekActivitiesCount(client, sid, 'ac_photo'),
      peekActivitiesCount(client, sid, 'ac_note'),
    ]);
    return {
      studentId: sid,
      studentName: session.studentNames?.[sid],
      photos,
      notes,
    } satisfies StudentScope;
  });

  const threadPeeks = (session.threadIds ?? []).map(async (tid) => ({
    threadId: tid,
    messages: await peekThreadCount(client, session.guardianId, tid),
  }));

  const [perStudent, threads] = await Promise.all([
    Promise.all(studentPeeks),
    Promise.all(threadPeeks),
  ]);

  const totalPhotos = perStudent.reduce((s, x) => s + x.photos, 0);
  const totalNotes = perStudent.reduce((s, x) => s + x.notes, 0);
  const totalMessages = threads.reduce((s, x) => s + x.messages, 0);

  return {
    perStudent,
    threads,
    totalPhotos,
    totalNotes,
    totalMessages,
    estimatedBytes: estimateBytes(totalPhotos, totalNotes, totalMessages),
    estimatedMs: estimateMs(totalPhotos, totalNotes, totalMessages),
    computedAt: now(),
  };
}

/** Humanize bytes for the UI ("1.2 GB" not "1200000000"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Humanize ms into "~18 min" / "~2 hr 15 min" for the UI. */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60000));
  if (totalMin < 60) return `~${totalMin} min`;
  const hr = Math.floor(totalMin / 60);
  const rem = totalMin % 60;
  return rem > 0 ? `~${hr} hr ${rem} min` : `~${hr} hr`;
}
