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
  // A title is proposed by the Minutes until the operator gives one; then
  // `title_given` is 1 and no proposal replaces it.
  // A line's moment is milliseconds from the start of its Call, counted in the
  // audio of its own track, so no clock of the page or the Plugin Server is
  // in it. Deleting a Call deletes its lines.
  `
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY,
    title TEXT,
    title_given INTEGER NOT NULL DEFAULT 0,
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
