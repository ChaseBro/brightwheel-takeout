// TDD for the "should we show the Format section?" predicate.
// Format only matters when at least one of notes/messages is selected —
// photos are always JPGs, so if only photos are checked the CSV/XLSX/JSON
// radio is confusing noise.
import { describe, expect, it } from 'vitest';
import { shouldShowFormatSection } from '@/lib/format-visibility';

const NONE = { photos: false, notes: false, messages: false, viewer: false };

describe('shouldShowFormatSection', () => {
  it('shows when notes are included', () => {
    expect(shouldShowFormatSection({ ...NONE, notes: true })).toBe(true);
  });
  it('shows when messages are included', () => {
    expect(shouldShowFormatSection({ ...NONE, messages: true })).toBe(true);
  });
  it('hides when only photos are included', () => {
    expect(shouldShowFormatSection({ ...NONE, photos: true })).toBe(false);
  });
  it('hides when only viewer is included (viewer HTML doesn\'t depend on format)', () => {
    expect(shouldShowFormatSection({ ...NONE, viewer: true })).toBe(false);
  });
  it('hides when only photos + viewer are included', () => {
    expect(shouldShowFormatSection({ ...NONE, photos: true, viewer: true })).toBe(false);
  });
  it('shows for the default all-on case', () => {
    expect(shouldShowFormatSection({ photos: true, notes: true, messages: true, viewer: true })).toBe(true);
  });
  it('hides when nothing is included (nothing to format)', () => {
    expect(shouldShowFormatSection(NONE)).toBe(false);
  });
});
