// Persistent run checkpoint (IndexedDB via idb-keyval).
//
// Snapshots the run's cursor + already-processed object IDs every N items.
// On relaunch, the takeout page checks for an unfinished run and offers to
// Resume. The checkpoint is deleted on successful completion.
//
// We keep the shape small (no photo bytes, no note text) so a very-long run
// doesn't push us near IDB quota.

import { get, set, del } from 'idb-keyval';

const KEY = 'bw-takeout:checkpoint';

export type CheckpointKind = 'photos' | 'notes' | 'messages';

/**
 * Kind-keyed set of processed object_ids (L2). Splitting on kind eliminates
 * the latent collision risk of a flat set — if two kinds ever return the
 * same id (Brightwheel's ids are namespaced today, but nothing enforces it
 * across API versions), the resume logic won't spuriously skip work.
 */
export interface SeenObjectIds {
  photos: string[];
  notes: string[];
  messages: string[];
}

export interface Checkpoint {
  runId: string;
  guardianId: string;
  studentIds: string[];
  /**
   * Per-kind sets of already-processed object_ids. Resume filters against
   * these on the hot path. The previous shape was `seenObjectIds: string[]`
   * — the migration on read (see `loadCheckpoint`) accepts either.
   */
  seenObjectIds: SeenObjectIds;
  /**
   * Photos that failed permanently this run (after refetch retry, still 403
   * or network-errored). Kept separate from `seenObjectIds` so a user can
   * later Retry them via the UI. Persisted so a subsequent Resume in the
   * SAME session doesn't re-download them. LocalHistory carries the same
   * set across sessions — see `permaFailedPhotos` in local-history.ts.
   */
  permaFailedIds?: string[];
  startedAt: number;
  updatedAt: number;
  /** Run settings — persisted so Resume replays with the same scope. */
  settings?: {
    include?: {
      photos?: boolean;
      notes?: boolean;
      messages?: boolean;
      viewer?: boolean;
      /** Opt-in daily-reports bucket (ac_food/nap/health_check/potty/etc.). */
      dailyReports?: boolean;
    };
    format?: 'csv' | 'xlsx' | 'json';
    dateRange?: { from?: string | null; to?: string | null } | null;
    debug?: boolean;
    skipAlreadyExported?: boolean;
  };
}

/** Empty per-kind seen-set — factored so run.ts / tests share one initializer. */
export function emptySeen(): SeenObjectIds {
  return { photos: [], notes: [], messages: [] };
}

export async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  cp.updatedAt = Date.now();
  await set(KEY, cp);
}

export async function loadCheckpoint(): Promise<Checkpoint | undefined> {
  const raw = (await get(KEY)) as (Checkpoint & { cursors?: unknown }) | undefined;
  if (!raw) return undefined;
  // Migrate legacy shapes:
  //   - seenObjectIds as a flat string[] (pre-L2) → dump into `photos` for
  //     safety (the largest kind; the extra ids on the wrong list are
  //     harmless, they'll just cause a legitimate item to be filtered out
  //     if a truly-cross-kind collision happens, which we've never seen).
  //   - `cursors` field (pre-L1) → dropped silently on the next save.
  if (Array.isArray(raw.seenObjectIds)) {
    const migrated: SeenObjectIds = emptySeen();
    migrated.photos = raw.seenObjectIds as unknown as string[];
    (raw as Checkpoint).seenObjectIds = migrated;
  } else if (!raw.seenObjectIds) {
    (raw as Checkpoint).seenObjectIds = emptySeen();
  }
  if ('cursors' in raw) delete (raw as { cursors?: unknown }).cursors;
  return raw as Checkpoint;
}

export async function clearCheckpoint(): Promise<void> {
  await del(KEY);
}

/**
 * Convenience wrapper: batches checkpoint writes so we only hit IDB every
 * N items. `mark()` records a completed item; `flush()` writes now.
 *
 * Uses an internal `Set<string>` for O(1) membership on the mark path —
 * the previous `Array.includes` scan was O(n) per mark and would degrade
 * badly at the p90 volume target (~6000 photos). The array shape is only
 * materialized at snapshot / persistence time.
 */
export class CheckpointWriter {
  private cp: Omit<Checkpoint, 'seenObjectIds' | 'permaFailedIds'>;
  private seen: Record<CheckpointKind, Set<string>>;
  private permaFailed: Set<string>;
  private pending = 0;
  private every: number;

  constructor(cp: Checkpoint, every: number) {
    const { seenObjectIds, permaFailedIds, ...rest } = cp;
    this.cp = rest;
    this.seen = {
      photos: new Set(seenObjectIds.photos),
      notes: new Set(seenObjectIds.notes),
      messages: new Set(seenObjectIds.messages),
    };
    this.permaFailed = new Set(permaFailedIds ?? []);
    this.every = every;
  }

  async mark(kind: CheckpointKind, objectId: string): Promise<void> {
    this.seen[kind].add(objectId);
    this.pending++;
    if (this.pending >= this.every) await this.flush();
  }

  /**
   * Record a photo that permanently failed to download. Kept out of the
   * `seen` set so the UI can differentiate "successfully archived" from
   * "gave up on this one", and so a Retry-Failed action can force it back.
   */
  async markFailed(objectId: string): Promise<void> {
    if (this.permaFailed.has(objectId)) return;
    this.permaFailed.add(objectId);
    this.pending++;
    if (this.pending >= this.every) await this.flush();
  }

  async flush(): Promise<void> {
    this.pending = 0;
    await saveCheckpoint(this.snapshot());
  }

  snapshot(): Checkpoint {
    return {
      ...this.cp,
      seenObjectIds: {
        photos: Array.from(this.seen.photos),
        notes: Array.from(this.seen.notes),
        messages: Array.from(this.seen.messages),
      },
      permaFailedIds: Array.from(this.permaFailed),
    };
  }
}
