// TDD for the "should we suggest turning Debug mode on?" predicate.
import { describe, expect, it } from 'vitest';
import { shouldSuggestDebugMode } from '@/lib/debug-suggest';

describe('shouldSuggestDebugMode', () => {
  it('suggests when the user just hit an error and debug is off', () => {
    expect(shouldSuggestDebugMode({ hasError: true, debugEnabled: false })).toBe(true);
  });

  it('does NOT suggest when debug is already on (would be duplicate advice)', () => {
    expect(shouldSuggestDebugMode({ hasError: true, debugEnabled: true })).toBe(false);
  });

  it('does NOT suggest without an error (nothing to diagnose)', () => {
    expect(shouldSuggestDebugMode({ hasError: false, debugEnabled: false })).toBe(false);
  });

  it('does NOT suggest for auth errors — those are user-fixable (log back in), not code bugs', () => {
    expect(
      shouldSuggestDebugMode({ hasError: true, debugEnabled: false, errorName: 'BwAuthError' }),
    ).toBe(false);
  });

  it('does NOT suggest for a user-cancelled run (Stop was pressed)', () => {
    expect(
      shouldSuggestDebugMode({ hasError: true, debugEnabled: false, errorName: 'BwCancelledError' }),
    ).toBe(false);
  });

  it('does NOT suggest for rate-limit errors (retry-and-wait, not a bug)', () => {
    expect(
      shouldSuggestDebugMode({ hasError: true, debugEnabled: false, errorName: 'BwRateLimitError' }),
    ).toBe(false);
  });

  it('suggests for network/server errors (probably diagnosable with a raw response body)', () => {
    for (const errorName of ['BwNetworkError', 'BwServerError', 'BwNotFoundError', 'TypeError']) {
      expect(shouldSuggestDebugMode({ hasError: true, debugEnabled: false, errorName })).toBe(true);
    }
  });
});
