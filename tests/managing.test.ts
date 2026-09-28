/**
 * Finished Calls are managed from the page: listed newest first, renamed,
 * their Minutes edited by hand, and deleted with nothing left behind. The
 * Transcript is the record of the Call, and no tool changes it.
 */
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { getCall, pcm, send, startCall, transcribed, until } from './helpers/audio.ts';
import { FIXTURES, startedAndShaken, structureOf, type Started } from './helpers/plugin.ts';

type Listed = { calls: { id: number; title: string | null; state: string }[] };

async function finishedCall(plugin: Started, jottings = ''): Promise<number> {
  const id = await startCall(plugin);
  if (jottings !== '') await plugin.call('save_jottings', { id, jottings });
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  await plugin.call('stop_call', { id });
  await transcribed(plugin, id);
  return id;
}

test('the list names every Call, newest first', async (t) => {
  const plugin = await startedAndShaken(t);
  const first = await finishedCall(plugin);
  const second = await finishedCall(plugin);
  const third = await startCall(plugin);

  const listed = structureOf<Listed>(await plugin.call('list_calls'));

  assert.deepEqual(
    listed.calls.map((call) => call.id),
    [third, second, first],
  );
  assert.deepEqual(
    listed.calls.map((call) => call.state),
    ['recording', 'ended', 'ended'],
  );
});

test('a Call renamed and its Minutes edited read back as given', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await finishedCall(plugin);

  await plugin.call('rename_call', { id, title: '  Planejamento Q4  ' });
  await plugin.call('save_minutes', { id, minutes: '## Planejamento\n- corrigido à mão' });
  const call = await getCall(plugin, id);

  assert.equal(call.title, 'Planejamento Q4');
  assert.equal(call.minutes, '## Planejamento\n- corrigido à mão');
  assert.equal(call.minutesState, 'made');
});

test('a title given by hand is kept when the Minutes are made again', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: join(FIXTURES, 'minutes') },
  });
  const id = await finishedCall(plugin);
  await until(plugin, id, (call) => call.minutesState === 'made');
  await plugin.call('rename_call', { id, title: 'Meu título' });

  await plugin.call('make_minutes', { id });
  const call = await until(plugin, id, (seen) => seen.minutesState === 'made');

  assert.equal(call.title, 'Meu título');
});

test('a title that is empty or more than one line is refused with a sentence', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await finishedCall(plugin);

  const empty = await plugin.call('rename_call', { id, title: '   ' });
  const lines = await plugin.call('rename_call', { id, title: 'one\ntwo' });

  assert.ok(empty.error?.message.includes('one line'), empty.error?.message);
  assert.ok(lines.error?.message.includes('one line'), lines.error?.message);
});

test('a deleted Call leaves nothing of it behind', async (t) => {
  const plugin = await startedAndShaken(t);
  const kept = await finishedCall(plugin, 'fica aqui');
  const id = await finishedCall(plugin, 'segredo-da-chamada-apagada');
  await plugin.call('save_minutes', { id, minutes: 'ata-da-chamada-apagada' });

  const answer = await plugin.call('delete_call', { id });
  plugin.stop();
  await plugin.ended();

  assert.equal(answer.error, undefined, answer.error?.message);
  const again = await startedAndShaken(t, { directory: plugin.directory });
  const listed = structureOf<Listed>(await again.call('list_calls'));
  assert.deepEqual(listed.calls.map((call) => call.id), [kept]);
  const gone = await again.call('get_call', { id });
  assert.ok(gone.error?.message.includes(`There is no Call ${id}`), gone.error?.message);
  const bytes = await readFile(join(plugin.directory, 'scribe.db'), 'latin1');
  assert.ok(!bytes.includes('segredo-da-chamada-apagada'), 'the Jottings are still in the file');
  assert.ok(!bytes.includes('ata-da-chamada-apagada'), 'the Minutes are still in the file');
  assert.ok(bytes.includes('fica aqui'), 'the Call that was kept is gone too');
  const audio = await readdir(join(plugin.directory, 'audio')).catch(() => []);
  assert.deepEqual(audio, []);
});

test('a Call deleted while Whisper still has its audio leaves no audio behind', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);
  await send(plugin, id, 'tab', pcm([{ seconds: 20, level: 3000 }]));
  await plugin.call('stop_call', { id });

  await plugin.call('delete_call', { id });
  await new Promise((done) => setTimeout(done, 500));

  const audio = await readdir(join(plugin.directory, 'audio')).catch(() => []);
  assert.deepEqual(audio, []);
  assert.ok(!plugin.output().includes('could not read'), plugin.output());
});

test('a Call that records is not deleted', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  const answer = await plugin.call('delete_call', { id });

  assert.ok(answer.error?.message.includes('still recording'), answer.error?.message);
  assert.equal((await getCall(plugin, id)).state, 'recording');
});

test('no tool changes a Transcript', async (t) => {
  const plugin = await startedAndShaken(t);

  const { tools } = (await plugin.ask('tools/list')).result as {
    tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
  };

  for (const tool of tools) {
    assert.ok(!/transcript|line/i.test(tool.name), `${tool.name} looks like it edits one`);
    assert.ok(
      !Object.keys(tool.inputSchema.properties).some((name) => /transcript|line/i.test(name)),
      `${tool.name} takes a Transcript`,
    );
  }
});
