// Additional activity kinds — the "daily reports" a parent sees in-app.
//
// The /activities endpoint we already exercise for ac_note and ac_photo
// accepts many action_type values. This module reuses `iterateActivities`
// for each additional kind, so pagination, dedupe, and pacing are
// unchanged.
//
// Enabled by an OPT-IN checkbox in the takeout page: "Include daily reports
// (health, food, naps, potty, incidents)". Default OFF — a 2-year account
// could easily hit 5000+ additional rows, so the parent should choose
// whether that goes into the archive.
//
// TODO: verify these action_types actually resolve for guardians. Some may
// be teacher-only. Each probe that returns empty logs a WARN line — a real
// run's diagnostic log will tell us which ones are worth keeping.

import { BwAuthError, type BwClient } from './bw-client.js';
import type { BwActivity } from './types.js';
import { iterateActivities } from './activities.js';
import type { RingLogger } from '@/lib/log.js';
import { log as defaultLog } from '@/lib/log.js';

/**
 * The action types we treat as "daily reports" — the payloads a parent sees
 * on their daily report screen. Kept as a const array so the takeout-page
 * UI can render "Include: health, food, naps, potty, bathroom, incidents,
 * videos" in a stable order.
 *
 * `ac_video` is grouped here because it's opt-in on volume grounds, not
 * because it's structurally a daily-report kind — a family with a video
 * bulk-upload could produce a huge download.
 */
export const DAILY_REPORT_ACTION_TYPES = [
  'ac_health_check',
  'ac_food',
  'ac_nap',
  'ac_bathroom',
  'ac_potty',
  'ac_incident',
  'ac_medication',
  'ac_video',
] as const;

export type DailyReportKind = (typeof DAILY_REPORT_ACTION_TYPES)[number];

/** Human-facing label for each kind — used in file names and viewer badges. */
export const DAILY_REPORT_LABELS: Record<DailyReportKind, string> = {
  ac_health_check: 'health',
  ac_food: 'food',
  ac_nap: 'nap',
  ac_bathroom: 'bathroom',
  ac_potty: 'potty',
  ac_incident: 'incident',
  ac_medication: 'medication',
  ac_video: 'video',
};

export interface FetchAdditionalOptions {
  /** Which action_types to fetch (default = all in DAILY_REPORT_ACTION_TYPES). */
  kinds?: readonly DailyReportKind[];
  /** Optional server-side date range applied to /activities. */
  startDate?: string;
  endDate?: string;
  /** Per-page delay + sleep override — mostly for tests. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: RingLogger;
  /** Progress callback — invoked once per (kind, student) after fetch. */
  onKindComplete?: (info: {
    kind: DailyReportKind;
    studentId: string;
    fetched: number;
  }) => void;
  /**
   * Cooperative cancel. The caller (run.ts) polls between yields so the
   * user's Stop button unwinds cleanly.
   */
  signal?: AbortSignal;
}

export interface AdditionalActivitiesResult {
  /** Every activity keyed by kind. */
  byKind: Record<DailyReportKind, BwActivity[]>;
  /** Which (kind, studentId) pairs returned zero rows — noise flag for the UI. */
  emptyProbes: Array<{ kind: DailyReportKind; studentId: string }>;
  /** Total count across all kinds. */
  totalCount: number;
}

function emptyByKind(): Record<DailyReportKind, BwActivity[]> {
  return {
    ac_health_check: [],
    ac_food: [],
    ac_nap: [],
    ac_bathroom: [],
    ac_potty: [],
    ac_incident: [],
    ac_medication: [],
    ac_video: [],
  };
}

/**
 * Fetch all requested activity kinds for the given students. Each probe is
 * best-effort — a 404 from `iterateActivities` shows up as a
 * `BwNotFoundError` and we swallow it (log-then-skip) rather than letting
 * one missing kind sink the whole export.
 *
 * Yields are collected into a byKind map; the caller (run.ts) then decides
 * whether to emit them as separate CSV files, a single "daily-reports.csv",
 * or into the viewer's timeline.
 */
export async function fetchAdditionalActivities(
  client: BwClient,
  studentIds: string[],
  opts: FetchAdditionalOptions = {},
): Promise<AdditionalActivitiesResult> {
  const kinds = opts.kinds ?? DAILY_REPORT_ACTION_TYPES;
  const logger = opts.logger ?? defaultLog;
  const byKind = emptyByKind();
  const emptyProbes: Array<{ kind: DailyReportKind; studentId: string }> = [];
  let totalCount = 0;

  for (const kind of kinds) {
    for (const sid of studentIds) {
      if (opts.signal?.aborted) return { byKind, emptyProbes, totalCount };
      let count = 0;
      try {
        for await (const a of iterateActivities(client, sid, {
          actionType: kind,
          ...(opts.startDate ? { startDate: opts.startDate } : {}),
          ...(opts.endDate ? { endDate: opts.endDate } : {}),
          ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
        })) {
          if (opts.signal?.aborted) return { byKind, emptyProbes, totalCount };
          byKind[kind].push(a);
          count++;
          totalCount++;
        }
      } catch (err) {
        // Never let one kind's failure stop the export EXCEPT a genuine
        // session expiry (401): some daily-report kinds are plausibly
        // teacher-only and will 403 by per-guardian policy on an
        // otherwise-healthy session (same shape as the school/staff probes
        // in metadata.ts) — that must stay best-effort. But a real 401
        // means the cookie is gone, so every remaining (kind, student) pair
        // would otherwise fail the same way and get logged as a misleading
        // wall of "not guardian-visible" warnings while the export
        // silently truncates. Propagate so the caller (run.ts) can stop and
        // prompt re-login, matching collectMetadata's contract for the
        // same failure mode.
        if (err instanceof BwAuthError && err.status === 401) throw err;
        // Log so a Layer-3 pass can see which action_types are guardian-visible.
        const name = (err as Error).name;
        if (name === 'BwNotFoundError') {
          logger.warn(`additional-activities: ${kind} for ${sid.slice(0, 8)}… returned 404 — kind may not exist for guardians`);
        } else if (name === 'BwAuthError') {
          logger.warn(`additional-activities: ${kind} for ${sid.slice(0, 8)}… returned 403 — kind likely not guardian-visible`);
        } else {
          logger.warn(`additional-activities: ${kind} for ${sid.slice(0, 8)}… failed: ${(err as Error).message}`);
        }
      }
      opts.onKindComplete?.({ kind, studentId: sid, fetched: count });
      if (count === 0) {
        emptyProbes.push({ kind, studentId: sid });
        // "Empty" is legitimately common — most families won't have every
        // kind populated. Log at debug-only level so the diagnostic log
        // doesn't get flooded during a clean run.
        logger.debug(`additional-activities: ${kind} for ${sid.slice(0, 8)}… returned zero rows`);
      }
    }
  }
  return { byKind, emptyProbes, totalCount };
}

/**
 * Flatten a byKind map into a chronological rows array — used by the viewer
 * and by the "one combined CSV" output format.
 */
export interface DailyReportRow {
  kind: DailyReportKind;
  kindLabel: string;
  date: string;
  time: string;
  studentId: string;
  studentName: string;
  author: string;
  /** Human-facing text summarizing the activity — pulled from note / details_blob / health_check. */
  summary: string;
  /** Raw source object_id so viewer can cross-link. */
  objectId: string;
}

/**
 * Best-effort text summary of a daily-report activity. Different kinds
 * carry their payload in different places (details_blob for food/nap,
 * health_check for health, note for everything else) — this centralizes
 * the "give me one line I can put in a table" logic in one place.
 */
export function summarizeDailyReport(activity: BwActivity, kind: DailyReportKind): string {
  const note = typeof activity.note === 'string' ? activity.note.trim() : '';
  if (note) return note;
  const details = (activity as unknown as { details_blob?: Record<string, unknown> }).details_blob;
  if (details && typeof details === 'object') {
    // details_blob shapes are kind-specific and undocumented. Just serialize
    // the non-empty scalar fields so nothing is lost.
    const parts: string[] = [];
    for (const [k, v] of Object.entries(details)) {
      if (v == null) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}: ${v}`);
      }
    }
    if (parts.length > 0) return parts.join('; ');
  }
  const health = (activity as unknown as { health_check?: unknown }).health_check;
  if (health && typeof health === 'object') return JSON.stringify(health);
  if (kind === 'ac_video') {
    const media = (activity as unknown as { media?: { image_url?: string } }).media;
    return media?.image_url ?? '';
  }
  return '';
}

export function flattenDailyReports(
  byKind: Record<DailyReportKind, BwActivity[]>,
  studentNameLookup: (studentId: string) => string,
): DailyReportRow[] {
  const rows: DailyReportRow[] = [];
  for (const [kind, list] of Object.entries(byKind) as Array<[DailyReportKind, BwActivity[]]>) {
    for (const a of list) {
      const sid = (a as unknown as { target?: { object_id?: string } }).target?.object_id ?? '';
      const iso = a.event_date ?? '';
      rows.push({
        kind,
        kindLabel: DAILY_REPORT_LABELS[kind],
        date: iso.slice(0, 10),
        time: iso.slice(11, 16),
        studentId: sid,
        studentName: studentNameLookup(sid),
        author: [a.actor?.first_name ?? '', a.actor?.last_name ?? '']
          .filter(Boolean)
          .join(' ')
          .trim(),
        summary: summarizeDailyReport(a, kind),
        objectId: a.object_id,
      });
    }
  }
  rows.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return rows;
}
