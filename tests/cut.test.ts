/**
 * A Call that ends without Stop is kept, marked Cut, with its Transcript so
 * far: when its page stops sending audio for too long, or when the Plugin
 * Server that was recording it went away.
 */
import { strict as assert } from 'node:assert';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { getCall, pcm, said, send, startCall, transcribed, until } from './helpers/audio.ts';
import { startedAndShaken, structureOf } from './helpers/plugin.ts';

test('a Call whose audio stops coming is Cut after the timeout, and keeps its Transcript', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_CUT_AFTER_MS: '400' } });
  const id = await startCall(plugin);

  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }, { seconds: 2 }]));
  await until(plugin, id, (call) => call.state !== 'recording');
  const call = await transcribed(plugin, id);

  assert.equal(call.state, 'cut');
  assert.ok(call.endedAt !== null);
  assert.deepEqual(said(call), ['0 Você: tone 3000']);
});

test('a Call that keeps getting audio is not Cut', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_CUT_AFTER_MS: '600' } });
  const id = await startCall(plugin);

  for (let seq = 0; seq < 6; seq += 1) {
    await plugin.call('append_audio', {
      id,
      track: 'mic',
      seq,
      pcm: pcm([{ seconds: 0.1 }]).toString('base64'),
    });
    await new Promise((done) => setTimeout(done, 200));
  }

  assert.equal((await getCall(plugin, id)).state, 'recording');
});

test('a Call whose Plugin Server was killed is Cut when it starts again, with its audio heard', async (t) => {
  const first = await startedAndShaken(t);
  const id = await startCall(first);
  await send(first, id, 'mic', pcm([{ seconds: 1, level: 3000 }, { seconds: 3 }]));
  await send(first, id, 'tab', pcm([{ seconds: 2 }, { seconds: 1, level: 4000 }]));
  first.kill();
  await first.ended();

  const again = await startedAndShaken(t, { directory: first.directory });
  const call = await transcribed(again, id);

  assert.equal(call.state, 'cut');
  assert.deepEqual(said(call), ['0 Você: tone 3000', '2000 Outros: tone 4000']);
  assert.deepEqual(await readdir(join(first.directory, 'audio')), []);
});

test('a new Call can start once the old one is Cut', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_CUT_AFTER_MS: '300' } });
  const old = await startCall(plugin);
  await until(plugin, old, (call) => call.state === 'cut');

  const answer = await plugin.call('start_call');

  const started = structureOf<{ call: { id: number; state: string } }>(answer).call;
  assert.notEqual(started.id, old);
  assert.equal(started.state, 'recording');
});

test('the page of a Cut Call is told so when it sends more audio', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_CUT_AFTER_MS: '300' } });
  const id = await startCall(plugin);
  await until(plugin, id, (call) => call.state === 'cut');

  const answer = await plugin.call('append_audio', {
    id,
    track: 'mic',
    seq: 0,
    pcm: pcm([{ seconds: 1 }]).toString('base64'),
  });

  assert.ok(answer.error?.message.includes('is not recording'), answer.error?.message);
});
