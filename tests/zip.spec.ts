// @vitest-environment node
// client-zip creates a ReadableStream internally; jsdom's polyfill is missing
// getReader() in the version we're on. Node's native streams work fine.
import { describe, expect, it } from 'vitest';
import { EntrySink, collectZipBytes, pipeSinkToWritable } from '@/scraper/zip';

function bytesFromU16LE(u8: Uint8Array, off: number): number {
  return u8[off]! | (u8[off + 1]! << 8);
}
function bytesFromU32LE(u8: Uint8Array, off: number): number {
  return (
    u8[off]! |
    (u8[off + 1]! << 8) |
    (u8[off + 2]! << 16) |
    (u8[off + 3]! << 24)
  ) >>> 0;
}

function parseZip(bytes: Uint8Array): { files: Array<{ name: string; size: number }> } {
  // Find end-of-central-directory record (EOCD): 0x06054b50.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytesFromU32LE(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found; not a valid ZIP');
  const cdCount = bytesFromU16LE(bytes, eocd + 10);
  const cdSize = bytesFromU32LE(bytes, eocd + 12);
  const cdOff = bytesFromU32LE(bytes, eocd + 16);
  const files: Array<{ name: string; size: number }> = [];
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (bytesFromU32LE(bytes, p) !== 0x02014b50) throw new Error('bad central directory signature');
    const uncompSize = bytesFromU32LE(bytes, p + 24);
    const nameLen = bytesFromU16LE(bytes, p + 28);
    const extraLen = bytesFromU16LE(bytes, p + 30);
    const commentLen = bytesFromU16LE(bytes, p + 32);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files.push({ name, size: uncompSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== cdOff + cdSize) throw new Error('central directory size mismatch');
  return { files };
}

describe('EntrySink + client-zip', () => {
  it('produces a valid ZIP with the entries pushed into the sink', async () => {
    const sink = new EntrySink();
    sink.push({ name: 'a.txt', input: 'hello' });
    sink.push({ name: 'nested/b.json', input: JSON.stringify({ x: 1 }) });
    sink.push({ name: 'bin.dat', input: new Uint8Array([1, 2, 3, 4, 5]) });
    sink.close();
    const zipBytes = await collectZipBytes(sink);
    const parsed = parseZip(zipBytes);
    const names = parsed.files.map((f) => f.name).sort();
    expect(names).toEqual(['a.txt', 'bin.dat', 'nested/b.json']);
    const byName = new Map(parsed.files.map((f) => [f.name, f]));
    expect(byName.get('a.txt')!.size).toBe(5);
    expect(byName.get('bin.dat')!.size).toBe(5);
  });

  it('fail() rejects pending waiters so mid-run errors abort the pipe (no truncated ZIP)', async () => {
    // Regression: previously fail() resolved waiters with {done:true}, which
    // made client-zip close the WritableStream cleanly with an EOCD after
    // whatever entries had already been pushed — producing a structurally
    // valid but truncated archive on the parent's disk. We want the pipe
    // to throw so callers can react to the failure.
    const sink = new EntrySink();
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    const pipePromise = pipeSinkToWritable(sink, writable);

    // Push one entry, let the consumer start pulling.
    sink.push({ name: 'a.txt', input: 'hello' });
    // Yield so client-zip's reader picks up the entry and asks for the next.
    await new Promise((r) => setTimeout(r, 5));
    // Now the consumer is awaiting the next entry (`waiters` non-empty). Fail.
    sink.fail(new Error('boom'));

    let piped: 'ok' | 'threw' = 'ok';
    try {
      await pipePromise;
    } catch (err) {
      piped = 'threw';
      expect((err as Error).message).toBe('boom');
    }
    expect(piped).toBe('threw');

    // Even if the writer flushed a few bytes, they must NOT form a valid ZIP
    // (no EOCD signature was written after fail()).
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    let hasEocd = false;
    for (let i = 0; i + 4 <= merged.length; i++) {
      if (bytesFromU32LE(merged, i) === 0x06054b50) {
        hasEocd = true;
        break;
      }
    }
    expect(hasEocd).toBe(false);
  });

  it('supports async producers pushing after consumption starts', async () => {
    const sink = new EntrySink();
    const producer = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      sink.push({ name: 'late.txt', input: 'late arrival' });
      await new Promise((r) => setTimeout(r, 5));
      sink.close();
    })();
    const [zipBytes] = await Promise.all([collectZipBytes(sink), producer]);
    const parsed = parseZip(zipBytes);
    expect(parsed.files.map((f) => f.name)).toEqual(['late.txt']);
  });
});
