// TDD for the shared render helpers used by both the popup (compact action
// layer) and the takeout tab (workspace). Every function is pure — takes
// plain data, returns an HTML string — so we can drive them in jsdom without
// spinning up the whole page.

import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderScopePreviewCompactHtml,
  renderScopePreviewFullHtml,
  renderWelcomeBackHtml,
  renderResumeBannerHtml,
  renderStudentListHtml,
  renderStudentChipsHtml,
} from '@/lib/takeout-render';
import type { ScopePreview } from '@/scraper/preview';
import type { Checkpoint } from '@/lib/checkpoint';

function makeScope(overrides: Partial<ScopePreview> = {}): ScopePreview {
  return {
    perStudent: [
      { studentId: 'sid-alpha-1', studentName: 'Alice', photos: 1000, notes: 20 },
      { studentId: 'sid-beta-22', studentName: 'Bob', photos: 1860, notes: 30 },
    ],
    threads: [{ threadId: 't1', messages: 145 }],
    totalPhotos: 2860,
    totalNotes: 50,
    totalMessages: 145,
    estimatedBytes: 1.2 * 1024 * 1024 * 1024,
    estimatedMs: 18 * 60_000,
    computedAt: 0,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes all five HTML metacharacters', () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;',
    );
  });
  it('leaves plain text alone', () => {
    expect(escapeHtml('Alice Smith')).toBe('Alice Smith');
  });
});

describe('renderScopePreviewCompactHtml', () => {
  it('shows headline totals + duration + size in a single line', () => {
    const html = renderScopePreviewCompactHtml(makeScope());
    // The compact form deliberately elides per-student breakdown.
    expect(html).toContain('2,860');
    expect(html).toContain('photo'); // "photos"
    expect(html).toContain('1.2 GB');
    expect(html).toContain('18 min');
    expect(html).not.toContain('Alice');
    expect(html).not.toContain('Bob');
  });

  it('pluralizes correctly for a single photo', () => {
    const html = renderScopePreviewCompactHtml(
      makeScope({ totalPhotos: 1, totalNotes: 0, totalMessages: 0 }),
    );
    expect(html).toMatch(/1\s+photo\b/);
  });

  it('handles zero photos gracefully', () => {
    const html = renderScopePreviewCompactHtml(
      makeScope({ totalPhotos: 0, totalNotes: 10, totalMessages: 5 }),
    );
    expect(html).toContain('0 photos');
    expect(html).toContain('10 notes');
  });
});

describe('renderScopePreviewFullHtml', () => {
  it('includes per-student breakdown + totals', () => {
    const html = renderScopePreviewFullHtml(makeScope());
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('1,000');
    expect(html).toContain('1,860');
    expect(html).toContain('145');
    expect(html).toContain('1.2 GB');
    expect(html).toContain('18 min');
  });

  it('escapes student names to defend against XSS', () => {
    const html = renderScopePreviewFullHtml(
      makeScope({
        perStudent: [
          { studentId: 'sid1', studentName: '<script>alert(1)</script>', photos: 5, notes: 1 },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('falls back to student-id prefix when name is missing', () => {
    const html = renderScopePreviewFullHtml(
      makeScope({
        perStudent: [{ studentId: 'sid-abcdefgh-99', photos: 5, notes: 1 }],
      }),
    );
    expect(html).toContain('sid-abcd');
  });
});

describe('renderWelcomeBackHtml', () => {
  const summary = {
    hasHistory: true,
    lastExportedAt: new Date('2026-07-15T12:00:00Z').getTime(),
    seenCounts: { photos: 2834, notes: 100, messages: 40 },
  };

  it('shows the last-exported date and total item counts', () => {
    const html = renderWelcomeBackHtml(summary, {
      primaryButtonId: 'welcome-refresh',
      primaryLabel: 'Get anything new since Jul 15',
    });
    // Date formatting depends on locale but should include "Jul" and "15".
    expect(html).toMatch(/Jul.*15|15.*Jul/);
    expect(html).toContain('2,834');
    expect(html).toContain('100');
    expect(html).toContain('40');
    expect(html).toContain('Get anything new since Jul 15');
    expect(html).toContain('id="welcome-refresh"');
  });

  it('returns empty string when there is no history', () => {
    expect(
      renderWelcomeBackHtml(
        { hasHistory: false, lastExportedAt: null, seenCounts: { photos: 0, notes: 0, messages: 0 } },
        { primaryButtonId: 'welcome-refresh', primaryLabel: 'Get new stuff' },
      ),
    ).toBe('');
  });

  it('returns empty string when hasHistory is true but lastExportedAt is null', () => {
    expect(
      renderWelcomeBackHtml(
        { hasHistory: true, lastExportedAt: null, seenCounts: { photos: 5, notes: 0, messages: 0 } },
        { primaryButtonId: 'welcome-refresh', primaryLabel: 'X' },
      ),
    ).toBe('');
  });

  it('escapes untrusted primary label content', () => {
    const html = renderWelcomeBackHtml(summary, {
      primaryButtonId: 'welcome-refresh',
      primaryLabel: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('renderResumeBannerHtml', () => {
  function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
    return {
      runId: 'r1',
      guardianId: 'g1',
      studentIds: ['s1'],
      seenObjectIds: { photos: ['p1', 'p2'], notes: ['n1'], messages: [] },
      startedAt: Date.now() - 3 * 60 * 60 * 1000,
      updatedAt: Date.now() - 3 * 60 * 60 * 1000,
      ...overrides,
    };
  }

  it('shows the age in hours and the total item count', () => {
    const html = renderResumeBannerHtml(makeCheckpoint());
    expect(html).toContain('3 hour');
    expect(html).toContain('3 item'); // 2 photos + 1 note
  });

  it('says "less than an hour ago" for a fresh checkpoint', () => {
    const html = renderResumeBannerHtml(
      makeCheckpoint({ updatedAt: Date.now() - 5 * 60 * 1000 }),
    );
    expect(html).toContain('less than an hour ago');
  });

  it('handles the singular-hour case', () => {
    const html = renderResumeBannerHtml(
      makeCheckpoint({ updatedAt: Date.now() - 90 * 60 * 1000 }),
    );
    // "1 hour ago" (singular)
    expect(html).toMatch(/1 hour ago/);
  });

  it('renders standard button ids for Resume / Discard', () => {
    const html = renderResumeBannerHtml(makeCheckpoint());
    expect(html).toContain('id="resume-btn"');
    expect(html).toContain('id="discard-btn"');
  });
});

describe('renderStudentListHtml (tab: full rows with id)', () => {
  it('renders one row per student with names + ids', () => {
    const html = renderStudentListHtml(
      ['sid1', 'sid2'],
      { sid1: 'Alice', sid2: 'Bob' },
    );
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('sid1');
    expect(html).toContain('sid2');
  });

  it('shows placeholder text when the roster is empty', () => {
    const html = renderStudentListHtml([], {});
    expect(html.toLowerCase()).toContain('no students');
  });

  it('escapes student names to defend against XSS', () => {
    const html = renderStudentListHtml(
      ['sid1'],
      { sid1: '<img src=x onerror=alert(1)>' },
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('renderStudentChipsHtml (popup: compact chips, no ids)', () => {
  it('renders a chip per student and elides ids', () => {
    const html = renderStudentChipsHtml(
      ['sid1', 'sid2'],
      { sid1: 'Alice', sid2: 'Bob' },
    );
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).not.toContain('sid1');
  });

  it('falls back to "Student <prefix>" when the name is missing', () => {
    const html = renderStudentChipsHtml(['sid-abcdefgh-1'], {});
    expect(html).toContain('sid-abcd');
  });

  it('escapes untrusted names', () => {
    const html = renderStudentChipsHtml(
      ['sid1'],
      { sid1: '<script>x</script>' },
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns an empty string when there are no students', () => {
    expect(renderStudentChipsHtml([], {})).toBe('');
  });
});
