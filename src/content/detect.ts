// Ensure TypeScript treats this file as a module (it has no explicit
// exports otherwise — every symbol is a side-effect on the tab).
export {};

// Content script injected on schools.mybrightwheel.com pages.
//
// Reads what the extension needs from the BW SPA's localStorage:
//   - `csrf_token`           -> x-csrf-token header
//   - `bw-client-identifier` -> x-client-uuid header
// The guardian's user_uuid is discovered SW-side via /api/v1/users/me (see
// `scraper/discovery.ts`) — the content script only reports what URL/local
// storage happen to expose, and lets the SW enrich.

interface DetectPayload {
  csrfToken: string | null;
  clientUuid: string | null;
  userUuid: string | null;
  guardianId: string | null;
  studentIds: string[];
  threadIds: string[];
  clientVersion: string | null;
  userAgent: string;
  discoveredAt: number;
}

function getMeta(name: string): string | null {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el?.getAttribute('content') ?? null;
}

function detect(): DetectPayload {
  const csrfToken = localStorage.getItem('csrf_token');
  const clientUuid = localStorage.getItem('bw-client-identifier');

  // Best-effort student id from the current URL (`/children/{id}` or
  // `/students/{id}`). Not required — the SW discovers the full roster.
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  let studentFromUrl: string | null = null;
  for (let i = 0; i < pathParts.length; i++) {
    const seg = pathParts[i];
    if (
      (seg === 'children' || seg === 'students') &&
      pathParts[i + 1] &&
      pathParts[i + 1] !== 'list'
    ) {
      studentFromUrl = pathParts[i + 1] ?? null;
    }
  }
  const studentIds: string[] = studentFromUrl ? [studentFromUrl] : [];
  const clientVersion = getMeta('appVersion');

  return {
    csrfToken,
    clientUuid,
    userUuid: null,
    guardianId: null,
    studentIds,
    threadIds: [],
    clientVersion,
    userAgent: navigator.userAgent,
    discoveredAt: Date.now(),
  };
}

// Cache the last snapshot in chrome.storage.session so the SW can read it
// without round-tripping through the tab every time.
async function saveDiscovery(payload: DetectPayload): Promise<void> {
  try {
    if (chrome?.storage?.session) {
      await chrome.storage.session.set({ 'bw-takeout:last-discovery': payload });
    }
  } catch {
    // best-effort
  }
}

// Answer discovery requests from the background service worker.
chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'bw-takeout:discover') {
    const payload = detect();
    void saveDiscovery(payload);
    sendResponse({
      session: {
        guardianId: payload.guardianId,
        clientUuid: payload.clientUuid,
        userUuid: payload.userUuid,
        csrfToken: payload.csrfToken,
        studentIds: payload.studentIds,
        threadIds: payload.threadIds,
        clientVersion: payload.clientVersion,
        userAgent: payload.userAgent,
        discoveredAt: payload.discoveredAt,
        source: 'content-script',
      },
    });
    return true; // async sendResponse
  }
  return undefined;
});

// Kick a discovery on load so the SW has something to read even before the
// popup opens for the first time.
void saveDiscovery(detect());
