// Big-export gatekeeper: given a scope preview, decide whether to prompt the
// user for confirmation before starting. Kept pure so we can unit-test the
// thresholds without touching the DOM.

import type { ScopePreview } from '@/scraper/preview.js';
import { formatBytes, formatDuration } from '@/scraper/preview.js';

const BYTES_THRESHOLD = 2 * 1024 * 1024 * 1024;   // 2 GB
const MS_THRESHOLD = 30 * 60 * 1000;              // 30 min
const PHOTO_THRESHOLD = 5000;

export function shouldConfirmBigExport(scope: ScopePreview): boolean {
  return bigExportReasons(scope).length > 0;
}

/**
 * Human-readable reason strings — one per crossed threshold. Empty list
 * means the export is small enough to just start.
 */
export function bigExportReasons(scope: ScopePreview): string[] {
  const out: string[] = [];
  if (scope.estimatedBytes > BYTES_THRESHOLD) {
    out.push(`Estimated size ${formatBytes(scope.estimatedBytes)} (over 2 GB)`);
  }
  if (scope.estimatedMs > MS_THRESHOLD) {
    out.push(`Estimated time ${formatDuration(scope.estimatedMs)} (over 30 min)`);
  }
  if (scope.totalPhotos > PHOTO_THRESHOLD) {
    out.push(`${scope.totalPhotos.toLocaleString()} photos (over ${PHOTO_THRESHOLD.toLocaleString()})`);
  }
  return out;
}
