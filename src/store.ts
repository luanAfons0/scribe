/**
 * The one SQLite file, `scribe.db`, where every Call lives with its Jottings,
 * its Transcript and its Minutes (FirstMate ADR-0005).
 *
 * The file is in the Plugin's own directory, which is where the Host starts
 * the Plugin Server, so it is one relative path away. Its schema version is
 * `PRAGMA user_version`: opening an older file moves it up to the current
 * version, one step at a time, and a newer file than this code knows is
 * refused rather than guessed at. Audio is never kept here: it is files in
 * `audio/`, and only until Whisper has read them.
 */
import { DatabaseSync } from 'node:sqlite';

/** Where the data lives, relative to the Plugin directory. */
export const FILE = 'scribe.db';

/** The Store: one open connection to `scribe.db`. */
export type Store = DatabaseSync;

/**
 * Each step moves the file up one version. A step is never edited once it
 * has shipped; a change to the schema is a new step at the end.
 */
const STEPS: readonly string[] = [
  // A line's moment is milliseconds from the start of its Call, counted in the
  // audio of its own track, so no clock of the page or the Plugin Server is
  // in it. Deleting a Call deletes its lines.
  `
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY,
    title TEXT,
    state TEXT NOT NULL CHECK (state IN ('recording', 'ended', 'cut')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    jottings TEXT NOT NULL DEFAULT '',
    minutes TEXT,
    minutes_state TEXT NOT NULL DEFAULT 'none'
      CHECK (minutes_state IN ('none', 'making', 'made', 'failed')),
    minutes_error TEXT
  );
  CREATE UNIQUE INDEX one_recording_call ON calls (state) WHERE state = 'recording';
  CREATE TABLE lines (
    id INTEGER PRIMARY KEY,
    call_id INTEGER NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    track TEXT NOT NULL CHECK (track IN ('mic', 'tab')),
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX lines_by_call ON lines (call_id, start_ms);
  `,
  // A title is proposed by the Minutes until the operator gives one; then
  // `title_given` is 1 and no proposal replaces it. Every Call there already
  // was keeps the title it had, as a proposal.
  `
  ALTER TABLE calls ADD COLUMN title_given INTEGER NOT NULL DEFAULT 0;
  `,
  // The Topics come with the Minutes the command made, for Worklog. A Call
  // from before them has none until its Minutes are made again.
  `
  ALTER TABLE calls ADD COLUMN topics TEXT;
  `,
  // The Worklog Entry a Call's Topics went to, kept so that making the
  // Minutes again changes that Entry rather than adding one, and the sentence
  // that says why the last one could not be sent.
  `
  ALTER TABLE calls ADD COLUMN entry_id INTEGER;
  ALTER TABLE calls ADD COLUMN entry_error TEXT;
  `,
  // When the Topics last went to Worklog, now that they go only when the
  // operator sends them. A Call the Minutes sent on their own before has an
  // Entry already: it counts as sent when it ended, so it is not sent twice.
  // A sentence the old send left says to make the Minutes again, which sends
  // nothing now, so it goes.
  `
  ALTER TABLE calls ADD COLUMN entry_sent_at TEXT;
  UPDATE calls SET entry_sent_at = COALESCE(ended_at, started_at) WHERE entry_id IS NOT NULL;
  UPDATE calls SET entry_error = NULL;
  `,
];

/** Open `scribe.db`, and bring it up to the current version. */
export function openStore(path: string = FILE): Store {
  const store = new DatabaseSync(path);
  store.exec('PRAGMA foreign_keys = ON');
  // A deleted Call leaves nothing behind: SQLite writes zeros over what it
  // deletes instead of leaving it in free pages of the file.
  store.exec('PRAGMA secure_delete = ON');
  const row = store.prepare('PRAGMA user_version').get() as { user_version: number };
  const version = row.user_version;
  if (version > STEPS.length) {
    throw new Error(
      `${path} is at schema version ${version}, and this scribe knows only up to ` +
        `${STEPS.length}. Run a newer scribe, or restore an older copy of the file.`,
    );
  }
  for (let step = version; step < STEPS.length; step += 1) {
    within(store, () => {
      store.exec(STEPS[step] ?? '');
      store.exec(`PRAGMA user_version = ${step + 1}`);
    });
  }
  return store;
}

/** Do this work in one transaction: all of it lands, or none of it does. */
export function within<T>(store: Store, work: () => T): T {
  store.exec('BEGIN IMMEDIATE');
  try {
    const done = work();
    store.exec('COMMIT');
    return done;
  } catch (fault) {
    store.exec('ROLLBACK');
    throw fault;
  }
}

/** Now, as the Store writes a moment. */
export function now(): string {
  return new Date().toISOString();
}
