// Session discovery for the Brightwheel API.
//
// The browser sends the session cookie automatically (our host_permissions
// cover schools.mybrightwheel.com). CSRF and the client UUID come from the
// SPA's localStorage — the content script reads them; the SW caches the
// snapshot in chrome.storage.local. The user's own object_id (== guardian_id
// in this API) is fetched SW-side via GET /api/v1/users/me by discovery.ts.

const STORAGE_KEY = 'bw-takeout:session';
// Bump this any time DiscoveredSession's shape changes or a discovery bug
// ships. On read, a stored blob with a mismatched version is deleted and
// treated as absent — the SW re-runs discovery and populates the current
// shape. Self-cleaning: no versioned key suffixes accumulate in storage.
const SCHEMA_VERSION = 2;

export interface DiscoveredSession {
  guardianId: string;
  clientUuid: string;
  userUuid: string | null;
  csrfToken: string;
  studentIds: string[];
  /** Student display names keyed by student id — populated by SW discovery. */
  studentNames?: Record<string, string>;
  threadIds?: string[];
  clientVersion?: string;
  userAgent?: string;
  discoveredAt: number;
  source: 'content-script';
  schemaVersion?: number;
  /**
   * Partial-discovery reasons (M4). Non-null when a discovery call fell back
   * to an empty list due to a real error (5xx / network) rather than genuine
   * emptiness. The takeout page renders a banner so parents see that the
   * export scope may be incomplete, not truthfully empty.
   */
  discoveryWarning?: {
    steps: Array<{ step: 'roster' | 'threads' | 'users-me'; detail: string }>;
  };
}

/** Read the cached session snapshot the content script has posted to us. */
export async function getStoredSession(): Promise<DiscoveredSession | undefined> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return undefined;
  const box = await chrome.storage.local.get(STORAGE_KEY);
  const stored = box[STORAGE_KEY] as DiscoveredSession | undefined;
  if (!stored) return undefined;
  if (stored.schemaVersion !== SCHEMA_VERSION) {
    // Stale shape from a prior build — drop it so the next discovery repopulates.
    await chrome.storage.local.remove(STORAGE_KEY);
    return undefined;
  }
  return stored;
}

/**
 * Merge-and-save. L8: earlier this blindly overwrote, so a discovery run
 * that came back with (say) no `clientVersion` (because the meta tag was
 * temporarily absent on the tab that answered) would drop a previously
 * populated field. Merge policy: prefer the incoming value when it's
 * defined AND non-empty; keep the prior value otherwise.
 */
export async function saveSession(s: DiscoveredSession): Promise<void> {
  const prior = await getStoredSession();
  const merged = prior ? mergeSessions(prior, s) : s;
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...merged, schemaVersion: SCHEMA_VERSION },
  });
}

function mergeSessions(prior: DiscoveredSession, next: DiscoveredSession): DiscoveredSession {
  const out: DiscoveredSession = { ...prior };
  const preferNext = <K extends keyof DiscoveredSession>(k: K) => {
    const v = next[k];
    if (v === undefined || v === null) return;
    if (typeof v === 'string' && v.length === 0) return;
    if (Array.isArray(v) && v.length === 0 && Array.isArray(prior[k]) && (prior[k] as unknown as unknown[]).length > 0) {
      // Preserve a prior populated array over an incoming empty one.
      return;
    }
    (out as unknown as Record<string, unknown>)[k as string] = v as unknown;
  };
  for (const k of Object.keys(next) as Array<keyof DiscoveredSession>) preferNext(k);
  // discoveryWarning represents "state of the most recent discovery attempt"
  // — never merge. `next` is the authoritative snapshot: if it doesn't
  // carry a warning, drop any stale one from `prior`. Without this, a
  // transient 5xx would surface a warning banner that never went away
  // even after a clean re-discovery.
  if (next.discoveryWarning) {
    out.discoveryWarning = next.discoveryWarning;
  } else if ('discoveryWarning' in next) {
    delete out.discoveryWarning;
  }
  // studentNames + threadIds: merge maps/sets rather than replace when both
  // sides have data — a two-tab enrichment shouldn't lose a name from
  // whichever tab wasn't the "last writer".
  if (prior.studentNames || next.studentNames) {
    out.studentNames = { ...(prior.studentNames ?? {}), ...(next.studentNames ?? {}) };
  }
  if ((prior.threadIds?.length ?? 0) > 0 && (next.threadIds?.length ?? 0) > 0) {
    const set = new Set<string>([...(prior.threadIds ?? []), ...(next.threadIds ?? [])]);
    out.threadIds = Array.from(set);
  }
  return out;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Ask every open Brightwheel tab for a fresh session snapshot. Merges the
 * results so a parent with two students open in separate tabs ends up with
 * both `studentIds` in the returned session — the previous version returned
 * the first tab's payload only and dropped the other student on the floor.
 */
export async function discoverFromOpenTab(): Promise<DiscoveredSession | undefined> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return undefined;
  const tabs = await chrome.tabs.query({ url: 'https://schools.mybrightwheel.com/*' });
  let merged: DiscoveredSession | undefined;
  const studentIds = new Set<string>();
  for (const tab of tabs) {
    if (!tab.id) continue;
    let resp: { session?: DiscoveredSession } | undefined;
    try {
      resp = (await chrome.tabs.sendMessage(tab.id, { type: 'bw-takeout:discover' })) as
        | { session?: DiscoveredSession }
        | undefined;
    } catch {
      // content script not injected on this tab (e.g. login screen); skip.
      continue;
    }
    const s = resp?.session;
    if (!s) continue;
    // Base-tab selection: prefer any tab that shipped real headers
    // (csrf + clientUuid). If the user has a login-screen tab AND a
    // logged-in tab open, the login-screen tab returns nulls for csrf —
    // taking it as the base would leave the session unusable even though
    // a valid session existed one tab over.
    const looksReady = Boolean(s.csrfToken && s.clientUuid);
    if (!merged || (looksReady && !(merged.csrfToken && merged.clientUuid))) {
      merged = { ...s, studentIds: [] };
    }
    for (const sid of s.studentIds ?? []) studentIds.add(sid);
  }
  if (!merged) return undefined;
  merged.studentIds = Array.from(studentIds);
  await saveSession(merged);
  return merged;
}

/**
 * Whether the user is currently authenticated to Brightwheel. Probes
 * /api/v1/users/me — the browser attaches the existing session cookie via
 * `credentials: 'include'`; a 200 with an `object_id` means we're in.
 *
 * M1 safety: attaches x-csrf-token + x-client-uuid from the content
 * script's cached snapshot when they're available. BW's edge doesn't
 * currently require these on /users/me, but if that ever changes, this
 * probe would false-negative and the popup would show "not logged in"
 * for signed-in users. Falls back to no-headers when the snapshot is
 * absent (first popup open before the content script runs).
 */
async function readCachedContentHeaders(): Promise<{ csrf?: string; clientUuid?: string }> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return {};
  try {
    const box = await chrome.storage.session.get('bw-takeout:last-discovery');
    const s = box['bw-takeout:last-discovery'] as
      | { csrfToken?: string | null; clientUuid?: string | null }
      | undefined;
    return {
      csrf: s?.csrfToken ?? undefined,
      clientUuid: s?.clientUuid ?? undefined,
    };
  } catch {
    return {};
  }
}

export async function hasBrightwheelCookie(): Promise<boolean> {
  try {
    const { csrf, clientUuid } = await readCachedContentHeaders();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (clientUuid) headers['x-client-uuid'] = clientUuid;
    const r = await fetch('https://schools.mybrightwheel.com/api/v1/users/me', {
      credentials: 'include',
      headers,
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { object_id?: string };
    return typeof j.object_id === 'string' && j.object_id.length > 0;
  } catch {
    return false;
  }
}
