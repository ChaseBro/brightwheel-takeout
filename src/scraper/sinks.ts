// Output sinks — three implementations behind one interface so run.ts can
// pick where the export bytes actually land without caring about the format.
//
// - ZipSink wraps the existing client-zip pipeline (see zip.ts) and writes
//   into a WritableStream backed by a single FileSystemFileHandle. This is
//   the default and the only one that supports the standalone viewer.
// - SingleFileSink writes exactly ONE entry directly into a single
//   FileSystemFileHandle's WritableStream. Used when the include-set is one
//   logical file (e.g. "Notes as CSV only") so parents don't have to unzip
//   a 12-KB archive to read one file.
// - FolderSink wraps a FileSystemDirectoryHandle and drops every entry as a
//   real file on disk. For many parents this is nicer than a ZIP because
//   photos are immediately usable in Finder / Explorer.
//
// Each sink accepts push({name, bytes}) and close(). Concurrency: ZipSink
// serializes internally (client-zip is stream-of-entries), SingleFileSink
// rejects a second push, and FolderSink is safe for concurrent pushes
// (see `photoDownloadConcurrency` in PACING).

import { EntrySink, pipeSinkToWritable } from './zip.js';

export interface SinkEntry {
  name: string;
  bytes: Uint8Array | string;
  /** Optional last-modified for ZIP metadata; ignored by FolderSink. */
  lastModified?: Date;
}

export interface Sink {
  /** Push one file into the sink. Concurrency policy is per-implementation. */
  push(entry: SinkEntry): Promise<void>;
  /** Signal end-of-input; sink finalizes any pending work and closes. */
  close(): Promise<void>;
  /** Abort with an error; sink propagates through to the underlying stream. */
  fail(err: unknown): Promise<void>;
  /** Sink kind — useful for logging / test assertions. */
  readonly kind: 'zip' | 'single-file' | 'folder';
}

// ---- ZipSink ---------------------------------------------------------------

export class ZipSink implements Sink {
  readonly kind = 'zip' as const;
  private inner = new EntrySink();
  private pipe: Promise<void>;

  constructor(writable: WritableStream<Uint8Array>) {
    this.pipe = pipeSinkToWritable(this.inner, writable);
    // Suppress unhandled-rejection when close() hasn't been called yet;
    // callers observe the error via fail() → close() awaits `this.pipe`.
    this.pipe.catch(() => {});
  }

  async push(entry: SinkEntry): Promise<void> {
    this.inner.push({
      name: entry.name,
      lastModified: entry.lastModified,
      input: entry.bytes,
    });
  }

  async close(): Promise<void> {
    this.inner.close();
    await this.pipe;
  }

  async fail(err: unknown): Promise<void> {
    this.inner.fail(err);
    // Drain — the pipe rejection is the caller's signal that the sink aborted.
    await this.pipe.catch(() => {});
  }
}

// ---- SingleFileSink --------------------------------------------------------

/**
 * Single-file sink. Accepts exactly one push (the file name is informational —
 * the WritableStream was created against a user-picked path, so the name is
 * baked in already). A second push throws so callers with the wrong include-
 * set don't corrupt the output.
 */
export class SingleFileSink implements Sink {
  readonly kind = 'single-file' as const;
  private writable: WritableStream<Uint8Array>;
  private wroteOnce = false;

  constructor(writable: WritableStream<Uint8Array>) {
    this.writable = writable;
  }

  async push(entry: SinkEntry): Promise<void> {
    if (this.wroteOnce) {
      throw new Error(
        `SingleFileSink: already wrote one file, refusing "${entry.name}". Use ZipSink or FolderSink for multi-file exports.`,
      );
    }
    this.wroteOnce = true;
    const writer = this.writable.getWriter();
    try {
      const bytes = typeof entry.bytes === 'string'
        ? new TextEncoder().encode(entry.bytes)
        : entry.bytes;
      await writer.write(bytes);
    } finally {
      await writer.close();
    }
  }

  async close(): Promise<void> {
    if (!this.wroteOnce) {
      // No content was ever pushed — close the empty stream so the FS Access
      // handle finalizes. Parents see a zero-byte file, which is a clearer
      // failure signal than a hung tab.
      const writer = this.writable.getWriter();
      await writer.close();
    }
  }

  async fail(err: unknown): Promise<void> {
    try {
      await this.writable.abort(err);
    } catch {
      /* best-effort */
    }
  }
}

// ---- FolderSink ------------------------------------------------------------

/**
 * The subset of the FileSystemDirectoryHandle API we depend on. Declared
 * inline (rather than pulled from lib.dom's non-standard file-system types)
 * so tests can hand in a plain in-memory mock.
 */
export interface DirectoryHandleLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileHandleLike>;
}

export interface FileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

export interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

/**
 * Thrown by FolderSink.checkExistingGuardian when the picked folder already
 * contains a manifest.json attributed to a different guardian. The takeout
 * page catches this to ask the user whether to overwrite (which would produce
 * a Frankenstein archive: manifest from guardian B, photos merged from both).
 */
export class FolderSinkGuardianMismatchError extends Error {
  readonly name = 'FolderSinkGuardianMismatchError';
  constructor(
    public readonly existingGuardianId: string,
    public readonly newGuardianId: string,
  ) {
    super(
      `Folder already contains an export for guardian ${existingGuardianId.slice(0, 8)}…; refusing to mix with ${newGuardianId.slice(0, 8)}…`,
    );
  }
}

/**
 * Write every entry as a real file inside a picked folder, mirroring the ZIP
 * layout (photos/*.jpg, viewer/index.html, debug/*.json, etc.). Safe for
 * concurrent pushes — each entry walks the tree independently and writes
 * to its own file handle.
 *
 * Overwrite policy: silently overwrites existing files. The user picked this
 * folder knowing it's the export target; skipping would silently drop new
 * data on a re-run. Cross-guardian mixing is blocked by
 * `checkExistingGuardian` — call that BEFORE the first push when starting a
 * new export.
 */
export class FolderSink implements Sink {
  readonly kind = 'folder' as const;
  private root: DirectoryHandleLike;
  /** Cache directory handles so we don't re-walk the tree on each push. */
  private dirCache = new Map<string, Promise<DirectoryHandleLike>>();

  constructor(root: DirectoryHandleLike) {
    this.root = root;
  }

  /**
   * If the folder already contains a manifest.json attributed to a different
   * guardian, throw FolderSinkGuardianMismatchError. Returns silently for a
   * fresh folder or a same-guardian re-run. Reads only — never writes.
   */
  async checkExistingGuardian(newGuardianId: string): Promise<void> {
    let fh: FileHandleLike;
    try {
      fh = await this.root.getFileHandle('manifest.json', { create: false });
    } catch {
      return; // no prior manifest → fresh folder
    }
    let existing: string | undefined;
    try {
      // FileHandleLike doesn't declare .getFile — real FileSystemFileHandle
      // has it; we probe defensively.
      const withGetFile = fh as unknown as { getFile?: () => Promise<Blob> };
      if (typeof withGetFile.getFile !== 'function') return;
      const file = await withGetFile.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text) as { guardianId?: string };
      existing = parsed.guardianId;
    } catch {
      return; // unreadable / non-JSON — don't block on garbage
    }
    if (existing && existing !== newGuardianId) {
      throw new FolderSinkGuardianMismatchError(existing, newGuardianId);
    }
  }

  private resolveDir(segments: string[]): Promise<DirectoryHandleLike> {
    if (segments.length === 0) return Promise.resolve(this.root);
    const key = segments.join('/');
    const cached = this.dirCache.get(key);
    if (cached) return cached;
    const parentPromise = this.resolveDir(segments.slice(0, -1));
    const p = parentPromise.then((parent) =>
      parent.getDirectoryHandle(segments[segments.length - 1]!, { create: true }),
    );
    this.dirCache.set(key, p);
    return p;
  }

  async push(entry: SinkEntry): Promise<void> {
    const parts = entry.name.split('/').filter((s) => s.length > 0);
    const filename = parts.pop();
    if (!filename) throw new Error(`FolderSink: empty filename in "${entry.name}"`);
    const dir = await this.resolveDir(parts);
    const fh = await dir.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    const bytes = typeof entry.bytes === 'string'
      ? new TextEncoder().encode(entry.bytes)
      : entry.bytes;
    try {
      await writable.write(bytes);
    } finally {
      await writable.close();
    }
  }

  async close(): Promise<void> {
    // No finalization needed — each entry closed its own writable.
  }

  async fail(_err: unknown): Promise<void> {
    // Nothing to abort — inflight writes are per-file and have already
    // resolved by the time run.ts calls fail().
  }
}
