import { beforeEach, describe, expect, it, vi } from 'vitest';

// idb-keyval touches indexedDB directly. jsdom ships a no-op indexedDB but
// idb-keyval crashes on real writes there; mock the module to an in-memory
// map so the test asserts *our* logic, not IndexedDB's.
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>();
  return {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => {
      store.set(k, v);
    },
    del: async (k: string) => {
      store.delete(k);
    },
    __store: store,
  };
});

import {
  CheckpointWriter,
  emptySeen,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  type Checkpoint,
} from '@/lib/checkpoint';

const baseCp = (): Checkpoint => ({
  runId: 'run_1',
  guardianId: 'g',
  studentIds: ['s1', 's2'],
  seenObjectIds: emptySeen(),
  startedAt: 1000,
  updatedAt: 1000,
});

describe('checkpoint', () => {
  beforeEach(async () => {
    await clearCheckpoint();
  });

  it('save + load round-trips', async () => {
    const cp = baseCp();
    cp.seenObjectIds.photos = ['p-42'];
    await saveCheckpoint(cp);
    const loaded = await loadCheckpoint();
    expect(loaded?.seenObjectIds.photos).toEqual(['p-42']);
    expect(loaded?.updatedAt).toBeGreaterThanOrEqual(1000);
  });

  it('CheckpointWriter batches every N marks and keeps per-kind sets (L2)', async () => {
    const cp = baseCp();
    const writer = new CheckpointWriter(cp, 3);
    for (let i = 0; i < 5; i++) await writer.mark('photos', `p-${i}`);
    for (let i = 0; i < 2; i++) await writer.mark('notes', `n-${i}`);
    // Force flush to be sure.
    await writer.flush();
    const loaded = await loadCheckpoint();
    expect(loaded?.seenObjectIds.photos.length).toBe(5);
    expect(loaded?.seenObjectIds.notes.length).toBe(2);
    expect(loaded?.seenObjectIds.messages.length).toBe(0);
  });

  it('does not double-record the same object_id', async () => {
    const cp = baseCp();
    const writer = new CheckpointWriter(cp, 1);
    await writer.mark('notes', 'n-1');
    await writer.mark('notes', 'n-1');
    await writer.mark('notes', 'n-2');
    const snapshot = writer.snapshot();
    expect(snapshot.seenObjectIds.notes).toEqual(['n-1', 'n-2']);
  });

  it('migrates a legacy flat-array checkpoint on read (pre-L2)', async () => {
    // Persist the pre-L2 shape directly through the mocked idb-keyval.
    await saveCheckpoint({
      ...baseCp(),
      seenObjectIds: ['legacy-1', 'legacy-2'] as unknown as Checkpoint['seenObjectIds'],
    });
    const loaded = await loadCheckpoint();
    // The migration dumps everything into `photos` (the largest bucket).
    expect(loaded?.seenObjectIds.photos).toEqual(['legacy-1', 'legacy-2']);
    expect(loaded?.seenObjectIds.notes).toEqual([]);
    expect(loaded?.seenObjectIds.messages).toEqual([]);
  });

  it('markFailed accumulates a separate set from seenObjectIds (H6)', async () => {
    const writer = new CheckpointWriter(baseCp(), 100);
    await writer.mark('photos', 'p-ok');
    await writer.markFailed('p-bad');
    await writer.markFailed('p-bad'); // idempotent
    await writer.markFailed('p-worse');
    const s = writer.snapshot();
    expect(s.seenObjectIds.photos).toEqual(['p-ok']);
    expect(s.permaFailedIds).toEqual(['p-bad', 'p-worse']);
  });

  it('carries permaFailedIds through a save/load round-trip', async () => {
    const cp = baseCp();
    cp.permaFailedIds = ['p-old-fail'];
    await saveCheckpoint(cp);
    const loaded = await loadCheckpoint();
    expect(loaded?.permaFailedIds).toEqual(['p-old-fail']);
  });

  it('clearCheckpoint removes the row', async () => {
    await saveCheckpoint(baseCp());
    await clearCheckpoint();
    expect(await loadCheckpoint()).toBeUndefined();
  });
});
