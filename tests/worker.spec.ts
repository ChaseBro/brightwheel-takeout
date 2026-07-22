// @vitest-environment node
//
// Coverage for background/worker.ts. Worker is a side-effect module that
// wires chrome.runtime listeners on import, so we mock chrome + capture
// handlers before importing. Then exercise the bw-takeout:status path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MsgHandler = (
  msg: unknown,
  sender: unknown,
  sendResponse: (resp: unknown) => void,
) => boolean | undefined;

let onMessageHandlers: MsgHandler[];
let onConnectHandlers: Array<(port: unknown) => void>;
let localStore: Map<string, unknown>;
let sessionStore: Map<string, unknown>;
let tabsResponders: Map<number, unknown>;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;
let fetchResponder: (url: string, init?: RequestInit) => Response | Promise<Response>;

function installChromeShim(): void {
  onMessageHandlers = [];
  onConnectHandlers = [];
  localStore = new Map();
  sessionStore = new Map();
  tabsResponders = new Map();
  const chrome = {
    runtime: {
      onMessage: {
        addListener: (h: MsgHandler) => onMessageHandlers.push(h),
      },
      onConnect: {
        addListener: (h: (port: unknown) => void) => onConnectHandlers.push(h),
      },
      reload: () => {},
      getURL: (p: string) => `chrome-extension://mock/${p}`,
    },
    storage: {
      local: {
        async get(k: string) {
          return localStore.has(k) ? { [k]: localStore.get(k) } : {};
        },
        async set(o: Record<string, unknown>) {
          for (const [k, v] of Object.entries(o)) localStore.set(k, v);
        },
        async remove(k: string) {
          localStore.delete(k);
        },
      },
      session: {
        async get(k: string) {
          return sessionStore.has(k) ? { [k]: sessionStore.get(k) } : {};
        },
        async set(o: Record<string, unknown>) {
          for (const [k, v] of Object.entries(o)) sessionStore.set(k, v);
        },
      },
    },
    tabs: {
      async query() {
        return Array.from(tabsResponders.keys()).map((id) => ({ id }));
      },
      async sendMessage(id: number) {
        return tabsResponders.get(id);
      },
      async create() {
        return { id: 999 };
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chrome;
}

async function importFreshWorker(): Promise<void> {
  vi.resetModules();
  await import('../src/background/worker');
}

function call(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    if (onMessageHandlers.length === 0) return resolve(undefined);
    onMessageHandlers[0]!(msg, {}, resolve);
  });
}

beforeEach(() => {
  installChromeShim();
  fetchCalls = [];
  fetchResponder = () => new Response('{}', { status: 200 });
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return Promise.resolve(fetchResponder(url, init));
  };
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('worker enrichSession gating', () => {
  it('does not call the guardian API when csrfToken/clientUuid are missing', async () => {
    tabsResponders.set(1, {
      session: {
        guardianId: 'g-1',
        clientUuid: '',
        userUuid: null,
        csrfToken: '', // missing
        studentIds: ['s-1'],
        discoveredAt: 1,
        source: 'content-script',
      },
    });
    fetchResponder = (url) => {
      // Only /users/me is expected — the enrichment path is gated off.
      if (url.endsWith('/api/v1/users/me')) {
        return new Response(JSON.stringify({ object_id: 'g-1' }), { status: 200 });
      }
      // If enrichment somehow ran, it'd hit /guardians/... — fail loudly.
      throw new Error(`unexpected enrichment call: ${url}`);
    };
    await importFreshWorker();
    const resp = (await call({ type: 'bw-takeout:status' })) as {
      hasCookie: boolean;
      session?: { threadIds?: string[] } | null;
    };
    expect(resp.hasCookie).toBe(true);
    // Enrichment skipped → threadIds unset (undefined, not empty array).
    expect(resp.session?.threadIds).toBeUndefined();
    // Only the /users/me probe was made — no /guardians/... enrichment call.
    expect(fetchCalls.every((c) => !c.url.includes('/guardians/'))).toBe(true);
  });

  it('propagates a discoveryWarning through the status response (M4 wiring)', async () => {
    tabsResponders.set(1, {
      session: {
        guardianId: 'g-1',
        clientUuid: 'c',
        userUuid: null,
        csrfToken: 't',
        studentIds: [],
        discoveredAt: 1,
        source: 'content-script',
      },
    });
    fetchResponder = (url) => {
      if (url.endsWith('/api/v1/users/me')) {
        return new Response(JSON.stringify({ object_id: 'g-1' }), { status: 200 });
      }
      if (url.includes('/students')) {
        // Roster call 500s repeatedly — becomes a BwServerError → warning.
        return new Response('{}', { status: 500 });
      }
      // Threads succeed.
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    await importFreshWorker();
    const resp = (await call({ type: 'bw-takeout:status' })) as {
      hasCookie: boolean;
      session?: { discoveryWarning?: { steps: Array<{ step: string }> } } | null;
    };
    expect(resp.session?.discoveryWarning).toBeDefined();
    expect(resp.session?.discoveryWarning?.steps.some((s) => s.step === 'roster')).toBe(true);
  }, 30_000);

  it('answers bw-takeout:open-takeout-page with { ok: true }', async () => {
    await importFreshWorker();
    const resp = (await call({ type: 'bw-takeout:open-takeout-page' })) as { ok: boolean };
    expect(resp.ok).toBe(true);
  });

  it('returns an error for unknown message types', async () => {
    await importFreshWorker();
    const resp = (await call({ type: 'bw-takeout:nonsense' })) as { ok: boolean; error: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/unknown/);
  });
});
