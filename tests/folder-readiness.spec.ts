// TDD for the "is this folder OK to write into?" post-pick check.
// Warns when a user picks a folder that already has a lot of unrelated
// content — protects against "just picked ~/Documents by accident" mistakes.
import { describe, expect, it } from 'vitest';
import { folderReadinessSummary } from '@/lib/folder-readiness';

const f = (name: string) => ({ name, kind: 'file' as const });
const d = (name: string) => ({ name, kind: 'directory' as const });

describe('folderReadinessSummary', () => {
  it('is clean for an empty folder', () => {
    expect(folderReadinessSummary([])).toEqual({ clean: true, nonBwFileCount: 0 });
  });

  it('is clean when the folder only contains our own artifacts', () => {
    const r = folderReadinessSummary([
      f('manifest.json'),
      f('notes.csv'),
      f('messages.csv'),
      f('photos.csv'),
      f('takeout.log'),
      d('photos'),
      d('viewer'),
    ]);
    expect(r.clean).toBe(true);
    expect(r.nonBwFileCount).toBe(0);
  });

  it('is clean when we already own the folder (manifest.json present) even with stray non-BW files', () => {
    // Our own manifest.json = "this is our folder, incremental re-runs OK".
    // Guardian-id mismatch is a SEPARATE check (FolderSinkGuardianMismatchError),
    // not this one.
    const r = folderReadinessSummary([
      f('manifest.json'), // our marker
      f('random-unrelated.pdf'),
      f('some-other-file.txt'),
    ]);
    expect(r.clean).toBe(true);
  });

  it('is clean for 1–5 stray files (probably fine)', () => {
    const r = folderReadinessSummary([
      f('a.pdf'), f('b.pdf'), f('c.txt'),
    ]);
    expect(r.clean).toBe(true);
    expect(r.nonBwFileCount).toBe(3);
  });

  it('is NOT clean when >5 stray non-BW files (probably a wrong-folder mistake)', () => {
    const strays = Array.from({ length: 8 }, (_, i) => f(`invoice-${i}.pdf`));
    const r = folderReadinessSummary(strays);
    expect(r.clean).toBe(false);
    expect(r.nonBwFileCount).toBe(8);
  });

  it('recognises every extension-owned filename variant', () => {
    // Any of these should NOT count toward "non-BW" count:
    const ours = [
      f('manifest.json'),
      f('notes.csv'), f('notes.json'), f('notes.xlsx'),
      f('messages.csv'), f('messages.json'), f('messages.xlsx'),
      f('photos.csv'), f('photos.json'), f('photos.xlsx'),
      f('daily-reports.csv'), f('daily-reports.json'), f('daily-reports.xlsx'),
      f('takeout.log'),
      f('brightwheel-takeout-2026-07-21.xlsx'), // single-file xlsx export
      d('photos'), d('viewer'), d('debug'),
    ];
    expect(folderReadinessSummary(ours).nonBwFileCount).toBe(0);
  });

  it('counts hidden files (macOS .DS_Store, Windows Thumbs.db) as ignorable', () => {
    // These clutter almost every non-empty folder and shouldn't trigger a warning.
    const r = folderReadinessSummary([
      f('.DS_Store'), f('Thumbs.db'), f('.hidden'),
    ]);
    expect(r.clean).toBe(true);
    expect(r.nonBwFileCount).toBe(0);
  });
});
