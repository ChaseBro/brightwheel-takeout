/**
 * @vitest-environment jsdom
 */
//
// Content-script URL / localStorage parsing coverage. The module itself is
// a thin bundle of side-effects (registers a listener + eagerly saves), so
// we import it after shimming chrome/localStorage/etc., then trigger the
// listener the same way the SW would.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MessageHandler {
  (msg: unknown, sender: unknown, sendResponse: (resp: unknown) => void): boolean | undefined;
}

interface DetectSession {
  csrfToken?: string | null;
  clientUuid?: string | null;
  studentIds?: string[];
  clientVersion?: string | null;
  userAgent?: string;
  source?: string;
}

let messageHandlers: MessageHandler[] = [];
let sessionData: Map<string, unknown>;

/**
 * jsdom shipped with this vitest doesn't include a Storage implementation,
 * so bare `localStorage.getItem(...)` in detect.ts would throw. Provide a
 * minimal in-memory Storage-like on window before importing the module.
 */
function installLocalStorage(): void {
  const data = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => data.set(k, String(v)),
    removeItem: (k: string) => data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true });
}

function installChromeShim(): void {
  sessionData = new Map();
  const chrome = {
    runtime: {
      onMessage: {
        addListener: (h: MessageHandler) => {
          messageHandlers.push(h);
        },
      },
    },
    storage: {
      session: {
        set: async (o: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(o)) sessionData.set(k, v);
        },
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chrome;
}

async function importFreshDetect(): Promise<void> {
  vi.resetModules();
  // detect.ts is a side-effect module (no exports); ts-loader needs an
  // explicit relative path with .ts to pick it up in tests.
  await import('../src/content/detect');
}

function askDiscover(): Promise<DetectSession | undefined> {
  return new Promise((resolve) => {
    if (messageHandlers.length === 0) {
      resolve(undefined);
      return;
    }
    messageHandlers[0]!(
      { type: 'bw-takeout:discover' },
      {},
      (resp: unknown) => {
        resolve((resp as { session?: DetectSession })?.session);
      },
    );
  });
}

function setPathname(pathname: string): void {
  Object.defineProperty(window, 'location', {
    value: {
      ...window.location,
      pathname,
      href: `https://schools.mybrightwheel.com${pathname}`,
    },
    configurable: true,
  });
}

beforeEach(() => {
  messageHandlers = [];
  installChromeShim();
  installLocalStorage();
  setPathname('/');
});
afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('detect.ts', () => {
  it('reads csrf_token + bw-client-identifier from localStorage', async () => {
    localStorage.setItem('csrf_token', 'csrf-live');
    localStorage.setItem('bw-client-identifier', 'client-abc');
    await importFreshDetect();
    const s = await askDiscover();
    expect(s?.csrfToken).toBe('csrf-live');
    expect(s?.clientUuid).toBe('client-abc');
    expect(s?.source).toBe('content-script');
  });

  it('returns null localStorage values as null (no throw)', async () => {
    await importFreshDetect();
    const s = await askDiscover();
    expect(s?.csrfToken).toBeNull();
    expect(s?.clientUuid).toBeNull();
  });

  it('parses /students/{id}/feed → studentIds:[id]', async () => {
    setPathname('/students/stu-abc/feed');
    await importFreshDetect();
    const s = await askDiscover();
    expect(s?.studentIds).toEqual(['stu-abc']);
  });

  it('parses /children/{id} → studentIds:[id]', async () => {
    setPathname('/children/kid-1/timeline');
    await importFreshDetect();
    const s = await askDiscover();
    expect(s?.studentIds).toEqual(['kid-1']);
  });

  it('ignores /students/list (the roster listing, not a student page)', async () => {
    setPathname('/students/list');
    await importFreshDetect();
    const s = await askDiscover();
    expect(s?.studentIds).toEqual([]);
  });

  it('reports empty studentIds when the URL has no student segment', async () => {
    setPathname('/dashboard');
    await importFreshDetect();
    const s = await askDiscover();
    expect(s?.studentIds).toEqual([]);
  });

  it('picks up the <meta name="appVersion"> tag when present', async () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'appVersion');
    meta.setAttribute('content', '4457');
    document.head.appendChild(meta);
    await importFreshDetect();
    const s = await askDiscover();
    expect(s?.clientVersion).toBe('4457');
    meta.remove();
  });

  it('caches the initial snapshot into chrome.storage.session on load', async () => {
    localStorage.setItem('csrf_token', 'csrf-cached');
    await importFreshDetect();
    // Give the fire-and-forget saveDiscovery a microtask to land.
    await new Promise((r) => setTimeout(r, 0));
    const cached = sessionData.get('bw-takeout:last-discovery') as { csrfToken?: string } | undefined;
    expect(cached?.csrfToken).toBe('csrf-cached');
  });
});
