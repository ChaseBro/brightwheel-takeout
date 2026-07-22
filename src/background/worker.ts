// MV3 service worker.
//
// Responsibilities:
//  - Answer the popup's "what's the status" question (is BW logged in? do we
//    have a session snapshot?).
//  - Open the takeout page when the popup asks.
//  - Bridge progress messages from the running scraper to the takeout page.
//  - In dev mode, keep an open WebSocket to the dev-server so we get
//    chrome.runtime.reload() on rebuild.
//
// The actual run happens inside the takeout page (a normal tab, not the SW),
// because MV3 service workers die after ~30s idle and a full export takes
// tens of minutes. The takeout page owns the WritableStream (only pages can
// call showSaveFilePicker) and pipes progress back through chrome.runtime.

import {
  discoverFromOpenTab,
  getStoredSession,
  hasBrightwheelCookie,
  saveSession,
  type DiscoveredSession,
} from '@/lib/session.js';
import { BwClient } from '@/scraper/bw-client.js';
import { discoverRoster } from '@/scraper/discovery.js';
import { log } from '@/lib/log.js';

const DEV_WS_URL = 'ws://localhost:37173';
const IS_DEV =
  // Vite exposes this via import.meta; the type declaration path is thin.
  (typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE !== 'production') ||
  false;

/**
 * Enrich a raw content-script session with the full student roster + message
 * threads from the guardian API. Merges over `session` in-place-ish — returns
 * a new object, saves to storage, and never throws (any failure is logged and
 * the un-enriched session is returned instead, so the popup still works).
 */
async function enrichSession(session: DiscoveredSession): Promise<DiscoveredSession> {
  // clientUuid + csrfToken are required to call the guardian API. userUuid is
  // discovered by discovery.ts itself (from /api/v1/users/me), so we don't
  // need it up front — the client sends the x-user-uuid header only once it's
  // known.
  if (!session.csrfToken || !session.clientUuid) return session;
  try {
    const client = new BwClient({
      clientUuid: session.clientUuid,
      userUuid: session.userUuid ?? '',
      csrfToken: session.csrfToken,
      studentId: session.studentIds[0],
      clientVersion: session.clientVersion,
      userAgent: session.userAgent,
    });
    // Note: discoverRoster's internals (fetchGuardianCurrent / fetchMessageThreads)
    // now call client.updateUserUuid inline so we don't need to seed it here.
    const roster = await discoverRoster(
      client,
      { guardianId: session.guardianId, studentIds: session.studentIds },
      log,
    );
    const merged: DiscoveredSession = {
      ...session,
      guardianId: roster.guardianId ?? session.guardianId,
      userUuid: roster.guardianId ?? session.userUuid,
      studentIds: roster.students.map((s) => s.studentId),
      studentNames: Object.fromEntries(roster.students.map((s) => [s.studentId, s.displayName])),
      threadIds: roster.threadIds,
      // M4: pass any partial-discovery warnings through so the takeout
      // page can surface a banner. Explicitly clearing when there are
      // none so a prior warning from a previous discovery doesn't linger.
      ...(roster.warnings && roster.warnings.length > 0
        ? { discoveryWarning: { steps: roster.warnings } }
        : { discoveryWarning: undefined }),
    };
    for (const sid of session.studentIds) {
      if (!merged.studentIds.includes(sid)) merged.studentIds.push(sid);
    }
    await saveSession(merged);
    return merged;
  } catch (err) {
    log.warn(`enrichSession failed: ${(err as Error).message}`);
    return session;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'bw-takeout:status': {
        const hasCookie = await hasBrightwheelCookie();
        let session = await getStoredSession();
        if (!session && hasCookie) {
          session = await discoverFromOpenTab();
        }
        // Enrich if we have a session but no roster yet (threadIds
        // unpopulated OR studentNames missing). Cached enrichment survives.
        if (session && (!session.threadIds || !session.studentNames)) {
          session = await enrichSession(session);
        }
        sendResponse({ hasCookie, session });
        return;
      }
      case 'bw-takeout:open-takeout-page': {
        const url = chrome.runtime.getURL('src/takeout-page/takeout.html');
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
        return;
      }
      case 'bw-takeout:refresh-session': {
        let session = await discoverFromOpenTab();
        if (session) session = await enrichSession(session);
        sendResponse({ session });
        return;
      }
      default:
        sendResponse({ ok: false, error: `unknown message: ${msg?.type}` });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: (err as Error).message ?? String(err) });
  });
  return true; // keep the port open for the async sendResponse
});

// Keep-alive port so long runs in the takeout page don't let Chrome kill us
// mid-fetch. The takeout page opens a Port on mount.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'bw-takeout:keepalive') {
    port.onDisconnect.addListener(() => {
      /* takeout tab closed — the SW will idle-out normally */
    });
  }
});

// Dev-mode hot reload. Wraps in a try because ws:// is blocked outside dev
// (host_permissions don't cover it) and we want a silent no-op in prod.
if (IS_DEV) {
  try {
    const ws = new WebSocket(DEV_WS_URL);
    ws.addEventListener('message', (ev) => {
      if (ev.data === 'reload') {
        chrome.runtime.reload();
      }
    });
    ws.addEventListener('error', () => {
      // dev server not running yet — quietly retry once a bit later
    });
  } catch {
    // ignore
  }
}
