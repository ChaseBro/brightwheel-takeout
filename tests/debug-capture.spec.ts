// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DebugCapture,
  endpointSlug,
  MAX_CAPTURE_BODY_BYTES,
  redactHeaders,
} from '@/scraper/debug-capture';

describe('redactHeaders', () => {
  it('masks cookie / csrf / authorization headers regardless of case', () => {
    const r = redactHeaders({
      Cookie: 'session=abc',
      'X-CSRF-Token': 'xyz',
      Authorization: 'Bearer sekret',
      'X-Api-Client-Type': 'manual',
    });
    expect(r.cookie).toBe('<redacted>');
    expect(r['x-csrf-token']).toBe('<redacted>');
    expect(r.authorization).toBe('<redacted>');
    expect(r['x-api-client-type']).toBe('manual');
  });
});

describe('endpointSlug', () => {
  it('extracts the last path segment', () => {
    expect(endpointSlug('https://schools.mybrightwheel.com/api/v1/students/abc/activities?x=1')).toBe(
      'activities',
    );
  });
  it('sanitizes weird characters', () => {
    // Only [A-Za-z0-9._-] survive; the URL layer percent-encodes literal
    // spaces to %20 so any run of `_20` is expected.
    expect(endpointSlug('https://x/api/thing+bits!')).toMatch(/^[A-Za-z0-9._-]+$/);
  });
  it('falls back to root for a bare host', () => {
    expect(endpointSlug('https://x/')).toBe('root');
  });
  it('returns unknown for a totally invalid URL', () => {
    expect(endpointSlug('not a url')).toBe('unknown');
  });
});

describe('BwClient + DebugCapture integration', () => {
  it('captures response bytes for a JSON request and skips them for a bytes fetch', async () => {
    const { BwClient } = await import('@/scraper/bw-client');
    const cap = new DebugCapture(true);
    const fetchImpl = async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('photo')) {
        return new Response(new Uint8Array([1, 2, 3]) as unknown as BodyInit, { status: 200 });
      }
      return new Response(JSON.stringify({ activities: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new BwClient(
      {
        clientUuid: 'c',
        userUuid: 'u',
        csrfToken: 't',
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        debugCapture: (e) => cap.record(e),
        debugNextSeq: () => cap.nextSeq(),
      },
    );
    await client.getJson('https://schools.mybrightwheel.com/api/v1/x/activities');
    await client.getBytes('https://cdn.mybrightwheel.com/photo/abc.jpg');
    const files = new Map<string, Uint8Array>();
    await cap.writeInto(async (n, b) => {
      files.set(n, b);
    });
    // JSON call → body captured; photo call → metadata-only.
    expect(Array.from(files.keys()).some((k) => k.endsWith('-activities.json'))).toBe(true);
    const log = new TextDecoder().decode(files.get('debug/request-log.jsonl')!);
    expect(log.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
  });
});

describe('DebugCapture', () => {
  it('assigns monotonic sequence numbers', () => {
    const cap = new DebugCapture(true);
    expect(cap.nextSeq()).toBe(1);
    expect(cap.nextSeq()).toBe(2);
    expect(cap.nextSeq()).toBe(3);
  });

  it('no-ops when disabled', () => {
    const cap = new DebugCapture(false);
    cap.record({ seq: 1, method: 'GET', url: 'x', status: 200, durationMs: 5 });
    expect(cap.count).toBe(0);
  });

  it('writes recorded bodies + a request-log.jsonl with the expected fields', async () => {
    const cap = new DebugCapture(true);
    cap.record({
      seq: 1,
      method: 'GET',
      url: 'https://x/api/v1/students/abc/activities',
      status: 200,
      durationMs: 30,
      body: new TextEncoder().encode('{"activities":[]}'),
    });
    cap.record({
      seq: 2,
      method: 'GET',
      url: 'https://x/api/v1/guardians/current',
      status: 401,
      durationMs: 12,
      error: '401 on /api/v1/guardians/current',
    });
    const files = new Map<string, Uint8Array>();
    await cap.writeInto(async (name, bytes) => {
      files.set(name, bytes);
    });
    expect(files.has('debug/00001-activities.json')).toBe(true);
    expect(files.has('debug/request-log.jsonl')).toBe(true);
    const log = new TextDecoder().decode(files.get('debug/request-log.jsonl')!);
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first.seq).toBe(1);
    expect(first.bodyFile).toBe('debug/00001-activities.json');
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second.seq).toBe(2);
    expect(second.error).toBe('401 on /api/v1/guardians/current');
    // No body for the 401 → no bodyFile.
    expect(second.bodyFile).toBeUndefined();
  });

  it('truncates oversized bodies and flags them in the request log', async () => {
    const cap = new DebugCapture(true);
    const huge = new Uint8Array(MAX_CAPTURE_BODY_BYTES + 1000);
    cap.record({ seq: 1, method: 'GET', url: 'https://x/api/v1/big', status: 200, durationMs: 5, body: huge });
    const files = new Map<string, Uint8Array>();
    await cap.writeInto(async (n, b) => {
      files.set(n, b);
    });
    expect(files.get('debug/00001-big.json')!.byteLength).toBe(MAX_CAPTURE_BODY_BYTES);
    const log = new TextDecoder().decode(files.get('debug/request-log.jsonl')!);
    const entry = JSON.parse(log.trim()) as Record<string, unknown>;
    expect(entry.bodyTruncated).toBe(true);
  });
});
