// Predicate: after a failed run, should we nudge the user to enable Debug
// mode and try again? Pure fn so we can unit-test the classifier without
// having to spin up any UI.

/** Errors that come from user-fixable state, not code bugs. Skip the nudge. */
const NON_DIAGNOSTIC_ERRORS = new Set<string>([
  'BwAuthError',        // parent's session expired — log back in
  'BwRateLimitError',   // BW throttled us — wait and retry
  'BwCancelledError',   // user pressed Stop — not an error
  'BwEnvironmentError', // Chrome too old — capture wouldn't help
]);

export interface DebugSuggestInput {
  hasError: boolean;
  debugEnabled: boolean;
  errorName?: string;
}

export function shouldSuggestDebugMode(x: DebugSuggestInput): boolean {
  if (!x.hasError) return false;
  if (x.debugEnabled) return false;
  if (x.errorName && NON_DIAGNOSTIC_ERRORS.has(x.errorName)) return false;
  return true;
}
