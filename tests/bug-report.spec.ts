// TDD for the bug-report URL builder — pure fn, no DOM.
import { describe, expect, it } from 'vitest';
import { buildBugReportUrl } from '@/lib/bug-report';

const REPO_ISSUES = 'https://github.com/ChaseBro/brightwheel-takeout/issues/new';

describe('buildBugReportUrl', () => {
  it('targets the extension\'s own GitHub issues page', () => {
    const url = buildBugReportUrl({
      errorMessage: 'x',
      extensionVersion: '0.1.0',
      userAgent: 'ua',
      logTail: '',
    });
    expect(url.startsWith(REPO_ISSUES + '?')).toBe(true);
  });

  it('puts the (truncated) error into the title', () => {
    const url = new URL(buildBugReportUrl({
      errorMessage: 'Something bad happened at /api/v1/foo/bar',
      extensionVersion: '0.1.0',
      userAgent: 'ua',
      logTail: '',
    }));
    const title = url.searchParams.get('title');
    expect(title).toContain('bug');
    expect(title).toContain('Something bad happened');
  });

  it('truncates a monster error message so the URL stays under GitHub\'s ~8000-char cap', () => {
    const url = buildBugReportUrl({
      errorMessage: 'a'.repeat(5000),
      extensionVersion: '0.1.0',
      userAgent: 'ua',
      logTail: '',
    });
    // Empirical GH web-form limit is around 8192; safe headroom.
    expect(url.length).toBeLessThan(7500);
  });

  it('body includes what-happened placeholder, environment, and code-fenced log tail', () => {
    const url = new URL(buildBugReportUrl({
      errorMessage: '404 on /api/foo',
      extensionVersion: '0.1.2',
      userAgent: 'Mozilla/5.0 Test',
      logTail: 'line1\nline2\nline3',
    }));
    const body = url.searchParams.get('body') ?? '';
    expect(body).toMatch(/what.*doing/i);           // steps-to-repro placeholder
    expect(body).toContain('0.1.2');                 // version
    expect(body).toContain('Mozilla/5.0 Test');      // user agent
    expect(body).toContain('404 on /api/foo');       // error
    expect(body).toContain('```');                   // code fence
    expect(body).toContain('line1');                 // log content
  });

  it('caps the log tail so a huge log doesn\'t blow the URL limit', () => {
    const url = buildBugReportUrl({
      errorMessage: 'x',
      extensionVersion: '0.1.0',
      userAgent: 'ua',
      logTail: 'y'.repeat(20000),
    });
    // Final URL should still fit under GH's limit.
    expect(url.length).toBeLessThan(7500);
    // And should mark truncation so the user knows.
    expect(decodeURIComponent(url)).toMatch(/truncated/i);
  });

  it('handles a null/empty log tail without crashing', () => {
    expect(() =>
      buildBugReportUrl({
        errorMessage: '',
        extensionVersion: '0.1.0',
        userAgent: 'ua',
        logTail: '',
      }),
    ).not.toThrow();
  });

  it('applies the "bug" label so triage is trivial', () => {
    const url = new URL(buildBugReportUrl({
      errorMessage: 'x',
      extensionVersion: '0.1.0',
      userAgent: 'ua',
      logTail: '',
    }));
    expect(url.searchParams.get('labels')).toBe('bug');
  });
});
