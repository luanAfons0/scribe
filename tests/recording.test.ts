/**
 * A Call records the mic and the shared tab, and Whisper makes its Transcript
 * as it goes: every line labelled `Eu` or `Outros`, in time order, and no
 * audio kept once Whisper has read it.
 */
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  chunks,
  getCall,
  pcm,
  said,
  send,
  startCall,
  transcribed,
  until,
} from './helpers/audio.ts';
import { makeDirectory, startedAndShaken } from './helpers/plugin.ts';

/** The files of audio a Plugin directory still holds. */
async function audioIn(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(join(directory, 'audio'));
  } catch {
    return [];
  }
}

test('a Call fed on both tracks and stopped has Eu and Outros lines in time order', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  await send(
    plugin,
    id,
    'mic',
    pcm([{ seconds: 1, level: 3000 }, { seconds: 3 }, { seconds: 1, level: 5000 }]),
  );
  await send(plugin, id, 'tab', pcm([{ seconds: 2 }, { seconds: 1, level: 4000 }, { seconds: 2 }]));
  await plugin.call('stop_call', { id });
  const call = await transcribed(plugin, id);

  assert.equal(call.state, 'ended');
  assert.deepEqual(said(call), [
    '0 Eu: tone 3000',
    '2000 Outros: tone 4000',
    '4000 Eu: tone 5000',
  ]);
});

test('a line in a later window keeps its moment in the Call', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  await send(plugin, id, 'tab', pcm([
    { seconds: 3 }, { seconds: 1, level: 2000 }, { seconds: 27 },
    { seconds: 1, level: 6000 }, { seconds: 8 },
  ]));
  await plugin.call('stop_call', { id });
  const call = await transcribed(plugin, id);

  assert.deepEqual(said(call), ['3000 Outros: tone 2000', '31000 Outros: tone 6000']);
});

test('the Transcript grows while the Call still records', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }, { seconds: 34 }]));
  const call = await until(plugin, id, (seen) => seen.transcript.length > 0);

  assert.equal(call.state, 'recording');
  assert.deepEqual(said(call), ['0 Eu: tone 3000']);
});

test('no audio file is left once Whisper has read it', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  await send(plugin, id, 'mic', pcm([{ seconds: 2, level: 3000 }, { seconds: 40 }]));
  await send(plugin, id, 'tab', pcm([{ seconds: 12, level: 3000 }]));
  assert.ok((await audioIn(plugin.directory)).length > 0, 'no audio waited for Whisper');
  await plugin.call('stop_call', { id });
  await transcribed(plugin, id);

  assert.deepEqual(await audioIn(plugin.directory), []);
});

test('silence is never given to Whisper, which would make words up', async (t) => {
  const log = join(await makeDirectory(t), 'whisper.log');
  const plugin = await startedAndShaken(t, { env: { SCRIBE_TEST_WHISPER_LOG: log } });
  const id = await startCall(plugin);

  await send(plugin, id, 'mic', pcm([{ seconds: 40 }]));
  await plugin.call('stop_call', { id });
  const call = await transcribed(plugin, id);

  assert.deepEqual(call.transcript, []);
  assert.equal(await readFile(log, 'utf8').catch(() => ''), '');
  assert.deepEqual(await audioIn(plugin.directory), []);
});

test('a mic line with only quiet audio under it is dropped, and the tab keeps one', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  const quietThenLoud = pcm([{ seconds: 1, level: 300 }, { seconds: 1 }, { seconds: 1, level: 3000 }]);
  await send(plugin, id, 'mic', quietThenLoud);
  await send(plugin, id, 'tab', pcm([{ seconds: 4 }, { seconds: 1, level: 300 }]));
  await plugin.call('stop_call', { id });
  const call = await transcribed(plugin, id);

  assert.deepEqual(said(call), ['2000 Eu: tone 3000', '4000 Outros: tone 300']);
});

test('a mic window that is only quiet is never given to Whisper', async (t) => {
  const log = join(await makeDirectory(t), 'whisper.log');
  const plugin = await startedAndShaken(t, { env: { SCRIBE_TEST_WHISPER_LOG: log } });
  const id = await startCall(plugin);

  await send(plugin, id, 'mic', pcm([{ seconds: 2, level: 400 }]));
  await plugin.call('stop_call', { id });
  const call = await transcribed(plugin, id);

  assert.deepEqual(call.transcript, []);
  assert.equal(await readFile(log, 'utf8').catch(() => ''), '');
});

test('a line that is only a sound in brackets is not kept', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  await send(plugin, id, 'tab', pcm([
    { seconds: 1, level: 1111 }, { seconds: 1 }, { seconds: 1, level: 3000 },
  ]));
  await plugin.call('stop_call', { id });
  const call = await transcribed(plugin, id);

  assert.deepEqual(said(call), ['2000 Outros: tone 3000']);
});

test('Whisper is asked for Portuguese, greedy, with the model the settings name', async (t) => {
  const log = join(await makeDirectory(t), 'whisper.log');
  const plugin = await startedAndShaken(t, { env: { SCRIBE_TEST_WHISPER_LOG: log } });
  const id = await startCall(plugin);

  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  await plugin.call('stop_call', { id });
  await transcribed(plugin, id);

  const args = JSON.parse((await readFile(log, 'utf8')).trim()) as string[];
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after('-l'), 'pt');
  assert.equal(after('-bs'), '1');
  assert.equal(after('-bo'), '1');
  assert.ok(args.includes('-sns'), 'non-speech tokens are not suppressed');
  assert.ok(after('-m')?.endsWith('model.bin'), args.join(' '));
});

test('a second Start while a Call records is refused with a sentence that names it', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);

  const answer = await plugin.call('start_call');

  assert.equal(answer.error?.code, -32602);
  assert.ok(answer.error?.message.includes(`Call ${id}`), answer.error?.message);
  assert.ok(answer.error?.message.includes('recording'), answer.error?.message);
});

test('a new Call can start once the last one is stopped', async (t) => {
  const plugin = await startedAndShaken(t);
  const first = await startCall(plugin);
  await plugin.call('stop_call');

  const second = await startCall(plugin);

  assert.notEqual(second, first);
  assert.equal((await getCall(plugin, second)).state, 'recording');
});

test('get_call with no id answers the Call that records, or null', async (t) => {
  const plugin = await startedAndShaken(t);
  const none = await plugin.call('get_call');
  const id = await startCall(plugin);

  const running = await plugin.call('get_call');

  assert.equal((none.result as { structuredContent: { call: unknown } }).structuredContent.call, null);
  assert.equal(
    (running.result as { structuredContent: { call: { id: number } } }).structuredContent.call.id,
    id,
  );
});

test('a chunk sent twice is kept once, and one that skips ahead is refused', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);
  const [first] = chunks(pcm([{ seconds: 1, level: 3000 }]));

  await plugin.call('append_audio', { id, track: 'mic', seq: 0, pcm: first });
  const again = await plugin.call('append_audio', { id, track: 'mic', seq: 0, pcm: first });
  const skipped = await plugin.call('append_audio', { id, track: 'mic', seq: 5, pcm: first });
  await plugin.call('stop_call');
  const call = await transcribed(plugin, id);

  assert.equal(again.error, undefined);
  assert.ok(skipped.error?.message.includes('expected chunk 1'), skipped.error?.message);
  assert.deepEqual(said(call), ['0 Eu: tone 3000']);
});

test('audio for a Call that does not record is refused with a sentence', async (t) => {
  const plugin = await startedAndShaken(t);
  const id = await startCall(plugin);
  await plugin.call('stop_call');
  const [chunk] = chunks(pcm([{ seconds: 1, level: 3000 }]));

  const answer = await plugin.call('append_audio', { id, track: 'mic', seq: 0, pcm: chunk });

  assert.ok(answer.error?.message.includes(`Call ${id} is not recording`), answer.error?.message);
});

test('Stop with no Call recording is refused with a sentence', async (t) => {
  const plugin = await startedAndShaken(t);

  const answer = await plugin.call('stop_call');

  assert.ok(answer.error?.message.includes('No Call is recording'), answer.error?.message);
});

test('a tool call that carries five seconds of audio is well under the Host’s 1 MiB', () => {
  const loud = Buffer.alloc(5 * 16_000 * 2);
  for (let i = 0; i < loud.length; i += 1) loud[i] = (i * 7919) % 256;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'append_audio',
      arguments: { id: 1, track: 'mic', seq: 0, pcm: loud.toString('base64') },
    },
  });

  assert.ok(Buffer.byteLength(body) < 300_000, `the call is ${Buffer.byteLength(body)} bytes`);
});
