// Local export history — wraps chrome.storage.local under one key so the
// takeout page can offer "Since my last export" + "Skip already-exported".
//
// Backend-less by design: the first release ships without any auth or
// remote store. Once the cross-device sync backend ships, RemoteSync + this
// local mirror can be reconciled (the shape overlaps intentionally).
//
import { LruStringSet } from './lru-string-set.js';

// Storage guardrail: `seenObjectIds` is capped per kind per guardian.
// Sizing tradeoff (see H5): a Brightwheel object_id is a UUID (~36 chars);
// JSON serialized as a string element it's ~40 bytes. A 200k cap →
// 200_000 * 40 ≈ 7.6 MB per kind per guardian in the worst case. The p90
// family (one guardian, ~6k photos + 1.5k each notes/messages) sits at
// well under 500 KB per kind and never approaches the cap.
//
// Why the previous 10k cap was wrong (see H5): a guardian with 12k
// lifetime photos would evict the OLDEST 2k on each incremental export.
// Those 2k re-appear on the next /activities pull, get "re-discovered",
// get re-downloaded, and evict the next-oldest 2k — a permanent
// re-download loop that wastes bandwidth AND makes the "since my last
// export" preset silently untruthful. 200k comfortably covers the head
// of the empirical distribution (largest observed family, ~40k photos).
// If a truly-heavy guardian ever approaches 200k, the fix is to add the
// `unlimitedStorage` permission (already an option — see the manifest).

export interface LocalRun {
  runId: string;
  guardianId: string;
  exportedAt: number;
  dateRangeFrom?: string | null;
  dateRangeTo?: string | null;
  counts: { notes: number; messages: number; photos: number };
  includedKinds: string[];
}

export interface PerGuardian {
  lastExportedAt: number;
  seenObjectIds: {
    photos: string[];
    notes: string[];
    messages: string[];
  };
  /**
   * Photos that permanently failed to download in a prior run (see H6). We
   * skip these on subsequent runs so the retry budget isn't wasted forever;
   * the takeout page's "Retry failed" affordance clears / reprocesses them.
   */
  permaFailedPhotos?: string[];
}

export interface LocalHistory {
  runs: LocalRun[];
  perGuardian: Record<string, PerGuardian>;
}

export const STORAGE_KEY = 'bw-takeout:history:v1';
export const SEEN_CAP_PER_KIND = 200_000;
/** Keep at most this many completed runs — otherwise `runs` grows forever. */
export const RUN_HISTORY_CAP = 100;

export type SeenKind = 'photos' | 'notes' | 'messages';

// ---- Storage adapter (test-injectable) ------------------------------------

/**
 * Minimal shape of chrome.storage.local we actually use. Splitting it out
 * keeps the module unit-testable in a plain node env without a fake `chrome`
 * global on every test file.
 */
export interface StorageArea {
  get(keys: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

let storageOverride: StorageArea | null = null;

/** Test seam. Pass null to reset to chrome.storage.local. */
export function __setStorageArea(area: StorageArea | null): void {
  storageOverride = area;
}

function getStorage(): StorageArea {
  if (storageOverride) return storageOverride;
  const g = globalThis as { chrome?: { storage?: { local?: StorageArea } } };
  const area = g.chrome?.storage?.local;
  if (!area) {
    throw new Error(
      'local-history: chrome.storage.local is not available in this context',
    );
  }
  return area;
}

// ---- Read / write ---------------------------------------------------------

function emptyHistory(): LocalHistory {
  return { runs: [], perGuardian: {} };
}

/**
 * Load history. On corrupt storage (JSON.parse failure or unexpected shape)
 * returns an empty history instead of throwing so a broken key can never
 * lock a parent out of the extension.
 */
export async function loadHistory(): Promise<LocalHistory> {
  try {
    const res = await getStorage().get(STORAGE_KEY);
    const raw = res[STORAGE_KEY];
    if (!raw || typeof raw !== 'object') return emptyHistory();
    const obj = raw as Partial<LocalHistory>;
    if (!Array.isArray(obj.runs) || typeof obj.perGuardian !== 'object' || obj.perGuardian === null) {
      return emptyHistory();
    }
    return { runs: obj.runs, perGuardian: obj.perGuardian };
  } catch {
    return emptyHistory();
  }
}

export async function saveHistory(history: LocalHistory): Promise<void> {
  await getStorage().set({ [STORAGE_KEY]: history });
}

export async function clearHistory(): Promise<void> {
  await getStorage().remove(STORAGE_KEY);
}

// ---- Per-guardian helpers -------------------------------------------------

function ensureGuardian(history: LocalHistory, guardianId: string): PerGuardian {
  let g = history.perGuardian[guardianId];
  if (!g) {
    g = {
      lastExportedAt: 0,
      seenObjectIds: { photos: [], notes: [], messages: [] },
      permaFailedPhotos: [],
    };
    history.perGuardian[guardianId] = g;
  } else if (!g.permaFailedPhotos) {
    // Migrate legacy rows that predate H6.
    g.permaFailedPhotos = [];
  }
  return g;
}

/**
 * Merge a set of "permanently failed to download" photo object_ids into the
 * per-guardian record. Called from run.ts after the photo download pass so
 * a future run skips them instead of burning retry budget forever.
 */
export async function recordPermaFailedPhotos(
  guardianId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const history = await loadHistory();
  const g = ensureGuardian(history, guardianId);
  g.permaFailedPhotos = mergeCapped(g.permaFailedPhotos ?? [], ids);
  await saveHistory(history);
}

/** Remove all permaFailed entries — the takeout page's "Retry" action. */
export async function clearPermaFailedPhotos(guardianId: string): Promise<void> {
  const history = await loadHistory();
  const g = history.perGuardian[guardianId];
  if (!g) return;
  g.permaFailedPhotos = [];
  await saveHistory(history);
}

function mergeCapped(existing: string[], ids: Iterable<string>): string[] {
  // Wrap the existing capped set in an LruStringSet so add / dedupe /
  // LRU-trim are one call. LruStringSet preserves insertion order, so the
  // oldest ids get evicted first when we spill past the cap.
  const s = new LruStringSet(existing, SEEN_CAP_PER_KIND);
  s.addAll(ids);
  return s.toArray();
}

/**
 * Merge new object_ids into the per-guardian seen set. Dedupes on the way
 * in — a photo already recorded doesn't move to the tail of the LRU (we
 * don't want a re-export to promote every id, defeating the cap).
 */
export async function recordSeen(
  guardianId: string,
  kind: SeenKind,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const history = await loadHistory();
  const g = ensureGuardian(history, guardianId);
  g.seenObjectIds[kind] = mergeCapped(g.seenObjectIds[kind], ids);
  await saveHistory(history);
}

/**
 * Record a completed run. Bumps lastExportedAt to `exportedAt`, appends to
 * the runs history (capped at RUN_HISTORY_CAP), and merges any seen ids.
 * Callers may pass empty seen sets and update them via `recordSeen`.
 */
export async function recordRun(
  entry: LocalRun,
  seen?: Partial<Record<SeenKind, string[]>>,
): Promise<void> {
  const history = await loadHistory();
  const g = ensureGuardian(history, entry.guardianId);
  g.lastExportedAt = Math.max(g.lastExportedAt, entry.exportedAt);
  if (seen) {
    for (const kind of Object.keys(seen) as SeenKind[]) {
      const ids = seen[kind] ?? [];
      if (ids.length === 0) continue;
      g.seenObjectIds[kind] = mergeCapped(g.seenObjectIds[kind], ids);
    }
  }
  history.runs.push(entry);
  if (history.runs.length > RUN_HISTORY_CAP) {
    history.runs.splice(0, history.runs.length - RUN_HISTORY_CAP);
  }
  await saveHistory(history);
}

/** Materialize the seen-id arrays as Sets for a quick membership check. */
export function seenAsSets(
  history: LocalHistory,
  guardianId: string,
): Record<SeenKind, Set<string>> {
  const g = history.perGuardian[guardianId];
  return {
    photos: new Set(g?.seenObjectIds.photos ?? []),
    notes: new Set(g?.seenObjectIds.notes ?? []),
    messages: new Set(g?.seenObjectIds.messages ?? []),
  };
}

/** Materialize the permaFailedPhotos array as a Set. */
export function permaFailedPhotoSet(history: LocalHistory, guardianId: string): Set<string> {
  const g = history.perGuardian[guardianId];
  return new Set(g?.permaFailedPhotos ?? []);
}

export function summarize(history: LocalHistory, guardianId: string): {
  hasHistory: boolean;
  lastExportedAt: number | null;
  seenCounts: { photos: number; notes: number; messages: number };
  permaFailedCount: number;
} {
  const g = history.perGuardian[guardianId];
  if (!g) {
    return {
      hasHistory: false,
      lastExportedAt: null,
      seenCounts: { photos: 0, notes: 0, messages: 0 },
      permaFailedCount: 0,
    };
  }
  return {
    hasHistory: g.lastExportedAt > 0 || Object.values(g.seenObjectIds).some((a) => a.length > 0),
    lastExportedAt: g.lastExportedAt || null,
    seenCounts: {
      photos: g.seenObjectIds.photos.length,
      notes: g.seenObjectIds.notes.length,
      messages: g.seenObjectIds.messages.length,
    },
    permaFailedCount: (g.permaFailedPhotos ?? []).length,
  };
}
