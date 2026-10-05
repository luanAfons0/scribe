/**
 * The Topics come with the Minutes, in the same answer of the command: a few
 * lines for Worklog, kept apart from the Minutes so that the Minutes keep
 * their shape.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { getCall, pcm, send, startCall, until } from './helpers/audio.ts';
import { FIXTURES, makeDirectory, startedAndShaken, type Started } from './helpers/plugin.ts';

const COMMAND = join(FIXTURES, 'minutes');

/** A Call with a line on the mic, stopped. */
async function stoppedCall(plugin: Started): Promise<number> {
  const id = await startCall(plugin);
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  await plugin.call('stop_call', { id });
  return id;
}

test('the Minutes come with their Topics, and the Minutes do not carry them', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_MINUTES_COMMAND: COMMAND } });
  const id = await stoppedCall(plugin);

  const call = await until(plugin, id, (seen) => seen.minutesState === 'made');

  assert.equal(call.topics, '- Prazo da entrega\n\nCombinamos a entrega para sexta.');
  assert.ok(call.minutes?.trimEnd().endsWith('## Próximos passos\n- Nenhuma.'), call.minutes ?? '');
  assert.ok(!call.minutes?.includes('topics'), call.minutes ?? '');
});

test('the prompt asks for the Topics, at most 20 lines, apart from the Minutes', async (t) => {
  const log = join(await makeDirectory(t), 'prompt.txt');
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: COMMAND, SCRIBE_TEST_PROMPT_LOG: log },
  });
  const id = await stoppedCall(plugin);
  await until(plugin, id, (seen) => seen.minutesState === 'made');

  const prompt = await readFile(log, 'utf8');

  assert.ok(prompt.includes('"<topics>"'), prompt);
  assert.ok(prompt.includes('"</topics>"'), prompt);
  assert.ok(prompt.includes('at most 20 lines'), prompt);
});

test('Topics longer than 20 lines are cut to 20', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: COMMAND, SCRIBE_TEST_TOPICS: 'long' },
  });
  const id = await stoppedCall(plugin);

  const call = await until(plugin, id, (seen) => seen.minutesState === 'made');

  const lines = call.topics?.split('\n') ?? [];
  assert.equal(lines.length, 20);
  assert.equal(lines.at(-1), '- Tópico 20');
});

test('an answer with no Topics still gives Minutes, and no Topics', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: COMMAND, SCRIBE_TEST_TOPICS: 'none' },
  });
  const id = await stoppedCall(plugin);

  const call = await until(
    plugin,
    id,
    (seen) => seen.minutesState !== 'none' && seen.minutesState !== 'making',
  );

  assert.equal(call.minutesState, 'made', call.minutesError ?? '');
  assert.equal(call.topics, null);
  assert.ok(call.minutes?.startsWith('## Prazo'), call.minutes ?? '');
});

test('Minutes saved by hand leave the Topics as they were', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_MINUTES_COMMAND: COMMAND } });
  const id = await stoppedCall(plugin);
  const made = await until(plugin, id, (seen) => seen.minutesState === 'made');

  await plugin.call('save_minutes', { id, minutes: '## Outra coisa' });

  const call = await getCall(plugin, id);
  assert.equal(call.minutes, '## Outra coisa');
  assert.equal(call.topics, made.topics);
});

test('a Call with no Minutes yet has no Topics', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  assert.equal((await getCall(plugin, id)).topics, null);
});
