/**
 * `scribe.db` from an older scribe opens, moves up to the current schema, and
 * keeps every Call in it. A file at a schema this scribe does not know is
 * refused with a sentence rather than guessed at.
 */
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { getCall, until } from './helpers/audio.ts';
import { FIXTURES, makeDirectory, startedAndShaken, startPluginServer } from './helpers/plugin.ts';

/** The schema the first scribe wrote, at version 1, with one Call in it. */
const VERSION_1 = `
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
  PRAGMA user_version = 1;
  INSERT INTO calls (state, started_at, ended_at, jottings, minutes_state)
    VALUES ('ended', '2026-10-02T14:56:00.000Z', '2026-10-02T15:16:00.000Z', '# Prazo', 'making');
  INSERT INTO lines (call_id, track, start_ms, end_ms, text)
    VALUES (1, 'tab', 0, 2000, 'para ver se foi utilizando.');
`;

test('a file from the first scribe keeps its Call and gets its Minutes made', async (t) => {
  const directory = await makeDirectory(t);
  const old = new DatabaseSync(join(directory, 'scribe.db'));
  old.exec(VERSION_1);
  old.close();
  const plugin = await startedAndShaken(t, {
    directory,
    env: { SCRIBE_MINUTES_COMMAND: join(FIXTURES, 'minutes') },
  });

  const before = await getCall(plugin, 1);
  await plugin.call('make_minutes', { id: 1 });
  const after = await until(plugin, 1, (call) => call.minutesState === 'made');
  await plugin.call('rename_call', { id: 1, title: 'Meu título' });

  assert.equal(before.jottings, '# Prazo');
  assert.equal(before.transcript.length, 1);
  assert.equal(before.minutesState, 'failed', 'Minutes left making were not marked failed');
  assert.equal(after.title, 'Prazo da entrega');
  assert.equal((await getCall(plugin, 1)).title, 'Meu título');
  assert.equal(plugin.output(), '');
});

test('a file at a schema newer than this scribe knows is refused with a sentence', async (t) => {
  const directory = await makeDirectory(t);
  const newer = new DatabaseSync(join(directory, 'scribe.db'));
  newer.exec('PRAGMA user_version = 99');
  newer.close();
  const plugin = await startPluginServer(t, { directory });

  const ending = await plugin.ended();

  assert.notEqual(ending.code, 0);
  assert.ok(plugin.output().includes('schema version 99'), plugin.output());
});
