// Message thread fetcher.
//
// GET /api/v2/guardians/{guardian_id}/message_threads/{thread_id}/messages?page_limit=N
// Envelope: { count, page_size, has_more, results: [{ message: {...} }, ...] }
//
// - Uses page_limit=1000 (matches Python script; single-page ceiling for the
//   typical LPC guardian). Logs a warning if `has_more:true`.
// - Unwraps the `{message: {...}}` envelope per row.
// - Sorts by created_at descending.

import type { BwClient } from './bw-client.js';
import type { BwMessage, BwMessagesResponse } from './types.js';
import type { RingLogger } from '@/lib/log.js';
import { log as defaultLog } from '@/lib/log.js';
import { PACING } from './pacing.js';

const BASE = 'https://schools.mybrightwheel.com/api/v2/guardians';

export interface FetchMessagesOptions {
  pageLimit?: number;
  logger?: RingLogger;
}

export interface FetchMessagesResult {
  messages: BwMessage[];
  reportedCount: number | undefined;
  hasMore: boolean;
}

function unwrap(row: { message?: BwMessage } | BwMessage): BwMessage | null {
  if (!row) return null;
  if ((row as { message?: BwMessage }).message) {
    return (row as { message: BwMessage }).message;
  }
  return row as BwMessage;
}

export async function fetchThreadMessages(
  client: BwClient,
  guardianId: string,
  threadId: string,
  opts: FetchMessagesOptions = {},
): Promise<FetchMessagesResult> {
  const pageLimit = opts.pageLimit ?? PACING.pageSize;
  const logger = opts.logger ?? defaultLog;
  const base = `${BASE}/${guardianId}/message_threads/${threadId}/messages?page_limit=${pageLimit}`;

  // M2: loop until has_more:false. The BW /messages endpoint doesn't ship
  // an explicit page-cursor field — the pagination shape appears to be
  // ?page_limit=N&page=M (empirically the same as /activities). If we
  // don't see has_more, page, or offset in the response, we treat page 0
  // as complete (see the comment on `hasMore` below).
  const seen = new Set<string>();
  const messages: BwMessage[] = [];
  let reportedCount: number | undefined;
  let hasMore = false;
  const HARD_PAGE_CAP = 500;
  let page = 0;
  let lastData: { has_more?: boolean } = {};
  for (; page < HARD_PAGE_CAP; page++) {
    const url = page === 0 ? base : `${base}&page=${page}`;
    const data = await client.getJson<BwMessagesResponse>(url);
    lastData = data;
    reportedCount = data.count ?? reportedCount;
    const raw = data.results ?? [];
    if (raw.length === 0) break;
    let newInPage = 0;
    for (const row of raw) {
      const m = unwrap(row);
      if (!m || typeof m.object_id !== 'string') continue;
      if (seen.has(m.object_id)) continue;
      seen.add(m.object_id);
      messages.push(m);
      newInPage++;
    }
    hasMore = data.has_more === true;
    // Stop conditions:
    //   - server explicitly says has_more:false (canonical)
    //   - page came back under the requested limit (heuristic — some BW
    //     endpoints omit has_more entirely)
    //   - page yielded zero new items (dedup barrier)
    if (data.has_more === false) break;
    if (raw.length < pageLimit) break;
    if (newInPage === 0) break;
  }
  if (page >= HARD_PAGE_CAP) {
    logger.warn(
      `messages: hit hard page cap (${HARD_PAGE_CAP}) on thread ${threadId.slice(0, 8)}… — server may be looping`,
    );
  }
  // "hasMore" reflects the last response's flag verbatim so callers can
  // still see when BW claimed there was more but our stop-heuristic broke
  // early — always false when we drained cleanly.
  hasMore = lastData.has_more === true && page >= HARD_PAGE_CAP;
  messages.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return { messages, reportedCount, hasMore };
}
