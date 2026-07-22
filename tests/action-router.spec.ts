// TDD for the popup→tab action router. Kept as a pure `search-string ->
// action | null` predicate so both the popup (which builds URLs) and the
// tab (which parses them) can round-trip through the same source of truth.

import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  parseAction,
  buildActionUrl,
  isValidAction,
  planOpenTakeoutTab,
  type ExtensionContextLike,
  type PopupAction,
} from '@/lib/action-router';

describe('parseAction', () => {
  it('parses each known action', () => {
    for (const a of ACTIONS) {
      expect(parseAction(`?action=${a}`)).toBe(a);
    }
  });

  it('accepts a leading "?" or not', () => {
    expect(parseAction('action=quick-refresh')).toBe('quick-refresh');
    expect(parseAction('?action=quick-refresh')).toBe('quick-refresh');
  });

  it('returns null for missing/empty query', () => {
    expect(parseAction('')).toBeNull();
    expect(parseAction('?')).toBeNull();
    expect(parseAction('?foo=bar')).toBeNull();
  });

  it('returns null for a bogus action value', () => {
    expect(parseAction('?action=bogus')).toBeNull();
    expect(parseAction('?action=')).toBeNull();
  });

  it('ignores extra unrelated query params', () => {
    expect(parseAction('?utm=x&action=resume&foo=bar')).toBe('resume');
  });

  it('is case-sensitive (the popup always emits lowercase)', () => {
    expect(parseAction('?action=Quick-Refresh')).toBeNull();
  });
});

describe('isValidAction', () => {
  it('accepts every declared action', () => {
    for (const a of ACTIONS) {
      expect(isValidAction(a)).toBe(true);
    }
  });
  it('rejects anything else', () => {
    expect(isValidAction('nope')).toBe(false);
    expect(isValidAction('')).toBe(false);
    expect(isValidAction(null)).toBe(false);
    expect(isValidAction(undefined)).toBe(false);
  });
});

describe('planOpenTakeoutTab', () => {
  const TAKEOUT = 'src/takeout-page/takeout.html';
  const FULL = 'chrome-extension://abc/src/takeout-page/takeout.html?action=quick-start';

  it('creates a new tab when no takeout context is open', () => {
    expect(planOpenTakeoutTab([], 'quick-start', TAKEOUT, FULL)).toEqual({
      kind: 'create',
      url: FULL,
    });
  });

  it('creates a new tab when the only contexts are non-tab (popup / background / other)', () => {
    const ctx: ExtensionContextLike[] = [
      { contextType: 'POPUP', documentUrl: 'chrome-extension://abc/src/popup/popup.html', tabId: -1 },
      { contextType: 'BACKGROUND', tabId: -1 },
    ];
    expect(planOpenTakeoutTab(ctx, 'quick-refresh', TAKEOUT, FULL).kind).toBe('create');
  });

  it('focuses an existing takeout tab and carries the action so the tab can dispatch in-place', () => {
    // Focusing (not URL-updating) preserves any in-flight run — the tab
    // decides in-page whether to run the new action or ignore it.
    const ctx: ExtensionContextLike[] = [
      {
        contextType: 'TAB',
        documentUrl: 'chrome-extension://abc/src/takeout-page/takeout.html?action=customize',
        tabId: 42,
        windowId: 7,
      },
    ];
    expect(planOpenTakeoutTab(ctx, 'quick-refresh', TAKEOUT, FULL)).toEqual({
      kind: 'focus',
      tabId: 42,
      windowId: 7,
      action: 'quick-refresh',
    });
  });

  it('picks the first matching takeout tab when several are open (belt-and-suspenders)', () => {
    const ctx: ExtensionContextLike[] = [
      {
        contextType: 'TAB',
        documentUrl: 'chrome-extension://abc/src/takeout-page/takeout.html',
        tabId: 1,
        windowId: 1,
      },
      {
        contextType: 'TAB',
        documentUrl: 'chrome-extension://abc/src/takeout-page/takeout.html?action=customize',
        tabId: 2,
        windowId: 1,
      },
    ];
    const plan = planOpenTakeoutTab(ctx, 'quick-start', TAKEOUT, FULL);
    expect(plan.kind).toBe('focus');
    if (plan.kind === 'focus') expect(plan.tabId).toBe(1);
  });

  it('carries a null action when the popup opens the tab without one (customize link)', () => {
    const ctx: ExtensionContextLike[] = [
      {
        contextType: 'TAB',
        documentUrl: 'chrome-extension://abc/src/takeout-page/takeout.html',
        tabId: 99,
      },
    ];
    const plan = planOpenTakeoutTab(ctx, null, TAKEOUT, FULL);
    expect(plan.kind).toBe('focus');
    if (plan.kind === 'focus') expect(plan.action).toBeNull();
  });

  it('ignores unrelated extension pages (e.g. options page) — creates a new takeout tab', () => {
    const ctx: ExtensionContextLike[] = [
      {
        contextType: 'TAB',
        documentUrl: 'chrome-extension://abc/src/options/options.html',
        tabId: 5,
      },
    ];
    expect(planOpenTakeoutTab(ctx, 'quick-start', TAKEOUT, FULL).kind).toBe('create');
  });
});

describe('buildActionUrl', () => {
  it('returns the base path with ?action=<x>', () => {
    const url = buildActionUrl('quick-refresh', 'src/takeout-page/takeout.html');
    expect(url).toBe('src/takeout-page/takeout.html?action=quick-refresh');
  });

  it('round-trips through parseAction', () => {
    const actions: PopupAction[] = ['quick-refresh', 'quick-start', 'resume', 'customize'];
    for (const a of actions) {
      const url = buildActionUrl(a, 'x.html');
      const search = url.slice(url.indexOf('?'));
      expect(parseAction(search)).toBe(a);
    }
  });
});
