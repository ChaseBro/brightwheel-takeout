// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LruStringSet } from '@/lib/lru-string-set';

describe('LruStringSet', () => {
  it('dedupes on add and reports newly-inserted state', () => {
    const s = new LruStringSet();
    expect(s.add('a')).toBe(true);
    expect(s.add('a')).toBe(false);
    expect(s.size).toBe(1);
  });

  it('addAll returns count of newly-inserted ids', () => {
    const s = new LruStringSet(['a']);
    expect(s.addAll(['a', 'b', 'c'])).toBe(2);
    expect(s.toArray()).toEqual(['a', 'b', 'c']);
  });

  it('LRU-drops the oldest ids when cap is exceeded', () => {
    const s = new LruStringSet([], 3);
    s.addAll(['a', 'b', 'c', 'd', 'e']);
    // a + b evicted; c/d/e survive in insertion order.
    expect(s.toArray()).toEqual(['c', 'd', 'e']);
  });

  it('re-adding an existing id does NOT promote it to the tail', () => {
    // This is the load-bearing property callers rely on: a re-export
    // should NOT reset the LRU by touching every id.
    const s = new LruStringSet(['a', 'b', 'c'], 3);
    s.add('a'); // no-op — 'a' stays at the head (oldest by insertion).
    s.add('d'); // trim → 'a' evicted because it's still the oldest.
    expect(s.toArray()).toEqual(['b', 'c', 'd']);
  });

  it('trims immediately when constructed over-cap', () => {
    const s = new LruStringSet(['a', 'b', 'c', 'd'], 2);
    expect(s.toArray()).toEqual(['c', 'd']);
  });

  it('unbounded by default', () => {
    const s = new LruStringSet();
    s.addAll(Array.from({ length: 100 }, (_, i) => `k${i}`));
    expect(s.size).toBe(100);
  });
});
