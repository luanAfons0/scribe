/**
 * The Minutes come from the command in SCRIBE_MINUTES_COMMAND: it reads a
 * prompt of the Jottings, the Transcript and the rules, and prints a title and
 * the Minutes. With no command, only Make Minutes is refused.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { getCall, pcm, send, startCall, transcribed, until } from './helpers/audio.ts';
import { FIXTURES, makeDirectory, startedAndShaken, type Started } from './helpers/plugin.ts';

const COMMAND = join(FIXTURES, 'minutes');

/** A Call with Jottings and a line on each track, stopped. */
async function stoppedCall(plugin: Started): Promise<number> {
  const id = await startCall(plugin);
  await plugin.call('save_jottings', { id, jottings: '# Prazo\nentrega sexta' });
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  await send(plugin, id, 'tab', pcm([{ seconds: 2 }, { seconds: 1, level: 4000 }]));
  await plugin.call('stop_call', { id });
  return id;
}

test('a stopped Call gets its Minutes and a proposed title at once', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_MINUTES_COMMAND: COMMAND } });
  const id = await stoppedCall(plugin);

  const call = await until(plugin, id, (seen) => seen.minutesState === 'made');

  assert.equal(call.title, 'Prazo da entrega');
  assert.ok(call.minutes?.startsWith('## Prazo'), call.minutes ?? '');
  assert.ok(call.minutes?.includes('2 linhas lidas'), 'the Minutes came before the Transcript');
  assert.ok(!call.minutes?.includes('TITLE'), call.minutes ?? '');
});

test('the prompt holds the Jottings, the Transcript and the rules', async (t) => {
  const log = join(await makeDirectory(t), 'prompt.txt');
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: COMMAND, SCRIBE_TEST_PROMPT_LOG: log },
  });
  const id = await stoppedCall(plugin);
  await until(plugin, id, (seen) => seen.minutesState === 'made');

  const prompt = await readFile(log, 'utf8');

  assert.ok(prompt.includes('# Prazo\nentrega sexta'), prompt);
  assert.ok(prompt.includes('[00:00] Eu: tone 3000'), prompt);
  assert.ok(prompt.includes('[00:02] Outros: tone 4000'), prompt);
  assert.ok(prompt.includes('## Decisões'), 'the prompt does not ask for Decisões');
  assert.ok(prompt.includes('## Próximos passos'), 'the prompt does not ask for Próximos passos');
  assert.ok(prompt.includes('language spoken in the Transcript'), 'no rule on the language');
  assert.ok(prompt.includes('TITLE: '), 'the prompt asks for no title');
  assert.ok(prompt.includes('in its order'), 'no rule on keeping the headings in order');
});

test('with no command set, Make Minutes is refused with a sentence and the Transcript is there', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await stoppedCall(plugin);
  const call = await transcribed(plugin, id);

  const answer = await plugin.call('make_minutes', { id });

  assert.equal(answer.error?.code, -32602);
  assert.ok(answer.error?.message.includes('SCRIBE_MINUTES_COMMAND'), answer.error?.message);
  assert.equal(call.minutesState, 'none');
  assert.equal(call.transcript.length, 2);
});

test('a command that is not found is refused with a sentence that names the setting', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: 'no-such-model-runner --fast' },
  });
  const id = await stoppedCall(plugin);
  const call = await until(plugin, id, (seen) => seen.minutesState === 'failed');

  const answer = await plugin.call('make_minutes', { id });

  assert.ok(answer.error?.message.includes('SCRIBE_MINUTES_COMMAND'), answer.error?.message);
  assert.ok(answer.error?.message.includes('no-such-model-runner'), answer.error?.message);
  assert.ok(call.minutesError?.includes('absolute path'), call.minutesError ?? '');
  assert.equal(call.transcript.length, 2);
});

test('a command that starts with a word sh runs itself is run by sh', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: `cd /tmp && exec ${COMMAND}` },
  });
  const id = await stoppedCall(plugin);

  const call = await until(
    plugin,
    id,
    (seen) => seen.minutesState !== 'none' && seen.minutesState !== 'making',
  );

  assert.equal(call.minutesState, 'made', call.minutesError ?? '');
});

test('a command that fails leaves the Minutes failed, with what it said', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: COMMAND, SCRIBE_TEST_MINUTES_FAIL: '1' },
  });
  const id = await stoppedCall(plugin);

  const call = await until(plugin, id, (seen) => seen.minutesState === 'failed');

  assert.ok(call.minutesError?.includes('model "nada" not found'), call.minutesError ?? '');
  assert.equal(call.minutes, null);
});

test('Minutes are made again on a Cut Call', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: COMMAND, SCRIBE_CUT_AFTER_MS: '300' },
  });
  const id = await startCall(plugin);
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  const cut = await until(plugin, id, (seen) => seen.state === 'cut' && !seen.transcribing);
  assert.equal(cut.minutesState, 'none', 'a Cut Call got Minutes nobody asked for');

  await plugin.call('make_minutes', { id });
  const call = await until(plugin, id, (seen) => seen.minutesState === 'made');

  assert.equal(call.title, 'Prazo da entrega');
  assert.ok(call.minutes?.includes('1 linhas lidas'), call.minutes ?? '');
});

test('Make Minutes again uses the Jottings as they are now', async (t) => {
  const log = join(await makeDirectory(t), 'prompt.txt');
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: COMMAND, SCRIBE_TEST_PROMPT_LOG: log },
  });
  const id = await stoppedCall(plugin);
  await until(plugin, id, (seen) => seen.minutesState === 'made');
  await plugin.call('save_jottings', { id, jottings: '# Custos\norçamento' });

  await plugin.call('make_minutes', { id });
  await until(plugin, id, (seen) => seen.minutesState === 'made');

  assert.ok((await readFile(log, 'utf8')).includes('# Custos\norçamento'));
});

test('Minutes are not made while the Call still records', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_MINUTES_COMMAND: COMMAND } });
  const id = await startCall(plugin);

  const answer = await plugin.call('make_minutes', { id });

  assert.ok(answer.error?.message.includes('still recording'), answer.error?.message);
  assert.equal((await getCall(plugin, id)).minutesState, 'none');
});
