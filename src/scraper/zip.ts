// Streaming ZIP writer over the File System Access API.
//
// - `client-zip` produces a stream of ZIP bytes from an (async) iterable of
//   file entries — it never buffers the whole archive.
// - We pipe those bytes into the WritableStream returned by
//   `FileSystemFileHandle.createWritable()`, so the archive lands on disk
//   incrementally. This is what makes a 2.5 GB export viable in browser
//   memory.
// - `EntrySink` is a simple push queue that turns the pipeline into an
//   async iterable client-zip understands.

import { makeZip } from 'client-zip';

export type ZipEntry = {
  name: string;
  lastModified?: Date;
  input: Uint8Array | string;
};

// A tiny async queue: producers `push(entry)`, close(); consumers `for-await`.
//
// A "waiter" is a pending `.next()` call that arrived before the next entry
// was pushed. Waiters carry both a `resolve` and a `reject`, so `fail()` can
// reject them — critical for correctness: if a mid-run error resolved waiters
// with `{done: true}`, client-zip would think iteration ended normally and
// close the WritableStream, producing a structurally valid but *truncated*
// ZIP on the parent's disk. Rejecting instead aborts the pipeTo and lets
// callers observe the failure.
interface Waiter {
  resolve: (v: IteratorResult<ZipEntry, undefined>) => void;
  reject: (err: unknown) => void;
}

export class EntrySink implements AsyncIterable<ZipEntry> {
  private queue: ZipEntry[] = [];
  private waiters: Waiter[] = [];
  private closed = false;
  private erroredWith: unknown = null;

  push(entry: ZipEntry): void {
    if (this.closed) throw new Error('EntrySink.push after close');
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) {
        w.resolve({ value: entry, done: false });
        return;
      }
    }
    this.queue.push(entry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.resolve({ value: undefined, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.erroredWith = err ?? new Error('EntrySink.fail(): unknown error');
    this.closed = true;
    // Reject every pending waiter so a consumer awaiting the next entry
    // sees the failure (and the pipe into the WritableStream aborts) instead
    // of a clean "iteration ended".
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.reject(this.erroredWith);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ZipEntry, undefined> {
    return {
      next: (): Promise<IteratorResult<ZipEntry, undefined>> => {
        if (this.queue.length > 0) {
          const v = this.queue.shift()!;
          return Promise.resolve({ value: v, done: false });
        }
        if (this.erroredWith) return Promise.reject(this.erroredWith);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

/**
 * Feed a sink into `makeZip` and pipe the ZIP stream into a WritableStream.
 * Returns a Promise that resolves when the sink is closed and the archive
 * has been fully written.
 */
export async function pipeSinkToWritable(
  sink: EntrySink,
  writable: WritableStream<Uint8Array>,
): Promise<void> {
  const zipStream = makeZip(sink) as ReadableStream<Uint8Array>;
  await zipStream.pipeTo(writable);
}

/**
 * Convenience: collect all bytes in memory (for tests / small archives).
 * Do NOT use in the main run path — it defeats the streaming design.
 */
export async function collectZipBytes(sink: EntrySink): Promise<Uint8Array> {
  const zipStream = makeZip(sink) as ReadableStream<Uint8Array>;
  const reader = zipStream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
