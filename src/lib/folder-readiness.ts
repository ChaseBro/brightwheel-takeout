// Post-pick readiness check for FolderSink. Decides whether we should warn
// the user before writing into their picked folder (they may have accidentally
// pointed us at ~/Documents or ~/Downloads instead of a fresh archive folder).
//
// The guardian-mismatch check is separate (FolderSinkGuardianMismatchError) —
// this one is purely "is this folder full of unrelated stuff we might mix
// our export into?"

export interface DirectoryEntry {
  name: string;
  kind: 'file' | 'directory';
}

/** Files/folders the extension itself owns — never count against readiness. */
const OUR_FILE_STEMS = new Set([
  'manifest', 'notes', 'messages', 'photos', 'daily-reports', 'takeout',
]);
const OUR_DIRECTORIES = new Set(['photos', 'viewer', 'debug']);
const OUR_EXTS = new Set(['csv', 'json', 'xlsx', 'log']);

/** OS clutter that every non-empty folder collects and should never trigger a warning. */
const HIDDEN_CLUTTER = /^(\.|Thumbs\.db$|desktop\.ini$)/i;

/** Single-file XLSX exports have a `brightwheel-takeout-<date>.xlsx` shape. */
const SINGLE_FILE_PATTERN = /^brightwheel-takeout(-.*)?\.(csv|json|xlsx)$/i;

/** File-count threshold above which we prompt the user. */
const STRAY_THRESHOLD = 5;

function isOurArtifact(entry: DirectoryEntry): boolean {
  const name = entry.name;
  if (entry.kind === 'directory') return OUR_DIRECTORIES.has(name);
  if (SINGLE_FILE_PATTERN.test(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  const stem = name.slice(0, dot).toLowerCase();
  const ext = name.slice(dot + 1).toLowerCase();
  return OUR_EXTS.has(ext) && OUR_FILE_STEMS.has(stem);
}

export interface FolderReadiness {
  clean: boolean;
  nonBwFileCount: number;
}

/**
 * Read the top-level entries of a picked `FileSystemDirectoryHandle`. Not
 * unit-tested — it's a thin adaptor over the browser API. Callers pipe the
 * result into `folderReadinessSummary` (which IS unit-tested).
 */
export async function readTopLevelEntries(
  dh: { entries?: () => AsyncIterableIterator<[string, { kind: 'file' | 'directory' }]> },
): Promise<DirectoryEntry[]> {
  if (typeof dh.entries !== 'function') return [];
  const out: DirectoryEntry[] = [];
  for await (const [name, handle] of dh.entries()) {
    out.push({ name, kind: handle.kind });
    if (out.length > 200) break; // safety cap — we don't need more than a sample
  }
  return out;
}

export function folderReadinessSummary(entries: DirectoryEntry[]): FolderReadiness {
  // If our marker manifest.json is here, we already own the folder — the
  // guardian-mismatch check handles the "wrong guardian" case separately.
  const alreadyOurs = entries.some(
    (e) => e.kind === 'file' && e.name.toLowerCase() === 'manifest.json',
  );
  if (alreadyOurs) return { clean: true, nonBwFileCount: 0 };

  let nonBwFileCount = 0;
  for (const e of entries) {
    if (HIDDEN_CLUTTER.test(e.name)) continue;
    if (isOurArtifact(e)) continue;
    nonBwFileCount++;
  }
  return {
    clean: nonBwFileCount <= STRAY_THRESHOLD,
    nonBwFileCount,
  };
}
