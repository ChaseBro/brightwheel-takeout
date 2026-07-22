// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setStorageArea,
  clearHistory,
  clearPermaFailedPhotos,
  loadHistory,
  permaFailedPhotoSet,
  recordPermaFailedPhotos,
  recordRun,
  recordSeen,
  seenAsSets,
  SEEN_CAP_PER_KIND,
  STORAGE_KEY,
  summarize,
  type StorageArea,
} from '@/lib/local-history';

class MemStorage implements StorageArea {
  data = new Map<string, unknown>();
  async get(keys: string | string[] | Record<string, unknown> | null) {
    const out: Record<string, unknown> = {};
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
    for (const k of list) {
      if (this.data.has(k)) out[k] = this.data.get(k);
    }
    return out;
  }
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data.set(k, v);
  }
  async remove(keys: string | string[]) {
    const list = typeof keys === 'string' ? [keys] : keys;
    for (const k of list) this.data.delete(k);
  }
}

let store: MemStorage;
beforeEach(() => {
  store = new MemStorage();
  __setStorageArea(store);
});
afterEach(() => __setStorageArea(null));

describe('loadHistory', () => {
  it('returns empty history when the key is absent', async () => {
    const h = await loadHistory();
    expect(h).toEqual({ runs: [], perGuardian: {} });
  });

  it('recovers from a corrupt payload (wrong shape) instead of throwing', async () => {
    await store.set({ [STORAGE_KEY]: 'not-an-object' });
    const h = await loadHistory();
    expect(h).toEqual({ runs: [], perGuardian: {} });
  });

  it('recovers when runs is missing / not an array', async () => {
    await store.set({ [STORAGE_KEY]: { runs: 'oops', perGuardian: {} } });
    const h = await loadHistory();
    expect(h).toEqual({ runs: [], perGuardian: {} });
  });
});

describe('recordSeen', () => {
  it('dedupes on insertion and isolates guardians', async () => {
    await recordSeen('g-1', 'photos', ['p1', 'p2']);
    await recordSeen('g-1', 'photos', ['p2', 'p3']);
    await recordSeen('g-2', 'photos', ['other']);
    const h = await loadHistory();
    expect(h.perGuardian['g-1']!.seenObjectIds.photos).toEqual(['p1', 'p2', 'p3']);
    expect(h.perGuardian['g-2']!.seenObjectIds.photos).toEqual(['other']);
    expect(h.perGuardian['g-1']!.seenObjectIds.notes).toEqual([]);
  });

  it('locks the per-kind cap at 200k (H5 — the previous 10k cap caused re-download loops)', async () => {
    // Sanity: the cap is much larger than any observed real family. If this
    // ever needs to shrink, first read the H5 sizing note in local-history.ts.
    expect(SEEN_CAP_PER_KIND).toBe(200_000);
  });

  it('LRU-drops the oldest ids when the per-kind cap is exceeded', async () => {
    // Two batches, sized to stay well within the cap: first pushes half the
    // cap + 1, second pushes half the cap → cap + 1 total, trimmed to cap
    // with only the earliest 1 id dropped.
    const half = Math.floor(SEEN_CAP_PER_KIND / 2);
    const first = Array.from({ length: half + 1 }, (_, i) => `p${i}`);
    const second = Array.from({ length: half }, (_, i) => `p${i + half + 1}`);
    await recordSeen('g-1', 'photos', first);
    await recordSeen('g-1', 'photos', second);
    const h = await loadHistory();
    const ids = h.perGuardian['g-1']!.seenObjectIds.photos;
    expect(ids.length).toBe(SEEN_CAP_PER_KIND);
    // The earliest inserted id (p0) got trimmed; p1 is now the head.
    expect(ids[0]).toBe('p1');
    expect(ids[ids.length - 1]).toBe(`p${SEEN_CAP_PER_KIND}`);
  });
});

describe('recordRun', () => {
  it('records a completed run + updates lastExportedAt + merges seen', async () => {
    await recordRun(
      {
        runId: 'r-1',
        guardianId: 'g-1',
        exportedAt: 1000,
        counts: { notes: 5, messages: 3, photos: 10 },
        includedKinds: ['notes', 'photos'],
        dateRangeFrom: null,
        dateRangeTo: null,
      },
      { photos: ['p1', 'p2'], notes: ['n1'] },
    );
    const h = await loadHistory();
    expect(h.runs).toHaveLength(1);
    expect(h.perGuardian['g-1']!.lastExportedAt).toBe(1000);
    expect(h.perGuardian['g-1']!.seenObjectIds.photos).toEqual(['p1', 'p2']);
    expect(h.perGuardian['g-1']!.seenObjectIds.notes).toEqual(['n1']);
  });

  it('caps runs history at RUN_HISTORY_CAP', async () => {
    for (let i = 0; i < 150; i++) {
      await recordRun({
        runId: `r-${i}`,
        guardianId: 'g-1',
        exportedAt: i,
        counts: { notes: 0, messages: 0, photos: 0 },
        includedKinds: [],
      });
    }
    const h = await loadHistory();
    expect(h.runs.length).toBe(100);
    // The 50 oldest runs were dropped.
    expect(h.runs[0]!.runId).toBe('r-50');
    expect(h.runs[h.runs.length - 1]!.runId).toBe('r-149');
  });
});

describe('summarize / seenAsSets', () => {
  it('summarizes to hasHistory=false when nothing has been recorded', async () => {
    const h = await loadHistory();
    const s = summarize(h, 'g-1');
    expect(s.hasHistory).toBe(false);
    expect(s.lastExportedAt).toBeNull();
  });

  it('returns hasHistory=true after a run and materializes sets', async () => {
    await recordRun(
      {
        runId: 'r-1',
        guardianId: 'g-1',
        exportedAt: 1234,
        counts: { notes: 1, messages: 0, photos: 2 },
        includedKinds: ['photos'],
      },
      { photos: ['p1', 'p2'] },
    );
    const h = await loadHistory();
    const s = summarize(h, 'g-1');
    expect(s.hasHistory).toBe(true);
    expect(s.lastExportedAt).toBe(1234);
    expect(s.seenCounts.photos).toBe(2);
    const sets = seenAsSets(h, 'g-1');
    expect(sets.photos.has('p1')).toBe(true);
    expect(sets.photos.has('p2')).toBe(true);
    expect(sets.photos.has('p3')).toBe(false);
  });
});

describe('permaFailedPhotos (H6)', () => {
  it('records + reads back a set of perma-failed ids', async () => {
    await recordPermaFailedPhotos('g-1', ['p1', 'p2']);
    await recordPermaFailedPhotos('g-1', ['p2', 'p3']); // dedupes
    const h = await loadHistory();
    expect(Array.from(permaFailedPhotoSet(h, 'g-1')).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('summarize surfaces permaFailedCount', async () => {
    await recordPermaFailedPhotos('g-1', ['p1', 'p2']);
    const h = await loadHistory();
    const s = summarize(h, 'g-1');
    expect(s.permaFailedCount).toBe(2);
  });

  it('clearPermaFailedPhotos wipes the set', async () => {
    await recordPermaFailedPhotos('g-1', ['p1']);
    await clearPermaFailedPhotos('g-1');
    const h = await loadHistory();
    expect(permaFailedPhotoSet(h, 'g-1').size).toBe(0);
  });

  it('is empty for a guardian with no history', async () => {
    const h = await loadHistory();
    expect(permaFailedPhotoSet(h, 'nobody').size).toBe(0);
  });
});

describe('clearHistory', () => {
  it('removes the storage key entirely', async () => {
    await recordSeen('g-1', 'photos', ['p1']);
    await clearHistory();
    const h = await loadHistory();
    expect(h).toEqual({ runs: [], perGuardian: {} });
  });
});
