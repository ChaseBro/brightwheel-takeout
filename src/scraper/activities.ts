// Paginated activities fetcher.
//
// GET /api/v1/students/{student_id}/activities?action_type=ac_note|ac_photo|...
// Envelope: { count, offset, page, page_size, activities[] }
//
// - Uses page_size=1000 by default (small sizes return misleading counts,
//   see the note in Brightwheel.md).
// - Dedupes by object_id across pages (real API occasionally returns the
//   same activity on two pages; the Python script does the same).
// - Sorts final list by event_date descending.
// - Emits a generator so a consumer (run.ts) can stream progress without
//   waiting for the whole list to arrive.

import type { BwClient } from './bw-client.js';
import type { BwActivitiesResponse, BwActivity } from './types.js';
import { PACING } from './pacing.js';

const BASE = 'https://schools.mybrightwheel.com/api/v1/students';
const DEFAULT_START = '2018-01-01T00:00:00.000Z'; // well before Brightwheel's youngest cohort

export interface FetchActivitiesOptions {
  actionType: 'ac_note' | 'ac_photo' | 'ac_video' | string;
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** If provided, invoked once per page after the response arrives. */
  onPage?: (info: { page: number; batchSize: number; totalSoFar: number; count?: number }) => void;
}

function buildUrl(studentId: string, opts: FetchActivitiesOptions, page: number): string {
  const pageSize = opts.pageSize ?? PACING.pageSize;
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    start_date: opts.startDate ?? DEFAULT_START,
    end_date: opts.endDate ?? new Date().toISOString(),
    action_type: opts.actionType,
    include_parent_actions: 'true',
  });
  return `${BASE}/${studentId}/activities?${params.toString()}`;
}

/**
 * Async generator that yields activities one at a time, paging under the hood.
 * Callers can `for await` and update UI incrementally.
 */
export async function* iterateActivities(
  client: BwClient,
  studentId: string,
  opts: FetchActivitiesOptions,
): AsyncGenerator<BwActivity, void, void> {
  const seen = new Set<string>();
  const pageSize = opts.pageSize ?? PACING.pageSize;
  const delay = opts.delayMs ?? PACING.jsonDelayMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let page = 0;
  let totalSoFar = 0;
  // Guardrail: paginated APIs occasionally loop; cap at a very generous ceiling.
  const HARD_PAGE_CAP = 500;
  while (page < HARD_PAGE_CAP) {
    const url = buildUrl(studentId, opts, page);
    const resp = await client.getJson<BwActivitiesResponse>(url);
    const batch = resp.activities ?? [];
    let newInBatch = 0;
    for (const act of batch) {
      if (!act || !act.object_id) continue;
      if (seen.has(act.object_id)) continue;
      seen.add(act.object_id);
      newInBatch++;
      totalSoFar++;
      yield act;
    }
    opts.onPage?.({ page, batchSize: batch.length, totalSoFar, count: resp.count });
    if (batch.length < pageSize || batch.length === 0) return;
    // If a full page yielded zero new items we're stuck in a loop; bail.
    if (newInBatch === 0) return;
    page++;
    if (delay > 0) await sleep(delay);
  }
}

/**
 * Convenience: collect all activities into a sorted array (event_date desc).
 * This is the shape most callers want; keeps the streaming generator too.
 */
export async function fetchAllActivities(
  client: BwClient,
  studentId: string,
  opts: FetchActivitiesOptions,
): Promise<BwActivity[]> {
  const out: BwActivity[] = [];
  for await (const act of iterateActivities(client, studentId, opts)) out.push(act);
  out.sort((a, b) => (b.event_date || '').localeCompare(a.event_date || ''));
  return out;
}
