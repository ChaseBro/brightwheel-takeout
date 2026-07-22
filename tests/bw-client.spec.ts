import { describe, expect, it, vi } from 'vitest';
import {
  BwClient,
  BwAuthError,
  BwNotFoundError,
  BwRateLimitError,
  BwServerError,
  BwNetworkError,
} from '@/scraper/bw-client';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const baseSession = {
  clientUuid: 'c-1',
  userUuid: 'u-1',
  csrfToken: 'csrf',
  studentId: 'stu-1',
  clientVersion: '4457',
  userAgent: 'test-agent/1.0',
};

describe('BwClient', () => {
  it('injects the standard header set on API requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new BwClient(baseSession, { fetchImpl });
    await client.getJson('https://schools.mybrightwheel.com/api/v1/anything');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.credentials).toBe('include');
    const h = init.headers as Record<string, string>;
    expect(h['x-csrf-token']).toBe('csrf');
    expect(h['x-client-uuid']).toBe('c-1');
    expect(h['x-user-uuid']).toBe('u-1');
    expect(h['x-client-name']).toBe('web');
    expect(h['x-api-client-type']).toBe('manual');
    expect(h['x-frontend-release-target']).toBe('stable');
    expect(h['x-client-version']).toBe('4457');
    expect(h['referer']).toContain('stu-1');
  });

  it('omits API headers for raw byte fetches (e.g. CloudFront images)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    const client = new BwClient(baseSession, { fetchImpl });
    await client.getBytes('https://x.cloudfront.net/img.jpg');
    const [, init] = fetchImpl.mock.calls[0]!;
    const h = init.headers as Record<string, string>;
    expect(h['x-csrf-token']).toBeUndefined();
    expect(h['user-agent']).toBe('test-agent/1.0');
  });

  it('throws BwAuthError on 401 without retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'nope' }));
    const client = new BwClient(baseSession, { fetchImpl, sleep: async () => {} });
    await expect(client.getJson('https://x/')).rejects.toBeInstanceOf(BwAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws BwNotFoundError on 404 without retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404));
    const client = new BwClient(baseSession, { fetchImpl, sleep: async () => {} });
    await expect(client.getJson('https://x/')).rejects.toBeInstanceOf(BwNotFoundError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 with backoff and eventually succeeds', async () => {
    const responses = [
      jsonResponse(429),
      jsonResponse(429),
      jsonResponse(200, { ok: true }),
    ];
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new BwClient(baseSession, {
      fetchImpl,
      sleep,
      jitter: () => 0,
      retries: 5,
    });
    const r = await client.getJson<{ ok: boolean }>('https://x/');
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Backoff called twice (once per retry).
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up on 429 after all retries and throws BwRateLimitError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429));
    const client = new BwClient(baseSession, {
      fetchImpl,
      sleep: async () => {},
      jitter: () => 0,
      retries: 2,
    });
    await expect(client.getJson('https://x/')).rejects.toBeInstanceOf(BwRateLimitError);
    // 1 initial + 2 retries
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries 5xx and gives up as BwServerError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(502));
    const client = new BwClient(baseSession, {
      fetchImpl,
      sleep: async () => {},
      jitter: () => 0,
      retries: 1,
    });
    await expect(client.getJson('https://x/')).rejects.toBeInstanceOf(BwServerError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries network errors and gives up as BwNetworkError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new BwClient(baseSession, {
      fetchImpl,
      sleep: async () => {},
      jitter: () => 0,
      retries: 2,
    });
    await expect(client.getJson('https://x/')).rejects.toBeInstanceOf(BwNetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('backoff is exponential with jitter and capped', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const sleeps: number[] = [];
    const client = new BwClient(baseSession, {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitter: () => 0,
      retries: 5,
      backoffBaseMs: 100,
      backoffMaxMs: 1000,
    });
    await client.getJson('https://x/');
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('updateCsrf swaps the header on subsequent calls', async () => {
    // Fresh Response per call — bodies are one-shot readable streams.
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200));
    const client = new BwClient(baseSession, { fetchImpl });
    await client.getJson('https://x/one');
    client.updateCsrf('csrf-2');
    await client.getJson('https://x/two');
    const h1 = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    const h2 = fetchImpl.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(h1['x-csrf-token']).toBe('csrf');
    expect(h2['x-csrf-token']).toBe('csrf-2');
  });

  it('recovers from CSRF drift: 403 → refreshCsrf → retry once with new token', async () => {
    const responses = [
      jsonResponse(403, { error: 'csrf drift' }),
      jsonResponse(200, { ok: true }),
    ];
    const fetchImpl = vi.fn().mockImplementation(async () => responses.shift()!);
    const refreshCsrf = vi.fn().mockResolvedValue('csrf-fresh');
    const client = new BwClient(
      { ...baseSession, csrfToken: 'csrf-stale' },
      { fetchImpl, sleep: async () => {}, refreshCsrf, retries: 0 },
    );
    const r = await client.getJson<{ ok: boolean }>('https://x/');
    expect(r.ok).toBe(true);
    expect(refreshCsrf).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const h1 = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    const h2 = fetchImpl.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(h1['x-csrf-token']).toBe('csrf-stale');
    expect(h2['x-csrf-token']).toBe('csrf-fresh');
  });

  it('CSRF drift recovery only fires ONCE per request (no infinite loop on dead session)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403));
    const refreshCsrf = vi.fn().mockResolvedValue('csrf-fresh');
    const client = new BwClient(
      { ...baseSession },
      { fetchImpl, sleep: async () => {}, refreshCsrf, retries: 0 },
    );
    await expect(client.getJson('https://x/')).rejects.toBeInstanceOf(BwAuthError);
    expect(refreshCsrf).toHaveBeenCalledOnce();
    // 1 original + 1 CSRF-retry = 2 fetches (no runaway retries).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('CSRF drift recovery is skipped for raw byte fetches (no api headers → no csrf involved)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(), { status: 403 }),
    );
    const refreshCsrf = vi.fn().mockResolvedValue('csrf-fresh');
    const client = new BwClient(
      { ...baseSession },
      { fetchImpl, sleep: async () => {}, refreshCsrf, retries: 0 },
    );
    await expect(client.getBytes('https://x/image.jpg')).rejects.toBeInstanceOf(BwAuthError);
    expect(refreshCsrf).not.toHaveBeenCalled();
  });

  it('records failed requests to debug capture (H3)', async () => {
    // H3 regression: previously debugCapture only fired after request()
    // returned successfully, so the exact requests a user needs help
    // debugging (401, 404, exhausted retries) were absent from the dump.
    const captured: Array<{ url: string; status: number; error?: string }> = [];
    const debugCapture = (e: { url: string; status: number; error?: string }) => {
      captured.push({ url: e.url, status: e.status, error: e.error });
    };
    let seq = 0;
    const debugNextSeq = () => ++seq;
    // 401 → BwAuthError; 404 → BwNotFoundError; exhausted network retries.
    const failing = vi.fn().mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(404))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new BwClient(baseSession, {
      fetchImpl: failing,
      sleep: async () => {},
      jitter: () => 0,
      retries: 0,
      debugCapture,
      debugNextSeq,
    });
    await expect(client.getJson('https://x/auth')).rejects.toBeInstanceOf(BwAuthError);
    await expect(client.getJson('https://x/notfound')).rejects.toBeInstanceOf(BwNotFoundError);
    await expect(client.getJson('https://x/network')).rejects.toBeInstanceOf(BwNetworkError);
    expect(captured).toHaveLength(3);
    expect(captured[0]!.status).toBe(401);
    expect(captured[0]!.error).toMatch(/401/);
    expect(captured[1]!.status).toBe(404);
    expect(captured[2]!.status).toBe(0);
    expect(captured[2]!.error).toMatch(/network|Failed to fetch/);
  });

  it('counts every request in requestCount', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200));
    const client = new BwClient(baseSession, {
      fetchImpl,
      sleep: async () => {},
      jitter: () => 0,
    });
    await client.getJson('https://x/');
    expect(client.requestCount).toBe(2);
  });
});
