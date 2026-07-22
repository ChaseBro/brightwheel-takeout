// Thin fetch() wrapper for the Brightwheel guardian API.
//
// - Injects the exact set of headers we've seen the web app send (see
//   `~/src/notes/Library/Brightwheel/download_notes.py`). The session cookie
//   itself is sent automatically by the browser because our host_permissions
//   include schools.mybrightwheel.com; we do NOT set a Cookie header
//   manually.
// - Retries transient failures (network, 429, 503) with exponential backoff +
//   jitter, up to PACING.maxRetries.
// - Throws typed error classes so callers can distinguish auth loss (401/403)
//   from a rate-limit exhaustion (429 after all retries) from a 5xx.

import { PACING } from './pacing.js';
import type { RingLogger } from '@/lib/log.js';
import { log as defaultLog } from '@/lib/log.js';

export class BwAuthError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = 'BwAuthError';
    this.status = status;
  }
}
export class BwRateLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BwRateLimitError';
  }
}
export class BwNotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BwNotFoundError';
  }
}
export class BwServerError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = 'BwServerError';
    this.status = status;
  }
}
export class BwNetworkError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BwNetworkError';
  }
}

export interface BwClientSession {
  clientUuid: string;
  userUuid: string;
  csrfToken: string;
  studentId?: string; // used for the Referer header when present
  clientVersion?: string;
  userAgent?: string;
}

export interface BwClientOptions {
  fetchImpl?: typeof fetch;
  logger?: RingLogger;
  /** Override PACING settings for tests. */
  retries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Deterministic jitter (0..1) for tests; default = Math.random. */
  jitter?: () => number;
  /** Sleep function; overrideable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called once per request when the server 403s the current CSRF token.
   * Returns a fresh token (asked from the content script) that the client
   * swaps in before retrying the exact same request. If undefined or the
   * callback returns undefined, the 403 propagates as BwAuthError.
   *
   * Rate limit: at most one refresh + retry per request (avoids a loop with
   * a genuinely dead session).
   */
  refreshCsrf?: () => Promise<string | undefined>;
  /**
   * Debug mode capture. When set, every successful response body is copied
   * (as bytes) into the callback along with metadata; run.ts turns that
   * into debug/<seq>-<slug>.json + debug/request-log.jsonl. The callback
   * is called AFTER retries settle, so a request that hit a 503 and
   * retried once shows up as a single entry with the final status.
   */
  debugCapture?: (entry: {
    seq: number;
    method: string;
    url: string;
    status: number;
    durationMs: number;
    body?: Uint8Array;
    error?: string;
  }) => void;
  /**
   * When debugCapture is set, this callback allocates the monotonic
   * sequence number. Split from `debugCapture` so BwClient can allocate a
   * seq for failed requests without buffering the body.
   */
  debugNextSeq?: () => number;
}

export class BwClient {
  private session: BwClientSession;
  private fetchImpl: typeof fetch;
  private logger: RingLogger;
  private retries: number;
  private backoffBaseMs: number;
  private backoffMaxMs: number;
  private jitter: () => number;
  private sleep: (ms: number) => Promise<void>;
  private refreshCsrf?: () => Promise<string | undefined>;
  private debugCapture?: BwClientOptions['debugCapture'];
  private debugNextSeq?: () => number;
  /** Number of requests issued this session (for the soft budget). */
  requestCount = 0;
  /** Whether we've already logged the "over-budget" warning this run. */
  private budgetWarned = false;

  constructor(session: BwClientSession, opts: BwClientOptions = {}) {
    this.session = session;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger ?? defaultLog;
    this.retries = opts.retries ?? PACING.maxRetries;
    this.backoffBaseMs = opts.backoffBaseMs ?? PACING.backoffBaseMs;
    this.backoffMaxMs = opts.backoffMaxMs ?? PACING.backoffMaxMs;
    this.jitter = opts.jitter ?? Math.random;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.refreshCsrf = opts.refreshCsrf;
    this.debugCapture = opts.debugCapture;
    this.debugNextSeq = opts.debugNextSeq;
  }

  updateCsrf(csrf: string): void {
    this.session.csrfToken = csrf;
  }

  updateUserUuid(userUuid: string): void {
    this.session.userUuid = userUuid;
  }

  /**
   * Fetch a URL with retry/backoff and typed errors. Sends the standard
   * Brightwheel header set. Cookies go automatically via credentials:'include'.
   */
  async getJson<T = unknown>(url: string): Promise<T> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.request(url);
    } catch (err) {
      this.recordDebugFailure('GET', url, err, Date.now() - started);
      throw err;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (this.debugCapture && this.debugNextSeq) {
      this.debugCapture({
        seq: this.debugNextSeq(),
        method: 'GET',
        url,
        status: res.status,
        durationMs: Date.now() - started,
        body: buf,
      });
    }
    const text = new TextDecoder().decode(buf);
    return JSON.parse(text) as T;
  }

  /** Fetch a raw resource (e.g. an image). Same retry policy, no header injection beyond user-agent. */
  async getBytes(url: string): Promise<ArrayBuffer> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.request(url, { includeApiHeaders: false });
    } catch (err) {
      this.recordDebugFailure('GET', url, err, Date.now() - started);
      throw err;
    }
    const buf = await res.arrayBuffer();
    if (this.debugCapture && this.debugNextSeq) {
      // Don't buffer the bytes into debug capture — an image body is huge
      // and offers no diagnostic value. Log the metadata only.
      this.debugCapture({
        seq: this.debugNextSeq(),
        method: 'GET',
        url,
        status: res.status,
        durationMs: Date.now() - started,
      });
    }
    return buf;
  }

  /**
   * Debug-capture entry for a request that never produced a Response (auth,
   * notfound, exhausted retries, network). Metadata-only — no body to
   * capture, and the error message is the load-bearing detail. Called from
   * the getJson / getBytes catch blocks so failures show up alongside
   * successes in debug/request-log.jsonl.
   */
  private recordDebugFailure(method: string, url: string, err: unknown, durationMs: number): void {
    if (!this.debugCapture || !this.debugNextSeq) return;
    const status =
      err instanceof BwAuthError || err instanceof BwServerError
        ? err.status
        : err instanceof BwNotFoundError
          ? 404
          : err instanceof BwRateLimitError
            ? 429
            : 0;
    const message = (err as Error)?.message ?? String(err);
    this.debugCapture({
      seq: this.debugNextSeq(),
      method,
      url,
      status,
      durationMs,
      error: message,
    });
  }

  private buildHeaders(includeApiHeaders: boolean): HeadersInit {
    const h: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en',
    };
    if (this.session.userAgent) h['user-agent'] = this.session.userAgent;
    if (includeApiHeaders) {
      h['x-api-client-type'] = 'manual';
      h['x-client-name'] = 'web';
      h['x-client-uuid'] = this.session.clientUuid;
      if (this.session.userUuid) h['x-user-uuid'] = this.session.userUuid;
      h['x-csrf-token'] = this.session.csrfToken;
      h['x-frontend-release-target'] = 'stable';
      if (this.session.clientVersion) h['x-client-version'] = this.session.clientVersion;
      if (this.session.studentId) {
        h['referer'] = `https://schools.mybrightwheel.com/students/${this.session.studentId}/feed`;
      }
    }
    return h;
  }

  private computeBackoff(attempt: number): number {
    // Exponential: base * 2^attempt, capped, plus proportional jitter.
    // L7: prior jitter was 0..base — negligible at higher attempts, so
    // many clients receiving a 429 simultaneously all backed off to the
    // same near-raw value and thundered again together. Making jitter
    // proportional to the raw backoff (0..raw) spreads the retry storm
    // across the entire backoff window at every attempt level.
    const raw = Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs);
    const jitter = this.jitter() * raw;
    return raw + jitter;
  }

  /**
   * Either throw the terminal error (last attempt exhausted) or sleep for a
   * backoff and let the caller `continue` into the next retry attempt. Used
   * by both the 429/503 branch and the generic 5xx branch — they differ only
   * in which error class to throw.
   */
  private async retryOrThrow(
    attempt: number,
    status: number,
    url: string,
    makeErr: () => Error,
  ): Promise<void> {
    if (attempt === this.retries) throw makeErr();
    const wait = this.computeBackoff(attempt);
    this.logger.warn(
      `bw-client: ${status} on ${short(url)}, retry ${attempt + 1}/${this.retries} in ${Math.round(wait)}ms`,
    );
    await this.sleep(wait);
  }

  private async request(
    url: string,
    opts: { includeApiHeaders?: boolean } = {},
  ): Promise<Response> {
    const includeApiHeaders = opts.includeApiHeaders ?? true;
    // CSRF drift recovery: on a first 403 for this request, ask the callback
    // for a fresh token, swap it in, and try again. Only once — so a truly
    // dead session doesn't loop.
    let csrfRefreshed = false;
    let lastErr: unknown = undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      this.requestCount++;
      if (
        this.requestCount === PACING.requestBudget + 1 &&
        !this.budgetWarned
      ) {
        this.budgetWarned = true;
        this.logger.warn(
          `bw-client: request budget exceeded (${PACING.requestBudget}). Continuing but this run is unusually heavy — please report.`,
        );
      }
      // Re-derive headers each attempt so an updated csrf token takes effect.
      const headers = this.buildHeaders(includeApiHeaders);
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          credentials: 'include',
          headers,
        });
        if (res.status === 403 && includeApiHeaders && this.refreshCsrf && !csrfRefreshed) {
          csrfRefreshed = true;
          const fresh = await this.refreshCsrf();
          if (fresh && fresh !== this.session.csrfToken) {
            this.updateCsrf(fresh);
            this.logger.warn(`bw-client: 403 on ${short(url)} — refreshed CSRF, retrying once`);
            // Don't count the retry against the retry budget, don't back off:
            // this is a token-drift correction, not a transient failure.
            attempt--;
            continue;
          }
        }
        if (res.status === 401 || res.status === 403) {
          throw new BwAuthError(res.status, `${res.status} on ${short(url)}`);
        }
        if (res.status === 404) {
          throw new BwNotFoundError(`404 on ${short(url)}`);
        }
        if (res.status === 429 || res.status === 503) {
          await this.retryOrThrow(
            attempt,
            res.status,
            url,
            () => new BwRateLimitError(`${res.status} on ${short(url)} after ${attempt + 1} attempts`),
          );
          continue;
        }
        if (res.status >= 500) {
          await this.retryOrThrow(
            attempt,
            res.status,
            url,
            () => new BwServerError(res.status, `${res.status} on ${short(url)} after ${attempt + 1} attempts`),
          );
          continue;
        }
        if (!res.ok) {
          throw new BwServerError(res.status, `${res.status} on ${short(url)}`);
        }
        return res;
      } catch (err) {
        // Auth / 404 / final-attempt rate/server errors: don't retry, bubble.
        if (
          err instanceof BwAuthError ||
          err instanceof BwNotFoundError ||
          err instanceof BwRateLimitError ||
          err instanceof BwServerError
        ) {
          throw err;
        }
        lastErr = err;
        // Network error (TypeError from fetch, abort, DNS, etc.): retry.
        if (attempt === this.retries) {
          throw new BwNetworkError(
            `network error on ${short(url)} after ${attempt + 1} attempts: ${(err as Error)?.message ?? err}`,
          );
        }
        const wait = this.computeBackoff(attempt);
        this.logger.warn(
          `bw-client: network error on ${short(url)} (${(err as Error)?.message ?? err}), retry ${attempt + 1}/${this.retries} in ${Math.round(wait)}ms`,
        );
        await this.sleep(wait);
      }
    }
    // Unreachable — the loop always throws or returns before falling through.
    throw new BwNetworkError(`bw-client: exhausted retries on ${short(url)} (${lastErr})`);
  }
}

function short(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? '?…' : '');
  } catch {
    return url.slice(0, 80);
  }
}
