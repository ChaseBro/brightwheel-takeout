// Politeness constants — defined once, tunable in one place.
//
// These match the values in ~/src/notes/Library/Brightwheel/download_notes.py
// and download_photos.py, which have run for months without triggering a BW
// rate-limit event.

export const PACING = {
  /** Delay between paginated JSON API calls. */
  jsonDelayMs: 300,
  /** Photo download concurrency (CloudFront handles this comfortably). */
  photoConcurrency: 3,
  /** Retry ceiling for transient failures. */
  maxRetries: 5,
  /** Backoff base (ms). Total wait ~= base * 2^attempt + jitter. */
  backoffBaseMs: 100,
  /** Backoff cap (ms). */
  backoffMaxMs: 30_000,
  /** Requests-per-run budget (soft cap — logged, warned). */
  requestBudget: 20_000,
  /** Page size for /activities. Small sizes return misleading counts. */
  pageSize: 1000,
  /** Snapshot cadence for the IndexedDB checkpoint. */
  checkpointEvery: 25,
} as const;
