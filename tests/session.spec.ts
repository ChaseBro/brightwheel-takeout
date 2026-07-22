// @vitest-environment node
//
// Coverage for lib/session.ts. Uses a shim chrome global so the module's
// storage / tabs APIs resolve without a real extension host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSession,
  discoverFromOpenTab,
  getStoredSession,
  hasBrightwheelCookie,
  saveSession,
  type DiscoveredSession,
} from '@/lib/session';

interface StorageArea {
  data: Map<string, unknown>;
}

function makeStorage(): {
  local: StorageArea & {
    get: (k: string) => Promise<Record<string, unknown>>;
    set: (o: Record<string, unknown>) => Promise<void>;
    remove: (k: string) => Promise<void>;
  };
  session: StorageArea & {
    get: (k: string) => Promise<Record<string, unknown>>;
    set: (o: Record<string, unknown>) => Promise<void>;
  };
} {
  const localData = new Map<string, unknown>();
  const sessionData = new Map<string, unknown>();
  return {
    local: {
      data: localData,
      async get(k: string) {
        return localData.has(k) ? { [k]: localData.get(k) } : {};
      },
      async set(o: Record<string, unknown>) {
        for (const [k, v] of Object.entries(o)) localData.set(k, v);
      },
      async remove(k: string) {
        localData.delete(k);
      },
    },
    session: {
      data: sessionData,
      async get(k: string) {
        return sessionData.has(k) ? { [k]: sessionData.get(k) } : {};
      },
      async set(o: Record<string, unknown>) {
        for (const [k, v] of Object.entries(o)) sessionData.set(k, v);
      },
    },
  };
}

const g = globalThis as unknown as { chrome?: unknown; fetch?: typeof fetch };

let chromeMock: ReturnType<typeof buildChromeMock>;
let originalFetch: typeof fetch | undefined;

function buildChromeMock(): {
  storage: ReturnType<typeof makeStorage>;
  tabs?: {
    query: (q: unknown) => Promise<Array<{ id: number }>>;
    sendMessage: (
      id: number,
      msg: unknown,
    ) => Promise<{ session?: DiscoveredSession } | undefined>;
  };
} {
  return { storage: makeStorage() };
}

function sampleSession(overrides: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    guardianId: 'g-1',
    clientUuid: 'c-1',
    userUuid: 'u-1',
    csrfToken: 'csrf',
    studentIds: ['s-1'],
    discoveredAt: 1,
    source: 'content-script',
    ...overrides,
  };
}

beforeEach(() => {
  chromeMock = buildChromeMock();
  g.chrome = chromeMock;
  originalFetch = g.fetch;
});

afterEach(() => {
  delete g.chrome;
  if (originalFetch) g.fetch = originalFetch;
});

describe('saveSession / getStoredSession / clearSession', () => {
  it('round-trips a session with the current schema version stamped', async () => {
    await saveSession(sampleSession());
    const stored = await getStoredSession();
    expect(stored?.guardianId).toBe('g-1');
    expect((stored as unknown as { schemaVersion: number }).schemaVersion).toBeGreaterThanOrEqual(2);
  });

  it('drops a stale-schema row and returns undefined (self-cleaning cache)', async () => {
    chromeMock.storage.local.data.set('bw-takeout:session', { schemaVersion: 1, foo: 'legacy' });
    const stored = await getStoredSession();
    expect(stored).toBeUndefined();
    expect(chromeMock.storage.local.data.has('bw-takeout:session')).toBe(false);
  });

  it('saveSession merges fields (L8): a later write with an undefined field keeps the prior value', async () => {
    await saveSession(
      sampleSession({ clientVersion: '4457', studentNames: { 's-1': 'Alice' } }),
    );
    // Second write drops clientVersion and studentNames — merge must keep them.
    await saveSession(sampleSession({ studentIds: ['s-1', 's-2'] }));
    const stored = await getStoredSession();
    expect(stored?.clientVersion).toBe('4457');
    expect(stored?.studentNames?.['s-1']).toBe('Alice');
    expect(stored?.studentIds).toContain('s-2');
  });

  it('clears a stale discoveryWarning when a subsequent save carries none', async () => {
    // Bug repro: a transient 5xx during discovery sets a warning; the next
    // clean discovery must be able to clear it, otherwise the takeout page
    // renders a permanent "some data couldn't be loaded" banner even after
    // the underlying BW issue resolves.
    await saveSession(
      sampleSession({
        discoveryWarning: { steps: [{ step: 'threads', detail: '500 Internal' }] },
      }),
    );
    await saveSession({
      ...sampleSession(),
      discoveryWarning: undefined,
    });
    const stored = await getStoredSession();
    expect(stored?.discoveryWarning).toBeUndefined();
  });

  it('saveSession set-merges threadIds across writes', async () => {
    await saveSession(sampleSession({ threadIds: ['t-1', 't-2'] }));
    await saveSession(sampleSession({ threadIds: ['t-2', 't-3'] }));
    const stored = await getStoredSession();
    expect(new Set(stored?.threadIds ?? [])).toEqual(new Set(['t-1', 't-2', 't-3']));
  });

  it('clearSession removes the row', async () => {
    await saveSession(sampleSession());
    await clearSession();
    expect(await getStoredSession()).toBeUndefined();
  });
});

describe('discoverFromOpenTab', () => {
  it('merges studentIds across multiple tabs so no sibling is dropped', async () => {
    (chromeMock as unknown as { tabs: unknown }).tabs = {
      query: async () => [{ id: 1 }, { id: 2 }],
      sendMessage: async (id: number) => {
        if (id === 1) {
          return {
            session: {
              ...sampleSession({ studentIds: ['stu-A'] }),
            },
          };
        }
        return {
          session: {
            ...sampleSession({ studentIds: ['stu-B'] }),
          },
        };
      },
    };
    const merged = await discoverFromOpenTab();
    expect(new Set(merged?.studentIds ?? [])).toEqual(new Set(['stu-A', 'stu-B']));
  });

  it('tolerates a tab whose content script never answered', async () => {
    (chromeMock as unknown as { tabs: unknown }).tabs = {
      query: async () => [{ id: 1 }, { id: 2 }],
      sendMessage: async (id: number) => {
        if (id === 1) throw new Error('no receiver');
        return { session: sampleSession({ studentIds: ['stu-only'] }) };
      },
    };
    const merged = await discoverFromOpenTab();
    expect(merged?.studentIds).toEqual(['stu-only']);
  });

  it('picks a base tab that has real csrf+clientUuid over one that only has nulls', async () => {
    // Simulates: tab 1 is on the BW login screen (no session yet, csrf/uuid
    // are null in localStorage), tab 2 is a logged-in student feed. The
    // discovery must pick tab 2 as the base or the merged session ends up
    // unusable even though the user is signed in one tab over.
    (chromeMock as unknown as { tabs: unknown }).tabs = {
      query: async () => [{ id: 1 }, { id: 2 }],
      sendMessage: async (id: number) => {
        if (id === 1) {
          return {
            session: {
              ...sampleSession({ studentIds: ['stu-A'] }),
              csrfToken: null as unknown as string,
              clientUuid: '',
            },
          };
        }
        return { session: sampleSession({ studentIds: ['stu-B'] }) };
      },
    };
    const merged = await discoverFromOpenTab();
    expect(merged?.csrfToken).toBe('csrf');
    expect(merged?.clientUuid).toBe('c-1');
    // studentIds still merge from both tabs regardless of base pick.
    expect(new Set(merged?.studentIds ?? [])).toEqual(new Set(['stu-A', 'stu-B']));
  });

  it('returns undefined when no tabs answered', async () => {
    (chromeMock as unknown as { tabs: unknown }).tabs = {
      query: async () => [],
      sendMessage: async () => undefined,
    };
    const merged = await discoverFromOpenTab();
    expect(merged).toBeUndefined();
  });
});

describe('hasBrightwheelCookie', () => {
  it('returns true when /users/me responds 200 with object_id', async () => {
    g.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object_id: 'g-1' }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await hasBrightwheelCookie()).toBe(true);
  });

  it('returns false on non-2xx', async () => {
    g.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 401 })) as unknown as typeof fetch;
    expect(await hasBrightwheelCookie()).toBe(false);
  });

  it('attaches cached csrf + client-uuid headers when present (M1)', async () => {
    await chromeMock.storage.session.set({
      'bw-takeout:last-discovery': { csrfToken: 'csrf-abc', clientUuid: 'client-xyz' },
    });
    const seen: Array<Record<string, string>> = [];
    g.fetch = vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ object_id: 'g-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await hasBrightwheelCookie();
    expect(seen[0]!['x-csrf-token']).toBe('csrf-abc');
    expect(seen[0]!['x-client-uuid']).toBe('client-xyz');
  });

  it('falls back to no-headers when the cached snapshot is absent', async () => {
    const seen: Array<Record<string, string>> = [];
    g.fetch = vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ object_id: 'g-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await hasBrightwheelCookie();
    expect(seen[0]!['x-csrf-token']).toBeUndefined();
  });
});
