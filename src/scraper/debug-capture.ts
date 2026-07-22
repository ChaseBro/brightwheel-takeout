// Debug mode raw-API capture.
//
// When Debug mode is on, the takeout page hands run.ts a `DebugCapture`
// instance. run.ts passes it into BwClient (which invokes the `record`
// callback on every request) and directly writes bodies + request log into
// the ZIP under debug/.
//
// Redaction: any header we log (currently none by default — BwClient logs
// only URLs) has cookies + CSRF tokens masked. If a future BwClient change
// starts logging headers, `redactHeaders` is where the mask lives.
//
// Sequence number is monotonic across the whole run so file ordering in
// the ZIP reflects request ordering. Not the same as timestamp — two
// requests in the same ms sort deterministically by seq.

const REDACT_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'authorization',
  'x-api-token',
]);

/**
 * Truncate response bodies that grow past this size. A single Brightwheel
 * response is normally < 1 MB; a badly-behaved endpoint could return
 * megabytes and blow the ZIP for no diagnostic benefit.
 */
export const MAX_CAPTURE_BODY_BYTES = 2 * 1024 * 1024;

export interface RequestLogEntry {
  seq: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  error?: string;
  bodyFile?: string; // e.g. "debug/00001-activities.json"
  bodyTruncated?: boolean;
}

export interface CapturedRequest {
  seq: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  body?: Uint8Array;
  error?: string;
}

export interface DebugCaptureInterface {
  /** Called by BwClient after every request completes (or fails). */
  record(entry: CapturedRequest): void;
  /**
   * Flush recorded entries into a sink. The exact write shape (per-file
   * bodies, a request-log.jsonl) lives in this module rather than run.ts
   * so the format stays in one place.
   */
  writeInto(pushBytes: (name: string, bytes: Uint8Array) => Promise<void>): Promise<void>;
  /** True if capture was ever enabled — read by run.ts to decide the log dump. */
  readonly enabled: boolean;
  /** Number of requests currently held (for diagnostics). */
  readonly count: number;
}

/**
 * Turn a URL into a short slug used in the file name. Trims to the
 * pathname's last segment and strips characters the ZIP filename layer
 * (or a naive user's file system) might dislike.
 */
export function endpointSlug(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter((s) => s.length > 0);
    const tail = seg.length === 0 ? 'root' : seg[seg.length - 1]!;
    return sanitize(tail).slice(0, 40) || 'root';
  } catch {
    return 'unknown';
  }
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    out[key] = REDACT_HEADERS.has(key) ? '<redacted>' : v;
  }
  return out;
}

/**
 * Default capture implementation. Holds every recorded request in memory
 * until `writeInto()` is called. For a p90 run (~5k requests * ~50 KB
 * average body = 250 MB) that would strain SW memory, but debug mode is
 * an opt-in developer tool — the copy on the takeout page warns parents
 * to only enable it when asked.
 */
export class DebugCapture implements DebugCaptureInterface {
  readonly enabled: boolean;
  private entries: CapturedRequest[] = [];
  private seq = 0;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  get count(): number {
    return this.entries.length;
  }

  /** Assign a monotonic sequence number. Exposed so BwClient can pre-allocate. */
  nextSeq(): number {
    return ++this.seq;
  }

  record(entry: CapturedRequest): void {
    if (!this.enabled) return;
    let body = entry.body;
    let truncated = false;
    if (body && body.byteLength > MAX_CAPTURE_BODY_BYTES) {
      body = body.subarray(0, MAX_CAPTURE_BODY_BYTES);
      truncated = true;
    }
    this.entries.push({
      ...entry,
      body,
      // Attach the truncation flag as an out-of-band property; the request
      // log surfaces it.
      ...(truncated ? { _truncated: true } : {}),
    } as CapturedRequest & { _truncated?: boolean });
  }

  async writeInto(
    pushBytes: (name: string, bytes: Uint8Array) => Promise<void>,
  ): Promise<void> {
    if (!this.enabled) return;
    const logLines: string[] = [];
    for (const e of this.entries) {
      const seqPart = String(e.seq).padStart(5, '0');
      const slug = endpointSlug(e.url);
      let bodyFile: string | undefined;
      if (e.body && e.body.byteLength > 0) {
        bodyFile = `debug/${seqPart}-${slug}.json`;
        await pushBytes(bodyFile, e.body);
      }
      const truncated = (e as CapturedRequest & { _truncated?: boolean })._truncated ?? false;
      const line: RequestLogEntry = {
        seq: e.seq,
        method: e.method,
        url: e.url,
        status: e.status,
        durationMs: e.durationMs,
        ...(e.error ? { error: e.error } : {}),
        ...(bodyFile ? { bodyFile } : {}),
        ...(truncated ? { bodyTruncated: true } : {}),
      };
      logLines.push(JSON.stringify(line));
    }
    if (logLines.length > 0) {
      const jsonl = logLines.join('\n') + '\n';
      await pushBytes('debug/request-log.jsonl', new TextEncoder().encode(jsonl));
    }
  }
}
