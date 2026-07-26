// Tests for the in-archive README formatter — the human-facing "what's in
// this folder" guide bundled at the top of every export.

import { describe, expect, it } from 'vitest';
import { writeArchiveReadme } from '@/scraper/formatters/archive-readme.js';
import type { FormatterManifest } from '@/scraper/formatters/types.js';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const baseManifest: FormatterManifest = {
  guardianId: 'g-1',
  studentIds: ['stu-1'],
  exportedAt: '2026-07-22T12:34:56.000Z',
  extensionVersion: '0.1.0',
  counts: { notes: 2, messages: 1, photos: 3 },
};

const allIncludes = {
  notes: true,
  messages: true,
  photos: true,
  viewer: true,
  dailyReports: true,
};

describe('writeArchiveReadme', () => {
  it('describes the daily-reports file by its REAL name, not a phantom activities/ folder', () => {
    // Regression: the README previously advertised an `activities/` directory
    // that the exporter never creates — run() emits a top-level
    // daily-reports.{csv,json}. A guardian who enabled the opt-in and read the
    // README would hunt for a folder that doesn't exist.
    const csv = decode(writeArchiveReadme({ manifest: baseManifest, includes: allIncludes, format: 'csv' }));
    expect(csv).toContain('daily-reports.csv');
    expect(csv).not.toContain('activities/');

    const json = decode(writeArchiveReadme({ manifest: baseManifest, includes: allIncludes, format: 'json' }));
    expect(json).toContain('daily-reports.json');
    expect(json).not.toContain('activities/');
  });

  it('omits the daily-reports line when the kind was not included', () => {
    const out = decode(
      writeArchiveReadme({
        manifest: baseManifest,
        includes: { ...allIncludes, dailyReports: false },
        format: 'csv',
      }),
    );
    expect(out).not.toContain('daily-reports');
  });

  it('lists photos/ and manifest.json for a normal export', () => {
    const out = decode(writeArchiveReadme({ manifest: baseManifest, includes: allIncludes, format: 'csv' }));
    expect(out).toContain('photos/');
    expect(out).toContain('manifest.json');
  });
});
