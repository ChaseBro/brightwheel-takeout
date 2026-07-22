// Suggest a folder name the user can copy-paste when creating the destination
// folder in Finder / Explorer. Deliberately date-free — the welcome-back
// "get anything new" flow reuses the same folder across incremental exports.

const GENERIC = 'Brightwheel-Takeout';

export interface SuggestInput {
  studentIds: string[];
  studentNames: Record<string, string>;
}

/** Strip filesystem-hostile characters + collapse to a valid folder-name shape. */
function sanitize(raw: string): string {
  return raw
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // "Émilie" → "Emilie"
    .replace(/[/\\:*?"<>|]/g, '')                    // reserved on any OS
    .replace(/['`.]/g, '')                            // apostrophes / periods
    .replace(/\s+/g, '')                              // no whitespace
    .replace(/[^\p{L}\p{N}_-]/gu, '')                 // letters, digits, _, - only
    .trim();
}

/** First name only — a folder named after two full names is unwieldy. */
function firstName(full: string): string {
  return sanitize(full.trim().split(/\s+/)[0] ?? '');
}

export function suggestFolderName(x: SuggestInput): string {
  const names = x.studentIds
    .map((id) => firstName(x.studentNames[id] ?? ''))
    .filter((n) => n.length > 0);
  if (names.length === 0 || names.length > 2) return GENERIC;
  return `${GENERIC}-${names.join('-')}`;
}
