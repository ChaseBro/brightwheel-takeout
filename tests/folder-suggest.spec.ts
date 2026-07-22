// TDD for the "what folder name should we suggest?" helper.
// No date in the suggested name — users REUSE the same folder across
// incremental exports (that's how the welcome-back "get anything new"
// flow keeps building a single growing archive).
import { describe, expect, it } from 'vitest';
import { suggestFolderName } from '@/lib/folder-suggest';

describe('suggestFolderName', () => {
  it('appends a single student\'s first name', () => {
    expect(suggestFolderName({ studentIds: ['s1'], studentNames: { s1: 'Eliza Brownell' } }))
      .toBe('Brightwheel-Takeout-Eliza');
  });

  it('appends both first names for two siblings', () => {
    expect(suggestFolderName({
      studentIds: ['s1', 's2'],
      studentNames: { s1: 'Eliza Brownell', s2: 'Milo Brownell' },
    })).toBe('Brightwheel-Takeout-Eliza-Milo');
  });

  it('falls back to generic when 3+ students (three-name folders look silly)', () => {
    expect(suggestFolderName({
      studentIds: ['a', 'b', 'c'],
      studentNames: { a: 'Alice', b: 'Bob', c: 'Cara' },
    })).toBe('Brightwheel-Takeout');
  });

  it('falls back to generic when no names known', () => {
    expect(suggestFolderName({ studentIds: ['s1'], studentNames: {} }))
      .toBe('Brightwheel-Takeout');
  });

  it('handles the empty roster case (should be defensive)', () => {
    expect(suggestFolderName({ studentIds: [], studentNames: {} }))
      .toBe('Brightwheel-Takeout');
  });

  it('never emits a date — folder is meant to be reused across incrementals', () => {
    const name = suggestFolderName({ studentIds: ['s1'], studentNames: { s1: 'Eliza' } });
    expect(name).not.toMatch(/20\d\d/);       // no year
    expect(name).not.toMatch(/\d{4}-\d{2}/);  // no yyyy-mm
  });

  it('sanitises names containing filesystem-hostile characters', () => {
    expect(suggestFolderName({
      studentIds: ['s1'],
      studentNames: { s1: 'Ann/Mary O\'Brien' },
    })).toBe('Brightwheel-Takeout-AnnMary');
  });

  it('trims whitespace and control chars from names', () => {
    expect(suggestFolderName({
      studentIds: ['s1'],
      studentNames: { s1: '  Eliza  ' },
    })).toBe('Brightwheel-Takeout-Eliza');
  });

  it('drops accented characters gracefully rather than emitting mojibake', () => {
    // Not required to strip diacritics — but the result must still be a
    // valid folder-name-shaped string with no whitespace inside.
    const name = suggestFolderName({
      studentIds: ['s1'],
      studentNames: { s1: 'Émilie Bérubé' },
    });
    expect(name.startsWith('Brightwheel-Takeout-')).toBe(true);
    expect(name).not.toMatch(/\s/);
  });
});
