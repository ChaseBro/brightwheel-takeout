// Pre-fill a GitHub issue with the user's error + environment + log tail so
// "Report to developer" is a two-click flow (error panel → issue form). Kept
// as a pure function so the URL-length math and truncation are unit-testable
// without any DOM.

const REPO = 'ChaseBro/brightwheel-takeout';
const ISSUES_URL = `https://github.com/${REPO}/issues/new`;

// GitHub's issue-form web endpoint quietly truncates at ~8192. Leave a
// generous cushion for the origin/path/other params so the final URL is
// always well under the cap.
const MAX_URL = 7500;
const MAX_TITLE_ERROR = 80;
// The two variable pieces (error inside body + log tail) share the remainder.
// Log tail is the fatter one; slice it to a safe fixed budget first, then
// let the rest float.
const LOG_TAIL_BUDGET = 4000;

export interface BugReport {
  errorMessage: string;
  extensionVersion: string;
  userAgent: string;
  logTail: string;
}

function truncate(s: string, max: number, marker = '\n… (truncated)'): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - marker.length)) + marker;
}

function buildTitle(err: string): string {
  const shortErr = err.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_ERROR);
  return shortErr ? `[bug] ${shortErr}` : '[bug]';
}

function buildBody(r: BugReport): string {
  const cappedLog = truncate(r.logTail || '(empty)', LOG_TAIL_BUDGET);
  return [
    '## What I was doing',
    '(please describe the steps — helps a lot to know what you clicked before it broke)',
    '',
    '## Error',
    '```',
    r.errorMessage || '(no error message)',
    '```',
    '',
    '## Environment',
    `- extension version: ${r.extensionVersion}`,
    `- user agent: ${r.userAgent}`,
    '',
    '## Diagnostic log (last few hundred lines)',
    '```',
    cappedLog,
    '```',
  ].join('\n');
}

export function buildBugReportUrl(r: BugReport): string {
  const url = new URL(ISSUES_URL);
  url.searchParams.set('labels', 'bug');
  url.searchParams.set('title', buildTitle(r.errorMessage));
  url.searchParams.set('body', buildBody(r));
  let s = url.toString();
  // If we still overshoot (very long error + very long UA), shrink the body
  // further by dropping the log tail entirely.
  if (s.length > MAX_URL) {
    const shrunk = new URL(ISSUES_URL);
    shrunk.searchParams.set('labels', 'bug');
    shrunk.searchParams.set('title', buildTitle(r.errorMessage));
    shrunk.searchParams.set(
      'body',
      buildBody({ ...r, logTail: '(log truncated for URL length; use Copy diagnostic log)' }),
    );
    s = shrunk.toString();
  }
  return s;
}
