// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FolderSink,
  FolderSinkGuardianMismatchError,
  SingleFileSink,
  ZipSink,
  type DirectoryHandleLike,
  type FileHandleLike,
  type WritableLike,
} from '@/scraper/sinks';

// ---- In-memory FS Access mock ---------------------------------------------

class MemFile implements FileHandleLike {
  bytes: Uint8Array = new Uint8Array();
  writes = 0;
  createWritable(): Promise<WritableLike> {
    const self = this;
    self.bytes = new Uint8Array();
    self.writes++;
    return Promise.resolve({
      async write(data: Uint8Array) {
        const combined = new Uint8Array(self.bytes.length + data.length);
        combined.set(self.bytes, 0);
        combined.set(data, self.bytes.length);
        self.bytes = combined;
      },
      async close() {},
    });
  }
  /** FolderSink.checkExistingGuardian probes for .getFile() defensively. */
  async getFile(): Promise<Blob> {
    return new Blob([this.bytes as BlobPart]);
  }
}

class MemDir implements DirectoryHandleLike {
  dirs = new Map<string, MemDir>();
  files = new Map<string, MemFile>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirectoryHandleLike> {
    let d = this.dirs.get(name);
    if (!d && opts?.create) {
      d = new MemDir();
      this.dirs.set(name, d);
    }
    if (!d) throw new Error(`NotFoundError: ${name}`);
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike> {
    let f = this.files.get(name);
    if (!f && opts?.create) {
      f = new MemFile();
      this.files.set(name, f);
    }
    if (!f) throw new Error(`NotFoundError: ${name}`);
    return f;
  }
  listPaths(prefix = ''): string[] {
    const out: string[] = [];
    for (const [n] of this.files) out.push(prefix + n);
    for (const [n, d] of this.dirs) out.push(...d.listPaths(prefix + n + '/'));
    return out.sort();
  }
  get(path: string): MemFile | null {
    const parts = path.split('/');
    let cur: MemDir = this;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = cur.dirs.get(parts[i]!);
      if (!d) return null;
      cur = d;
    }
    return cur.files.get(parts[parts.length - 1]!) ?? null;
  }
}

// ---- FolderSink -----------------------------------------------------------

describe('FolderSink', () => {
  it('writes files at the folder root and inside subdirectories', async () => {
    const root = new MemDir();
    const sink = new FolderSink(root);
    await sink.push({ name: 'notes.csv', bytes: new TextEncoder().encode('a,b\n1,2') });
    await sink.push({ name: 'photos/2026-06-15_p1.jpg', bytes: new Uint8Array([1, 2, 3]) });
    await sink.push({ name: 'viewer/index.html', bytes: '<h1>Hi</h1>' });
    await sink.close();
    expect(root.listPaths()).toEqual([
      'notes.csv',
      'photos/2026-06-15_p1.jpg',
      'viewer/index.html',
    ]);
    expect(root.get('photos/2026-06-15_p1.jpg')!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(new TextDecoder().decode(root.get('viewer/index.html')!.bytes)).toBe('<h1>Hi</h1>');
  });

  it('overwrites existing files silently', async () => {
    const root = new MemDir();
    const sink = new FolderSink(root);
    await sink.push({ name: 'notes.csv', bytes: 'first' });
    await sink.push({ name: 'notes.csv', bytes: 'second' });
    expect(new TextDecoder().decode(root.get('notes.csv')!.bytes)).toBe('second');
  });

  it('handles concurrent pushes without racing on directory creation', async () => {
    const root = new MemDir();
    const sink = new FolderSink(root);
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        sink.push({ name: `photos/p${i}.jpg`, bytes: new Uint8Array([i]) }),
      ),
    );
    // Only one `photos` directory should have been created.
    expect(root.dirs.size).toBe(1);
    expect(root.dirs.get('photos')!.files.size).toBe(5);
  });

  it('rejects an empty file name', async () => {
    const root = new MemDir();
    const sink = new FolderSink(root);
    await expect(sink.push({ name: '', bytes: 'x' })).rejects.toThrow(/empty filename/);
    await expect(sink.push({ name: '///', bytes: 'x' })).rejects.toThrow(/empty filename/);
  });

  describe('checkExistingGuardian (M6)', () => {
    it('returns silently for a fresh folder', async () => {
      const root = new MemDir();
      const sink = new FolderSink(root);
      await expect(sink.checkExistingGuardian('g-new')).resolves.toBeUndefined();
    });

    it('returns silently when the existing manifest names the same guardian', async () => {
      const root = new MemDir();
      const sink = new FolderSink(root);
      await sink.push({
        name: 'manifest.json',
        bytes: new TextEncoder().encode(JSON.stringify({ guardianId: 'g-same' })),
      });
      await expect(sink.checkExistingGuardian('g-same')).resolves.toBeUndefined();
    });

    it('throws FolderSinkGuardianMismatchError when a different guardian owns the folder', async () => {
      const root = new MemDir();
      const sink = new FolderSink(root);
      await sink.push({
        name: 'manifest.json',
        bytes: new TextEncoder().encode(JSON.stringify({ guardianId: 'g-other' })),
      });
      await expect(sink.checkExistingGuardian('g-me')).rejects.toThrow(FolderSinkGuardianMismatchError);
      try {
        await sink.checkExistingGuardian('g-me');
      } catch (err) {
        expect((err as FolderSinkGuardianMismatchError).existingGuardianId).toBe('g-other');
        expect((err as FolderSinkGuardianMismatchError).newGuardianId).toBe('g-me');
      }
    });

    it('does not block on garbage / non-JSON manifest.json', async () => {
      const root = new MemDir();
      const sink = new FolderSink(root);
      await sink.push({ name: 'manifest.json', bytes: 'not json {{{' });
      await expect(sink.checkExistingGuardian('g-me')).resolves.toBeUndefined();
    });
  });
});

// ---- SingleFileSink -------------------------------------------------------

describe('SingleFileSink', () => {
  function collect(): { writable: WritableStream<Uint8Array>; chunks: Uint8Array[] } {
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    return { writable, chunks };
  }

  it('writes exactly one entry to the underlying stream', async () => {
    const { writable, chunks } = collect();
    const sink = new SingleFileSink(writable);
    await sink.push({ name: 'notes.csv', bytes: new TextEncoder().encode('a,b\n') });
    await sink.close();
    const merged = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    expect(new TextDecoder().decode(merged)).toBe('a,b\n');
  });

  it('throws on a second push (single-file guarantee)', async () => {
    const { writable } = collect();
    const sink = new SingleFileSink(writable);
    await sink.push({ name: 'first.csv', bytes: 'x' });
    await expect(sink.push({ name: 'second.csv', bytes: 'y' })).rejects.toThrow(/SingleFileSink/);
  });
});

// ---- ZipSink --------------------------------------------------------------

describe('ZipSink', () => {
  it('wraps the client-zip pipeline and emits a valid archive', async () => {
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    const sink = new ZipSink(writable);
    await sink.push({ name: 'a.txt', bytes: 'hello' });
    await sink.push({ name: 'nested/b.txt', bytes: 'world' });
    await sink.close();
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    // A valid ZIP with 2 entries is comfortably above ~120 bytes.
    expect(total).toBeGreaterThan(120);
    // EOCD signature must be present.
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    let hasEocd = false;
    for (let i = merged.length - 22; i >= 0; i--) {
      if (
        merged[i] === 0x50 &&
        merged[i + 1] === 0x4b &&
        merged[i + 2] === 0x05 &&
        merged[i + 3] === 0x06
      ) {
        hasEocd = true;
        break;
      }
    }
    expect(hasEocd).toBe(true);
  });
});
