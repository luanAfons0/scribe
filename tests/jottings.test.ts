/**
 * Jottings are what you type during a Call. Each change is kept on the Plugin
 * Server at once, so a Popup that hides and loads again loses nothing.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getCall, startCall, transcribed } from './helpers/audio.ts';
import { startedAndShaken, structureOf } from './helpers/plugin.ts';

const JOTTINGS = '# Prazo\nentrega na sexta\n\n# Riscos\n- API nova';

test('Jottings saved for a Call are the Jottings read back', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  await plugin.call('save_jottings', { id, jottings: JOTTINGS });

  assert.equal((await getCall(plugin, id)).jottings, JOTTINGS);
});

test('the Popup, which asks for the Call that records, gets the Jottings so far', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);
  await plugin.call('save_jottings', { id, jottings: 'first line' });
  await plugin.call('save_jottings', { id, jottings: 'first line\nsecond line' });

  const running = structureOf<{ call: { id: number; jottings: string; startedAt: string } }>(
    await plugin.call('get_call'),
  ).call;

  assert.equal(running.id, id);
  assert.equal(running.jottings, 'first line\nsecond line');
  assert.ok(!Number.isNaN(Date.parse(running.startedAt)));
});

test('Jottings outlive the Plugin Server', async (t) => {
  const first = await startedAndShaken(t);
  const id = await startCall(first);
  await first.call('save_jottings', { id, jottings: JOTTINGS });
  first.kill();
  await first.ended();

  const again = await startedAndShaken(t, { directory: first.directory });

  assert.equal((await transcribed(again, id)).jottings, JOTTINGS);
});

test('Jottings can change after the Call ended', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);
  await plugin.call('stop_call');

  await plugin.call('save_jottings', { id, jottings: 'written after' });

  assert.equal((await getCall(plugin, id)).jottings, 'written after');
});

test('Stop from the Popup ends the Call the tab records, and the tab is told', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  await plugin.call('stop_call', { id });
  const tab = await plugin.call('append_audio', { id, track: 'tab', seq: 0, pcm: 'AAAA' });

  assert.equal((await getCall(plugin, id)).state, 'ended');
  assert.ok(tab.error?.message.includes('is not recording'), tab.error?.message);
});

test('Jottings that are not a string are refused with a sentence', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  const answer = await plugin.call('save_jottings', { id, jottings: 42 });

  assert.equal(answer.error?.code, -32602);
  assert.ok(answer.error?.message.includes('jottings'), answer.error?.message);
});

test('Jottings for a Call that is not there are refused with a sentence', async (t) => {
  const plugin = await startedAndShaken(t);

  const answer = await plugin.call('save_jottings', { id: 99, jottings: 'x' });

  assert.ok(answer.error?.message.includes('There is no Call 99'), answer.error?.message);
});
