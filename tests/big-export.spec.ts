// TDD for the "should we make the user confirm before starting?" predicate.
import { describe, expect, it } from 'vitest';
import { shouldConfirmBigExport, bigExportReasons } from '@/lib/big-export';

function scope(overrides: Partial<{
  photos: number;
  notes: number;
  messages: number;
  estimatedBytes: number;
  estimatedMs: number;
}> = {}) {
  return {
    totalPhotos: 0,
    totalNotes: 0,
    totalMessages: 0,
    estimatedBytes: 0,
    estimatedMs: 0,
    perStudent: [],
    threads: [],
    computedAt: 0,
    ...overrides,
    // helpers may pass "photos" instead of "totalPhotos" for terseness
    ...(overrides.photos != null ? { totalPhotos: overrides.photos } : {}),
    ...(overrides.notes != null ? { totalNotes: overrides.notes } : {}),
    ...(overrides.messages != null ? { totalMessages: overrides.messages } : {}),
  } as Parameters<typeof shouldConfirmBigExport>[0];
}

describe('shouldConfirmBigExport', () => {
  it('never asks for a small export', () => {
    expect(shouldConfirmBigExport(scope({ photos: 20, estimatedBytes: 7 * 1024 * 1024, estimatedMs: 60_000 }))).toBe(false);
  });

  it('asks if the estimate exceeds ~2 GB', () => {
    expect(shouldConfirmBigExport(scope({ estimatedBytes: 2.5 * 1024 * 1024 * 1024 }))).toBe(true);
  });

  it('asks if the estimate exceeds ~30 min', () => {
    expect(shouldConfirmBigExport(scope({ estimatedMs: 40 * 60_000 }))).toBe(true);
  });

  it('asks if photo count exceeds 5000 (large photo runs are the risky ones)', () => {
    expect(shouldConfirmBigExport(scope({ photos: 6000, estimatedBytes: 500 * 1024 * 1024, estimatedMs: 20 * 60_000 }))).toBe(true);
  });

  it('does not ask when just under every threshold', () => {
    expect(shouldConfirmBigExport(scope({ photos: 4999, estimatedBytes: 1.5 * 1024 * 1024 * 1024, estimatedMs: 25 * 60_000 }))).toBe(false);
  });
});

describe('bigExportReasons', () => {
  it('returns an empty list for a small export', () => {
    expect(bigExportReasons(scope({ photos: 20 }))).toEqual([]);
  });

  it('lists every threshold crossed with a human-readable label', () => {
    const reasons = bigExportReasons(scope({
      photos: 8000,
      estimatedBytes: 3 * 1024 * 1024 * 1024,
      estimatedMs: 60 * 60_000,
    }));
    expect(reasons.length).toBe(3);
    expect(reasons.join(' ')).toMatch(/2 GB|size/i);
    expect(reasons.join(' ')).toMatch(/30 min|time/i);
    expect(reasons.join(' ')).toMatch(/photos/i);
  });
});
