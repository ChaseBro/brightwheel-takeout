// Popup — the compact "action layer".
//
// Chrome popups die on focus loss (a native file picker will close it before
// the user picks a folder) and can't host a multi-minute run loop. So this
// popup's job is to DECIDE the intent — quick-refresh / quick-start /
// resume / customize — then hand off to the takeout tab via
// chrome.tabs.create('...?action=<x>'). The tab dispatches on the param at
// boot and drives the real folder pick + export.
//
// All rendering lives in `src/lib/takeout-render.ts` so this file and the
// takeout tab share one source of truth. All intent parsing lives in
// `src/lib/action-router.ts` so the URL contract is testable.
//
// State machine (top-level):
//   loading  →  not-logged-in  |  need-refresh  |  ready
//   ready with checkpoint      →  Resume + Discard (primary)
//   ready with history         →  Get-what's-new (primary) + Full re-export
//   ready without either       →  Download-everything (primary)

import { $ } from '@/lib/dom.js';
import { sendMessage } from '@/lib/messaging.js';
import {
  buildActionUrl,
  planOpenTakeoutTab,
  type ExtensionContextLike,
  type PopupAction,
} from '@/lib/action-router.js';
import {
  renderScopePreviewCompactHtml,
  renderStudentChipsHtml,
  renderWelcomeBackHtml,
  renderResumeBannerHtml,
  formatShortDate,
} from '@/lib/takeout-render.js';
import { loadHistory, summarize, type LocalHistory } from '@/lib/local-history.js';
import { loadCheckpoint, clearCheckpoint, type Checkpoint } from '@/lib/checkpoint.js';
import { previewScope, type ScopePreview } from '@/scraper/preview.js';
import { BwClient } from '@/scraper/bw-client.js';
import type { Session } from '@/scraper/types.js';

const TAKEOUT_PAGE = 'src/takeout-page/takeout.html';
/** Checkpoints older than this are treated as stale — see takeout.ts. */
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StatusResponse {
  hasCookie: boolean;
  session?: (Partial<Session> & {
    csrfToken?: string | null;
    guardianId?: string | null;
    studentNames?: Record<string, string>;
  }) | null;
}

// ---- Handoff --------------------------------------------------------------

/**
 * Hand off the current intent to the takeout tab. If a takeout tab is
 * already open, focus it and message it the new action — a URL-navigate
 * would clobber any in-flight run. Otherwise create a new tab.
 *
 * Rationale: two rapid popup clicks used to spawn two takeout tabs racing
 * on the same IndexedDB checkpoint. `chrome.runtime.getContexts()` (MV3,
 * Chrome 116+) is the permission-free way to enumerate our own tabs.
 */
function openTab(action: PopupAction | null): void {
  const path = action ? buildActionUrl(action, TAKEOUT_PAGE) : TAKEOUT_PAGE;
  const url = chrome.runtime.getURL(path);
  void (async () => {
    let contexts: ExtensionContextLike[] = [];
    try {
      // The Chrome enum is required for typing but we only need the string
      // value at runtime; cast keeps the popup building even if @types/chrome
      // is temporarily out of sync with runtime.
      const raw = await chrome.runtime.getContexts?.({
        contextTypes: ['TAB' as chrome.runtime.ContextType],
      });
      if (Array.isArray(raw)) contexts = raw as ExtensionContextLike[];
    } catch {
      // getContexts is Chrome 116+; a rejection here means we fall through
      // to the create-a-new-tab path (safe default, matches pre-fix behavior).
    }
    const plan = planOpenTakeoutTab(contexts, action, TAKEOUT_PAGE, url);
    if (plan.kind === 'focus') {
      try {
        await chrome.tabs.update(plan.tabId, { active: true });
        if (typeof plan.windowId === 'number') {
          try {
            await chrome.windows.update(plan.windowId, { focused: true });
          } catch {
            /* another window may have closed between query and update */
          }
        }
        if (plan.action) {
          // Fire-and-forget — the tab decides whether to run (idle) or
          // ignore (run in flight).
          try {
            await chrome.tabs.sendMessage(plan.tabId, {
              type: 'bw-takeout:dispatch-action',
              action: plan.action,
            });
          } catch {
            /* tab may have closed between focus and message; harmless */
          }
        }
        window.close();
        return;
      } catch {
        // Falls through to create-a-new-tab if focus failed for any reason.
      }
    }
    chrome.tabs.create({ url }, () => window.close());
  })();
}

// ---- Status / session -----------------------------------------------------

function getStatus(): Promise<StatusResponse> {
  return sendMessage<StatusResponse>({ type: 'bw-takeout:status' });
}

type SessionState = 'not-logged-in' | 'need-refresh' | 'ready';

function classifySession(s: StatusResponse): SessionState {
  if (!s.hasCookie) return 'not-logged-in';
  if (!s.session || !s.session.csrfToken || !s.session.guardianId) return 'need-refresh';
  return 'ready';
}

function renderStatusLine(s: StatusResponse, state: SessionState): void {
  const box = $<HTMLDivElement>('status');
  if (!box) return;
  box.classList.remove('status--loading', 'status--ok', 'status--warn', 'status--error');
  if (state === 'not-logged-in') {
    box.classList.add('status--warn');
    box.innerHTML = 'Please <strong>open Brightwheel and log in</strong>, then reopen this popup.';
    return;
  }
  if (state === 'need-refresh') {
    box.classList.add('status--warn');
    box.innerHTML =
      'Session detected, but headers are missing. <strong>Refresh your Brightwheel tab</strong>, then click Retry.';
    return;
  }
  // ready
  const students = s.session?.studentIds ?? [];
  const names = s.session?.studentNames ?? {};
  box.classList.add('status--ok');
  if (students.length === 0) {
    box.innerHTML = 'Signed in — no children detected yet.';
    return;
  }
  // Prefer child first names — a parent recognises "Alice, Bob" much faster
  // than "guardian 4a2b1c9d…". Fall back to the count if names are missing
  // (rare — enrichSession always populates studentNames on a happy path).
  const firstNames = students
    .map((sid) => (names[sid] ?? '').trim().split(/\s+/)[0] ?? '')
    .filter((n) => n.length > 0);
  if (firstNames.length === students.length) {
    const listed = firstNames.map(escapeText).join(', ');
    box.innerHTML = `Signed in — ready to export for <strong>${listed}</strong>.`;
    return;
  }
  const kids = `${students.length} ${students.length === 1 ? 'child' : 'children'}`;
  box.innerHTML = `Signed in — ready to export for <strong>${kids}</strong>.`;
}

function renderStudents(s: StatusResponse): void {
  const el = $<HTMLDivElement>('students');
  if (!el) return;
  const ids = s.session?.studentIds ?? [];
  const names = s.session?.studentNames ?? {};
  const html = renderStudentChipsHtml(ids, names);
  if (!html) {
    el.hidden = true;
    return;
  }
  el.innerHTML = html;
  el.hidden = false;
}

/**
 * Minimal HTML escape for the status line — enough to keep an untrusted
 * facility name from injecting markup. The shared render helpers already
 * escape their own inputs, so this is only for values we still template
 * inline here.
 */
function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ---- Scope preview --------------------------------------------------------

async function refreshScopePreview(status: StatusResponse): Promise<void> {
  const el = $<HTMLDivElement>('scope-preview');
  if (!el) return;
  const s = status.session;
  if (!s || !s.csrfToken || !s.clientUuid || !s.guardianId) {
    el.classList.add('scope-preview--hidden');
    return;
  }
  el.classList.remove('scope-preview--hidden');
  el.className = 'scope-preview scope-preview--loading';
  el.innerHTML =
    '<span class="scope-preview__spinner" aria-hidden="true"></span> Peeking at Brightwheel…';
  try {
    const client = new BwClient(
      {
        clientUuid: s.clientUuid,
        userUuid: s.userUuid ?? s.guardianId,
        csrfToken: s.csrfToken,
        studentId: (s.studentIds ?? [])[0],
        clientVersion: s.clientVersion,
        userAgent: s.userAgent,
      },
      { refreshCsrf: refreshCsrfFromSw },
    );
    const scope = await previewScope(client, {
      guardianId: s.guardianId,
      studentIds: s.studentIds ?? [],
      threadIds: s.threadIds ?? [],
      studentNames: s.studentNames ?? {},
    });
    renderScope(scope);
  } catch {
    // The tab will do a full peek; failing quietly here is fine.
    el.className = 'scope-preview scope-preview--error';
    el.textContent = "Couldn't peek — the export will still work.";
  }
}

function renderScope(scope: ScopePreview): void {
  const el = $<HTMLDivElement>('scope-preview');
  if (!el) return;
  el.className = 'scope-preview';
  el.innerHTML = renderScopePreviewCompactHtml(scope);
}

async function refreshCsrfFromSw(): Promise<string | undefined> {
  try {
    const r = await sendMessage<{ session?: { csrfToken?: string | null } } | undefined>({
      type: 'bw-takeout:refresh-session',
    });
    return r?.session?.csrfToken ?? undefined;
  } catch {
    return undefined;
  }
}

// ---- CTA stack ------------------------------------------------------------

interface CtaContext {
  status: StatusResponse;
  history: LocalHistory | null;
  checkpoint: Checkpoint | null;
}

function renderCtas(ctx: CtaContext, state: SessionState): void {
  const stack = $<HTMLDivElement>('cta-stack');
  const customizeLink = $<HTMLAnchorElement>('customize-link');
  if (!stack) return;
  stack.innerHTML = '';
  if (customizeLink) customizeLink.hidden = true;

  if (state === 'not-logged-in') {
    const openBw = button('Open Brightwheel', 'btn--gold', () => {
      chrome.tabs.create({ url: 'https://schools.mybrightwheel.com' }, () => window.close());
    });
    stack.appendChild(openBw);
    return;
  }
  if (state === 'need-refresh') {
    const retry = button('Retry detection', 'btn--gold', () => {
      chrome.runtime.sendMessage({ type: 'bw-takeout:refresh-session' }, () => void refresh());
    });
    stack.appendChild(retry);
    return;
  }

  // state === 'ready' from here down.
  const guardianId = ctx.status.session!.guardianId!;
  const cp = ctx.checkpoint;
  const summary = ctx.history ? summarize(ctx.history, guardianId) : null;

  // Priority 1: an unfinished export dominates the layer — you almost
  // certainly meant to finish that, not start a new one.
  if (cp) {
    renderResumeCta(stack, cp);
    if (customizeLink) customizeLink.hidden = false;
    return;
  }

  // Priority 2: a returning user with history — offer the incremental as
  // the primary and a full re-export as the secondary.
  if (summary?.hasHistory && summary.lastExportedAt) {
    renderWelcomeCta(stack, summary);
    if (customizeLink) customizeLink.hidden = false;
    return;
  }

  // Priority 3: first-time / no-history — the fat "download everything"
  // button is the primary. Customize is the only secondary.
  const start = button('Download everything to a folder', 'btn--gold', () =>
    openTab('quick-start'),
  );
  stack.appendChild(start);
  if (customizeLink) customizeLink.hidden = false;
}

function renderResumeCta(stack: HTMLDivElement, cp: Checkpoint): void {
  const box = $<HTMLDivElement>('resume-panel');
  if (box) {
    box.classList.remove('resume-panel--hidden');
    box.innerHTML = renderResumeBannerHtml(cp);
    // Wire the buttons the shared render helper emitted (ids: resume-btn,
    // discard-btn). Resume opens the tab with ?action=resume so the checkpoint
    // + fresh folder-pick both flow through the tab's boot handler.
    $<HTMLButtonElement>('resume-btn')?.addEventListener('click', () => openTab('resume'));
    $<HTMLButtonElement>('discard-btn')?.addEventListener('click', async () => {
      await clearCheckpoint();
      await refresh();
    });
  }
  // Stack stays empty — the banner IS the primary in this state.
  stack.innerHTML = '';
}

function renderWelcomeCta(
  stack: HTMLDivElement,
  summary: { hasHistory: boolean; lastExportedAt: number | null; seenCounts: { photos: number; notes: number; messages: number } },
): void {
  const welcome = $<HTMLDivElement>('welcome-back');
  const lastDisplay = summary.lastExportedAt ? formatShortDate(summary.lastExportedAt) : '';
  if (welcome) {
    welcome.classList.remove('welcome-panel--hidden');
    welcome.innerHTML = renderWelcomeBackHtml(summary, {
      primaryButtonId: 'welcome-refresh',
      primaryLabel: `Get anything new since ${lastDisplay}`,
    });
    $<HTMLButtonElement>('welcome-refresh')?.addEventListener('click', () =>
      openTab('quick-refresh'),
    );
  }
  // The banner has the primary; the stack holds a compact secondary.
  const reExport = button('Full re-export…', 'btn--outline btn--block', () => openTab('quick-start'));
  stack.appendChild(reExport);
}

function button(label: string, klass: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = `btn ${klass}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// ---- Boot -----------------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    const status = await getStatus();
    const state = classifySession(status);
    renderStatusLine(status, state);
    // Chips + preview only make sense with a real session.
    if (state === 'ready') {
      renderStudents(status);
      void refreshScopePreview(status);
    } else {
      const chips = $<HTMLDivElement>('students');
      if (chips) chips.hidden = true;
      const scope = $<HTMLDivElement>('scope-preview');
      if (scope) scope.classList.add('scope-preview--hidden');
    }

    // Load history + checkpoint for CTA decisions. Both are best-effort; a
    // storage error should still render a usable popup.
    let history: LocalHistory | null = null;
    let checkpoint: Checkpoint | null = null;
    if (state === 'ready') {
      try {
        history = await loadHistory();
      } catch {
        history = null;
      }
      try {
        const cp = await loadCheckpoint();
        if (
          cp &&
          Date.now() - cp.updatedAt < CHECKPOINT_MAX_AGE_MS &&
          cp.guardianId === status.session?.guardianId
        ) {
          checkpoint = cp;
        }
      } catch {
        checkpoint = null;
      }
    }

    // Hide the resume/welcome panels if state doesn't warrant them (they'll
    // be re-populated by renderCtas as needed).
    const resumeBox = $<HTMLDivElement>('resume-panel');
    if (resumeBox) {
      resumeBox.classList.add('resume-panel--hidden');
      resumeBox.innerHTML = '';
    }
    const welcomeBox = $<HTMLDivElement>('welcome-back');
    if (welcomeBox) {
      welcomeBox.classList.add('welcome-panel--hidden');
      welcomeBox.innerHTML = '';
    }

    renderCtas({ status, history, checkpoint }, state);
  } catch (err) {
    const box = $<HTMLDivElement>('status');
    if (box) {
      box.classList.remove('status--loading', 'status--ok', 'status--warn');
      box.classList.add('status--error');
      box.textContent = `Extension error: ${(err as Error).message}`;
    }
  }
}

function fillVersion(): void {
  const el = $<HTMLSpanElement>('version');
  if (!el) return;
  try {
    el.textContent = chrome.runtime.getManifest().version;
  } catch {
    el.textContent = '?';
  }
}

$('customize-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  openTab('customize');
});

$('detect-only-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  // Same intent as before: open the takeout page in detection-only mode.
  chrome.tabs.create(
    { url: chrome.runtime.getURL(`${TAKEOUT_PAGE}?mode=detect`) },
    () => window.close(),
  );
});

fillVersion();
void refresh();
