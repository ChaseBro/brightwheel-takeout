import { describe, expect, it } from 'vitest';
import { NullSync, RemoteSync } from '@/lib/sync';

describe('sync', () => {
  it('NullSync.fetchKnown returns an empty set for every kind', async () => {
    const s = new NullSync();
    for (const k of ['photo', 'note', 'message'] as const) {
      const set = await s.fetchKnown(k);
      expect(set.size).toBe(0);
    }
  });

  it('NullSync.recordExported does not throw', async () => {
    const s = new NullSync();
    await expect(s.recordExported([{ kind: 'note', brightwheelObjectId: 'x' }])).resolves.toBeUndefined();
  });

  it('RemoteSync methods throw "not yet implemented"', async () => {
    const s = new RemoteSync('https://api.example.com', 'sess');
    await expect(s.fetchKnown('photo')).rejects.toThrow(/not yet implemented/);
    await expect(s.recordExported([])).rejects.toThrow(/not yet implemented/);
  });
});
