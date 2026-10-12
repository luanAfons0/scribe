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
import {
  makeDirectory,
  minutesCommand,
  startedAndShaken,
  startPluginServer,
} from './helpers/plugin.ts';

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
    env: { SCRIBE_MINUTES_COMMAND: minutesCommand() },
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

test(
  'a file from before the Topics keeps its Minutes, and gets Topics when made again',
  async (t) => {
    const directory = await makeDirectory(t);
    const old = new DatabaseSync(join(directory, 'scribe.db'));
    old.exec(VERSION_1);
    old.exec('ALTER TABLE calls ADD COLUMN title_given INTEGER NOT NULL DEFAULT 0');
    old.exec("UPDATE calls SET minutes = '## Velhas', minutes_state = 'made' WHERE id = 1");
    old.exec('PRAGMA user_version = 2');
    old.close();
    const plugin = await startedAndShaken(t, {
      directory,
      env: { SCRIBE_MINUTES_COMMAND: minutesCommand() },
    });

    const before = await getCall(plugin, 1);
    await plugin.call('make_minutes', { id: 1 });
    const after = await until(
      plugin,
      1,
      (call) => call.minutesState === 'made' && call.topics !== null,
    );

    assert.equal(before.minutes, '## Velhas');
    assert.equal(before.topics, null);
    assert.ok(after.topics?.includes('Prazo da entrega'), after.topics ?? '');
    assert.equal(plugin.output(), '');
  },
);

test(
  'a Call whose Topics went to Worklog on their own shows as sent, and one that did not, as unsent',
  async (t) => {
    const directory = await makeDirectory(t);
    const old = new DatabaseSync(join(directory, 'scribe.db'));
    old.exec(VERSION_1);
    old.exec('ALTER TABLE calls ADD COLUMN title_given INTEGER NOT NULL DEFAULT 0');
    old.exec('ALTER TABLE calls ADD COLUMN topics TEXT');
    old.exec('ALTER TABLE calls ADD COLUMN entry_id INTEGER');
    old.exec('ALTER TABLE calls ADD COLUMN entry_error TEXT');
    old.exec(
      "UPDATE calls SET minutes = '## Velhas', minutes_state = 'made', topics = '- Prazo', " +
        "entry_id = 7, entry_error = 'Make the Minutes again to send it.' WHERE id = 1",
    );
    old.exec(
      "INSERT INTO calls (state, started_at, ended_at, minutes, minutes_state, topics) VALUES " +
        "('ended', '2026-10-03T10:00:00.000Z', '2026-10-03T10:30:00.000Z', '## Outras', " +
        "'made', '- Outro')",
    );
    old.exec('PRAGMA user_version = 4');
    old.close();
    const plugin = await startedAndShaken(t, { directory });

    const sent = await getCall(plugin, 1);
    const unsent = await getCall(plugin, 2);

    assert.equal(sent.sentToWorklogAt, '2026-10-02T15:16:00.000Z');
    assert.equal(sent.entryId, 7);
    assert.equal(sent.topics, '- Prazo');
    assert.equal(sent.entryError, null, 'a sentence of the old send stayed');
    assert.equal(unsent.sentToWorklogAt, null);
    assert.equal(unsent.minutes, '## Outras');
    assert.equal(plugin.output(), '');
  },
);

test('a Call an older scribe sent counts as changed only once its Topics change', async (t) => {
  const directory = await makeDirectory(t);
  const old = new DatabaseSync(join(directory, 'scribe.db'));
  old.exec(VERSION_1);
  old.exec('ALTER TABLE calls ADD COLUMN title_given INTEGER NOT NULL DEFAULT 0');
  old.exec('ALTER TABLE calls ADD COLUMN topics TEXT');
  old.exec('ALTER TABLE calls ADD COLUMN entry_id INTEGER');
  old.exec('ALTER TABLE calls ADD COLUMN entry_error TEXT');
  old.exec('ALTER TABLE calls ADD COLUMN entry_sent_at TEXT');
  old.exec(
    "UPDATE calls SET minutes = '## Velhas', minutes_state = 'made', topics = '- Prazo', " +
      "entry_id = 7, entry_sent_at = '2026-10-02T15:16:00.000Z' WHERE id = 1",
  );
  old.exec('PRAGMA user_version = 5');
  old.close();
  const plugin = await startedAndShaken(t, {
    directory,
    env: { SCRIBE_MINUTES_COMMAND: minutesCommand() },
  });

  const before = await getCall(plugin, 1);
  await plugin.call('make_minutes', { id: 1 });
  const after = await until(plugin, 1, (call) => call.minutesState === 'made');

  assert.equal(before.topicsChangedSinceSent, false);
  assert.equal(before.sentToWorklogAt, '2026-10-02T15:16:00.000Z');
  assert.notEqual(after.topics, '- Prazo');
  assert.equal(after.topicsChangedSinceSent, true);
  assert.equal(plugin.output(), '');
});

test('a file from before Events keeps its Calls whole, each for no Event', async (t) => {
  const directory = await makeDirectory(t);
  const old = new DatabaseSync(join(directory, 'scribe.db'));
  old.exec(VERSION_1);
  old.exec('ALTER TABLE calls ADD COLUMN title_given INTEGER NOT NULL DEFAULT 0');
  old.exec('ALTER TABLE calls ADD COLUMN topics TEXT');
  old.exec('ALTER TABLE calls ADD COLUMN entry_id INTEGER');
  old.exec('ALTER TABLE calls ADD COLUMN entry_error TEXT');
  old.exec('ALTER TABLE calls ADD COLUMN entry_sent_at TEXT');
  old.exec('ALTER TABLE calls ADD COLUMN topics_written_at TEXT');
  old.exec(
    "UPDATE calls SET title = 'Meu título', title_given = 1, minutes = '## Velhas', " +
      "minutes_state = 'made', topics = '- Prazo', entry_id = 7, " +
      "entry_sent_at = '2026-10-02T15:16:00.000Z', " +
      "topics_written_at = '2026-10-02T15:10:00.000Z' WHERE id = 1",
  );
  old.exec('PRAGMA user_version = 6');
  old.close();
  const plugin = await startedAndShaken(t, { directory });

  const call = (await getCall(plugin, 1)) as Awaited<ReturnType<typeof getCall>> & {
    event: unknown;
  };

  assert.equal(call.title, 'Meu título');
  assert.equal(call.event, null);
  assert.equal(call.jottings, '# Prazo');
  assert.equal(call.transcript.length, 1);
  assert.equal(call.minutes, '## Velhas');
  assert.equal(call.topics, '- Prazo');
  assert.equal(call.entryId, 7);
  assert.equal(call.sentToWorklogAt, '2026-10-02T15:16:00.000Z');
  assert.equal(call.topicsChangedSinceSent, false);
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
