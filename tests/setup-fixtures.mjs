// Vitest globalSetup: prepares extension/tests/fixtures/ (gitignored) with
// the note/message payloads tests/activities.spec.ts and tests/messages.spec.ts
// read from disk.
//
// HERMETIC BY DEFAULT: the fixtures written here are synthesized in-process
// and fully deterministic — no real dates, no network, no dependency on
// anything outside this repo. Every machine (and every one of N parallel
// review agents on the same machine) gets byte-identical fixtures and
// therefore byte-identical test behavior.
//
// Pulling real captures from the personal notes vault is STRICTLY OPT-IN via
// BW_TEST_USE_VAULT_FIXTURES=1. This existed before as an unconditional
// "copy if present" default, which meant:
//   (a) test behavior silently differed between the author's machine (which
//       has the vault) and every other machine/CI/reviewer, and
//   (b) a real child's real notes/messages could end up feeding test
//       fixtures (and, since this dir is gitignored but not otherwise
//       protected, sitting around on disk) without anyone asking for that.
// Opt-in fixes both: nobody gets real data unless they explicitly ask for
// it AND set BW_NOTES_REPO/rely on the default vault path.
//
// IMPORTANT: this always regenerates the synthesized fixtures (overwriting
// whatever's on disk) when vault mode is off, so a fixtures/ directory left
// over from a previous BW_TEST_USE_VAULT_FIXTURES=1 run (or from before this
// change) can never silently keep real data in the loop. Vault mode only
// copies a file if it doesn't already have today's synthesized content is
// irrelevant — vault mode always copies fresh from the source path too, so
// "stale real data masking a config change" isn't possible either.

import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, 'fixtures');

// Opt-in gate. Any of the vault-related env vars being set without this
// being truthy is very likely a mistake (e.g. a stray BW_NOTES_REPO left in
// a shell profile) — we deliberately do NOT infer opt-in from BW_NOTES_REPO
// alone, so accidentally exporting it never changes test behavior.
const USE_VAULT = /^(1|true|yes)$/i.test(process.env.BW_TEST_USE_VAULT_FIXTURES ?? '');
const SRC_DIR = resolve(
  process.env.BW_NOTES_REPO ?? resolve(homedir(), 'src/notes/Library/Brightwheel'),
);

// Fixed reference instant — NOT `new Date()`. Using the real clock here was
// the other hermeticity bug: identical inputs would still fingerprint
// differently run-to-run (and `fetched_at`/`date_range.end` would silently
// drift across machines/timezone-adjacent runs), which is exactly the kind
// of nondeterminism that makes "N agents, N different results" possible.
const FIXED_NOW = '2026-01-15T12:00:00.000Z';

const FILES = [
  ['eliza-notes.json', synthNotes],
  ['eliza-messages.json', synthMessages],
];

// tests/activities.spec.ts slices up to index 5 (needs >=5 notes) and
// exercises dedupe (needs distinct object_ids). 8 gives headroom.
function synthNotes() {
  const notes = Array.from({ length: 8 }, (_, i) => ({
    object_id: `fixture-note-${i}`,
    action_type: 'ac_note',
    // Descending, distinct, deterministic — index 0 is "most recent".
    event_date: `2026-01-${String(15 - i).padStart(2, '0')}T09:00:00.000Z`,
    actor: { object_id: 'fixture-teacher-1', first_name: 'Fixture', last_name: 'Teacher' },
    target: {
      object_id: 'fixture-student-1',
      first_name: 'Fixture',
      last_name: 'Student',
    },
    room: { object_id: 'fixture-room-1', name: 'Fixture Room', school_id: 'fixture-school-1' },
    note: `Synthesized fixture note #${i}`,
  }));
  return {
    source: 'brightwheel',
    kind: 'notes (action_type=ac_note)',
    student_id: 'fixture-student-1',
    date_range: { start: '2018-01-01T00:00:00.000Z', end: FIXED_NOW },
    fetched_at: FIXED_NOW,
    count: notes.length,
    notes,
  };
}

// tests/messages.spec.ts slices up to index 6 (needs >=6 messages).
function synthMessages() {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    object_id: `fixture-msg-${i}`,
    type: 'simple_message',
    body: `Synthesized fixture message #${i}`,
    sender: {
      object_id: i % 2 === 0 ? 'fixture-teacher-1' : 'fixture-teacher-2',
      first_name: 'Fixture',
      last_name: i % 2 === 0 ? 'TeacherOne' : 'TeacherTwo',
    },
    created_at: `2026-01-${String(15 - i).padStart(2, '0')}T09:00:00.000Z`,
  }));
  return {
    source: 'brightwheel',
    kind: 'messages (single thread)',
    guardian_id: 'fixture-guardian-1',
    thread_id: 'fixture-thread-1',
    fetched_at: FIXED_NOW,
    count: messages.length,
    reported_count: messages.length,
    messages,
  };
}

export async function setup() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [name, synth] of FILES) {
    const dest = resolve(FIXTURE_DIR, name);
    if (USE_VAULT) {
      const src = resolve(SRC_DIR, name);
      if (existsSync(src)) {
        copyFileSync(src, dest);
        continue;
      }
      // Opt-in was explicit — a silent fallback would hide a broken
      // BW_NOTES_REPO/vault path from whoever asked for real fixtures.
      // eslint-disable-next-line no-console
      console.warn(
        `[setup-fixtures] BW_TEST_USE_VAULT_FIXTURES=1 but ${src} does not exist — ` +
          `falling back to synthesized fixtures for ${name}.`,
      );
    }
    // Deterministic default. Always (re)written — never left stale from a
    // prior vault-mode run — so this is the one true hermetic path.
    writeFileSync(dest, JSON.stringify(synth(), null, 2));
  }
}
