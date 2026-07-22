import { describe, expect, it } from 'vitest';
import { renderViewerDataJs, renderViewerHtml } from '@/scraper/viewer';

describe('renderViewerHtml', () => {
  it('emits a self-contained HTML page (no external asset references)', () => {
    const html = renderViewerHtml();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<link[^>]*href="https?:\/\//i);
    // The only <script src=...> is the sibling data.js — never an external URL.
    expect(html).not.toMatch(/<script[^>]*src="https?:\/\//i);
    expect(html).not.toMatch(/cdn\.jsdelivr|unpkg|cdnjs/i);
  });

  it('loads its data from the sidecar viewer/data.js (works offline + from file://)', () => {
    const html = renderViewerHtml();
    expect(html).toContain('<script src="./data.js"></script>');
    expect(html).toContain('window.__DATA__');
    // No fetch() — bypassing cross-origin blocks on file:// origins.
    expect(html).not.toContain("fetch('../notes.json')");
    expect(html).not.toContain("fetch('../messages.json')");
    expect(html).not.toContain("fetch('../photos/manifest.json')");
  });

  it('contains type filter + date-range filter + search + view toggle', () => {
    const html = renderViewerHtml();
    expect(html).toContain('id="filter-type"');
    expect(html).toContain('id="filter-from"');
    expect(html).toContain('id="filter-to"');
    expect(html).toContain('id="filter-q"'); // search box
    expect(html).toContain('id="view-timeline"');
    expect(html).toContain('id="view-gallery"');
  });

  it('has a lightbox for full-size photo viewing', () => {
    const html = renderViewerHtml();
    expect(html).toContain('id="lightbox"');
    expect(html).toContain('lb-close');
    expect(html).toMatch(/ArrowLeft|ArrowRight/); // keyboard nav
  });

  it('distinguishes empty-archive from empty-filter in the empty-state copy', () => {
    // Both messages exist and are distinct so a genuinely empty export
    // reads "This archive is empty" instead of "No entries match…" — the
    // latter is confusing when the user hasn't filtered anything.
    const html = renderViewerHtml();
    expect(html).toContain('This archive is empty');
    expect(html).toContain('No entries match the current filter');
  });

  it('debounces the free-text search input so keystrokes over a big archive do not thrash the DOM', () => {
    // A 5000+ item archive re-renders the entire timeline HTML string on
    // every keystroke without debounce — noticeably laggy in the wild. The
    // viewer inlines a small debouncer (delay > 0) around `filter-q`'s
    // input handler so mid-word typing doesn't fire the render pipeline
    // more often than ~10x/sec.
    const html = renderViewerHtml();
    // A `setTimeout / clearTimeout` pair anywhere in the inline script
    // proves the debounce is present; exact shape stays loose so a future
    // refactor doesn't have to churn the assertion.
    expect(html).toContain('setTimeout');
    expect(html).toContain('clearTimeout');
    // The debounced listener specifically targets filter-q (the free-text
    // search) — the discrete select/date filters are cheap and fire
    // immediately.
    expect(html).toMatch(/filter-q[\s\S]{0,200}addEventListener\([^)]*input/);
  });

  it('carries enriched header elements so the archive can show school + student context', () => {
    // The metadata orchestrator populates manifest.schools + student_profiles
    // and the viewer's shell needs the DOM anchors + inline JS to render them.
    const html = renderViewerHtml();
    expect(html).toContain('id="header-title"');
    expect(html).toContain('id="header-students"');
    // Inline script must read manifest.schools / student_profiles.
    expect(html).toContain('manifest.schools');
    expect(html).toContain('manifest.student_profiles');
  });
});

describe('renderViewerDataJs', () => {
  it('assigns to window.__DATA__ with all four sections', () => {
    const js = renderViewerDataJs({
      notes: [],
      messages: [],
      photos: [],
      manifest: {
        guardianId: 'g-1',
        studentIds: ['stu-a'],
        fetchedAt: '2026-07-21T00:00:00.000Z',
        counts: { notes: 0, messages: 0, photos: 0 },
        extensionVersion: '0.1.0',
      },
    });
    expect(js).toMatch(/^window\.__DATA__ = /);
    const payload = JSON.parse(js.replace(/^window\.__DATA__ = /, '').replace(/;\s*$/, ''));
    expect(payload).toHaveProperty('notes');
    expect(payload).toHaveProperty('messages');
    expect(payload).toHaveProperty('photos');
    expect(payload).toHaveProperty('manifest.guardianId', 'g-1');
  });

  it('escapes </script inside body payloads so the JS block never breaks out', () => {
    const js = renderViewerDataJs({
      notes: [{
        object_id: 'n1',
        // deliberately try to break out of the <script> block
        note: 'attempt </SCRIPT> to break out',
        event_date: '2026-01-01T00:00:00Z',
      } as never],
      messages: [],
      photos: [],
      manifest: {
        guardianId: 'g-1',
        studentIds: [],
        fetchedAt: '2026-01-01T00:00:00Z',
        counts: { notes: 1, messages: 0, photos: 0 },
      },
    });
    // Must NOT contain the literal </script (case-insensitive) — that would
    // close the enclosing <script> block in index.html.
    expect(js).not.toMatch(/<\/script/i);
    // Must contain the escaped form.
    expect(js).toMatch(/<\\\/script/i);
  });

  it('round-trips through JSON.parse to the exact input (aside from the </script escape)', () => {
    const input = {
      notes: [{ object_id: 'n', event_date: '2026-07-01T00:00:00Z', note: 'hi' } as never],
      messages: [{ object_id: 'm', created_at: '2026-07-02T00:00:00Z', body: 'yo' } as never],
      photos: [{ file: 'p.jpg', object_id: 'p', event_date: '2026-07-03T00:00:00Z', note: null }],
      manifest: {
        guardianId: 'g',
        studentIds: ['s'],
        fetchedAt: '2026-07-21T00:00:00Z',
        counts: { notes: 1, messages: 1, photos: 1 },
      },
    };
    const js = renderViewerDataJs(input);
    const parsed = JSON.parse(js.replace(/^window\.__DATA__ = /, '').replace(/;\s*$/, ''));
    expect(parsed).toEqual(input);
  });
});
