// Popup → takeout-tab handoff.
//
// The popup is Chrome's compact "action layer" — it dies on focus loss (a
// native file picker will kill it before the user picks a folder), and it
// can't host the multi-minute run loop. So every popup CTA opens the takeout
// tab with a `?action=<name>` search param encoding the intent, and the tab
// dispatches on that param during boot.
//
// Kept as a pure module (no chrome.* imports) so the tab can unit-test the
// parse side and the popup can unit-test the build side without a fake
// browser environment.

export const ACTIONS = ['quick-refresh', 'quick-start', 'resume', 'customize'] as const;
export type PopupAction = (typeof ACTIONS)[number];

export function isValidAction(v: unknown): v is PopupAction {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

/**
 * Parse the current URL's `?action=<x>` param, returning a validated
 * PopupAction or null. Accepts a raw search string with or without the
 * leading `?` so callers can pass either `window.location.search` or a
 * pre-stripped substring.
 */
export function parseAction(search: string): PopupAction | null {
  const s = search.startsWith('?') ? search.slice(1) : search;
  if (!s) return null;
  const params = new URLSearchParams(s);
  const raw = params.get('action');
  return isValidAction(raw) ? raw : null;
}

/**
 * Build the URL the popup should send `chrome.tabs.create` to. Kept as a
 * plain string builder so the popup can pass it straight to
 * `chrome.runtime.getURL` if it wants an extension-absolute URL, or use it
 * relatively for tests.
 */
export function buildActionUrl(action: PopupAction, basePath: string): string {
  return `${basePath}?action=${action}`;
}

// ---- Single-instance tab reuse -------------------------------------------
//
// Two rapid clicks on the popup CTA used to open two takeout tabs, both
// racing on the same IndexedDB checkpoint. Since the takeout run is meant
// to be single-instance-per-guardian, the popup should focus an existing
// takeout tab instead of spawning a competing one.
//
// `planOpenTakeoutTab` is a pure function over the MV3
// `chrome.runtime.getContexts()` result so we can unit-test the decision
// without a fake browser.

/** Minimal shape of a `chrome.ExtensionContext` from `chrome.runtime.getContexts`. */
export interface ExtensionContextLike {
  contextType?: string;
  documentUrl?: string;
  tabId?: number;
  windowId?: number;
}

export type OpenTabPlan =
  | { kind: 'focus'; tabId: number; windowId?: number; action: PopupAction | null }
  | { kind: 'create'; url: string };

/**
 * Decide whether the popup should focus an existing takeout tab or create a
 * new one. `takeoutPagePath` is the path component we look for in each
 * context's documentUrl (case-insensitive match against the tail so both
 * `chrome-extension://<id>/src/takeout-page/takeout.html?action=x` and the
 * bare path used in tests hit).
 *
 * When focusing an existing tab we return the action so the popup can send
 * an in-page message telling that tab to dispatch — a URL-navigate would
 * clobber any in-flight run.
 */
export function planOpenTakeoutTab(
  contexts: readonly ExtensionContextLike[],
  action: PopupAction | null,
  takeoutPagePath: string,
  fullUrl: string,
): OpenTabPlan {
  const needle = takeoutPagePath.toLowerCase();
  const match = contexts.find(
    (c) =>
      c.contextType === 'TAB' &&
      typeof c.tabId === 'number' &&
      typeof c.documentUrl === 'string' &&
      c.documentUrl.toLowerCase().includes(needle),
  );
  if (match && typeof match.tabId === 'number') {
    const plan: OpenTabPlan = { kind: 'focus', tabId: match.tabId, action };
    if (typeof match.windowId === 'number') plan.windowId = match.windowId;
    return plan;
  }
  return { kind: 'create', url: fullUrl };
}
