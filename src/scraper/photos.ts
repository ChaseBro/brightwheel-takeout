// Photo download queue.
//
// - Concurrency = PACING.photoConcurrency (default 3). CloudFront can take it
//   and the origin isn't touched at all — signed URLs bypass BW.
// - `best_url` = image_url || thumbnail_url (image_url is the ~1080px cover
//   variant; /original/ is signature-locked with 403).
// - On 403 (CloudFront signed URL expired), refetch the parent activity to
//   get a fresh URL and retry once.

import type { BwClient } from './bw-client.js';
import type { BwActivity, BwMedia, PhotoEntry } from './types.js';
import { PACING } from './pacing.js';
import { BwAuthError } from './bw-client.js';
import { fetchAllActivities } from './activities.js';

export function bestUrl(media: BwMedia | null | undefined): string | null {
  if (!media) return null;
  return media.image_url ?? media.thumbnail_url ?? null;
}

/**
 * Convert a photo activity into the download-plan record we use downstream.
 * Filename layout matches download_photos.py: `<yyyy-mm-dd>_<full_object_id>.<ext>`.
 */
export function planPhotoEntry(act: BwActivity): PhotoEntry | null {
  const url = bestUrl(act.media);
  if (!url) return null;
  const evPrefix = (act.event_date || '').slice(0, 10) || 'undated';
  const ext = extractExt(url) || '.jpg';
  // FULL object_id — photos uploaded in a single batch share a long prefix,
  // so a truncated slice collides (see download_photos.py:294).
  const filename = `${evPrefix}_${act.object_id}${ext}`;
  return {
    objectId: act.object_id,
    studentId: act.target?.object_id ?? '',
    eventDate: act.event_date,
    url,
    filename,
    note: act.note ?? null,
  };
}

function extractExt(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname;
    const dot = p.lastIndexOf('.');
    if (dot < 0) return '';
    const ext = p.slice(dot).toLowerCase();
    if (ext.length > 6) return '';
    return ext;
  } catch {
    return '';
  }
}

export interface DownloadOptions {
  /**
   * Called when a URL returned 403 and we need to refetch a fresh signed URL
   * for that specific object_id. If provided, returns the new URL or null if
   * the photo is truly gone.
   */
  refetchUrl?: (objectId: string) => Promise<string | null>;
}

export interface DownloadResult {
  entry: PhotoEntry;
  bytes: Uint8Array;
}

/**
 * Download a single photo. If the URL 403s (CloudFront signature expired)
 * and a `refetchUrl` is provided, refetch once and try again.
 */
export async function downloadPhoto(
  client: BwClient,
  entry: PhotoEntry,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  try {
    const buf = await client.getBytes(entry.url);
    return { entry, bytes: new Uint8Array(buf) };
  } catch (err) {
    if (err instanceof BwAuthError && err.status === 403 && opts.refetchUrl) {
      const fresh = await opts.refetchUrl(entry.objectId);
      if (fresh) {
        const buf = await client.getBytes(fresh);
        return { entry: { ...entry, url: fresh }, bytes: new Uint8Array(buf) };
      }
    }
    throw err;
  }
}

/**
 * Small concurrency-limited pool. Yields results as they complete (out of
 * order). Aborts on the first error unless `continueOnError` is set — in
 * that case, errors are yielded as `{ entry, error }`.
 */
export interface DownloadStreamResult {
  entry: PhotoEntry;
  bytes?: Uint8Array;
  error?: Error;
}

export async function* downloadPhotoStream(
  client: BwClient,
  entries: Iterable<PhotoEntry>,
  opts: DownloadOptions & { concurrency?: number; continueOnError?: boolean } = {},
): AsyncGenerator<DownloadStreamResult, void, void> {
  const concurrency = Math.max(1, opts.concurrency ?? PACING.photoConcurrency);
  const iterator = entries[Symbol.iterator]();
  let done = false;
  // Each in-flight entry carries the pool id in its resolved payload, so we
  // can delete the winning race entry after `yield` — not from a `.finally`
  // callback. The previous `.finally` variant cascaded eagerly when several
  // promises resolved in the same microtask flush (fast mock or cached
  // response): all 3 finally-deletes ran before Promise.race re-entered the
  // generator, leaving `inflight` empty and the outer loop exiting after
  // only 1 yielded result.
  type Slot = { id: number; result: DownloadStreamResult };
  const inflight = new Map<number, Promise<Slot>>();
  let seq = 0;

  const kick = (): boolean => {
    if (done) return false;
    const next = iterator.next();
    if (next.done) {
      done = true;
      return false;
    }
    const id = seq++;
    const entry = next.value;
    const p: Promise<Slot> = downloadPhoto(client, entry, opts)
      .then((r) => ({ id, result: { entry: r.entry, bytes: r.bytes } }))
      .catch((error: Error) => {
        if (!opts.continueOnError) throw error;
        return { id, result: { entry, error } };
      });
    inflight.set(id, p);
    return true;
  };

  while (kick() && inflight.size < concurrency) {
    /* fill */
  }
  while (inflight.size > 0) {
    const { id, result } = await Promise.race(inflight.values());
    inflight.delete(id);
    yield result;
    kick();
  }
}

/**
 * How long a refetched-URL cache stays warm (M5). Cloudfront signed URLs
 * expire on the order of hours; a very long export (multi-hour) can hit a
 * SECOND expiry wave after the first refetch. Making the cache TTL-based
 * — rather than "hold forever" — lets the second wave trigger a fresh
 * fetch instead of returning a URL we already know is stale.
 */
export const REFETCH_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Build a `refetchUrl` closure that refetches all photo activities for a
 * given student and looks up the fresh signed URL by object_id. Cached so
 * we don't refetch on every 403 — signed URLs typically all expire together,
 * so the first refetch refreshes the whole batch. Cache invalidates after
 * REFETCH_CACHE_TTL_MS so a very-long export that hits a second URL-expiry
 * wave can recover (M5).
 */
export function makeRefetchUrl(
  client: BwClient,
  studentIds: string[],
  opts: { now?: () => number; ttlMs?: number } = {},
): (objectId: string) => Promise<string | null> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? REFETCH_CACHE_TTL_MS;
  let cache: Map<string, string> | null = null;
  let cachedAt = 0;
  let inflight: Promise<Map<string, string>> | null = null;
  const load = async (): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    for (const sid of studentIds) {
      const acts = await fetchAllActivities(client, sid, { actionType: 'ac_photo' });
      for (const a of acts) {
        const url = bestUrl(a.media);
        if (url) m.set(a.object_id, url);
      }
    }
    return m;
  };
  return async (objectId: string) => {
    const fresh = cache !== null && now() - cachedAt < ttl;
    if (!fresh) {
      // Drop the stale reference before kicking a reload so a concurrent
      // caller sees the "no cache yet" state and joins our inflight rather
      // than returning a stale URL.
      cache = null;
      if (!inflight) {
        const p = load();
        inflight = p;
        try {
          const loaded = await p;
          cache = loaded;
          cachedAt = now();
        } finally {
          // Only clear if we're the caller that started it — a second
          // concurrent caller would have joined via `await inflight` below.
          if (inflight === p) inflight = null;
        }
      } else {
        cache = await inflight;
      }
    }
    return cache?.get(objectId) ?? null;
  };
}
