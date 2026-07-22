// Vitest globalSetup: copies real Brightwheel API captures from the user's
// personal notes vault into extension/tests/fixtures/ (gitignored) so the
// unit tests can exercise pagination + pagination + envelopes against the
// same shape the extension will see in production. If the source files
// don't exist (e.g. CI without the notes vault mounted), we synthesize
// minimal fixtures so the tests can still run.

import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, 'fixtures');
const SRC_DIR = resolve(
  process.env.BW_NOTES_REPO ?? resolve(homedir(), 'src/notes/Library/Brightwheel'),
);

const FILES = [
  ['eliza-notes.json', synthNotes],
  ['eliza-messages.json', synthMessages],
];

function synthNotes() {
  const now = new Date().toISOString();
  return {
    source: 'brightwheel',
    kind: 'notes (action_type=ac_note)',
    student_id: '00000000-0000-0000-0000-000000000001',
    date_range: { start: '2018-01-01T00:00:00.000Z', end: now },
    fetched_at: now,
    count: 2,
    notes: [
      {
        object_id: 'note-aaaa',
        action_type: 'ac_note',
        event_date: now,
        actor: { object_id: 'a-1', first_name: 'Teacher', last_name: 'One' },
        note: 'Fixture note 1',
      },
      {
        object_id: 'note-bbbb',
        action_type: 'ac_note',
        event_date: '2024-01-01T00:00:00.000Z',
        actor: { object_id: 'a-1', first_name: 'Teacher', last_name: 'One' },
        note: 'Fixture note 2',
      },
    ],
  };
}
function synthMessages() {
  const now = new Date().toISOString();
  return {
    source: 'brightwheel',
    kind: 'messages (single thread)',
    guardian_id: '00000000-0000-0000-0000-0000000000aa',
    thread_id: '00000000-0000-0000-0000-0000000000bb',
    fetched_at: now,
    count: 2,
    reported_count: 2,
    messages: [
      {
        object_id: 'msg-aaaa',
        type: 'simple_message',
        body: 'Fixture msg 1',
        sender: { object_id: 's-1', first_name: 'Teacher', last_name: 'One' },
        created_at: now,
      },
      {
        object_id: 'msg-bbbb',
        type: 'simple_message',
        body: 'Fixture msg 2',
        sender: { object_id: 's-2', first_name: 'Karen', last_name: 'Two' },
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ],
  };
}

export async function setup() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [name, synth] of FILES) {
    const dest = resolve(FIXTURE_DIR, name);
    if (existsSync(dest)) continue;
    const src = resolve(SRC_DIR, name);
    if (existsSync(src)) {
      copyFileSync(src, dest);
    } else {
      writeFileSync(dest, JSON.stringify(synth(), null, 2));
    }
  }
}
