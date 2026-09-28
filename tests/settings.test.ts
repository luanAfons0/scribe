/**
 * Whisper is what scribe is for, so the Plugin Server will not start without
 * whisper.cpp or its model. It exits with one sentence that names the
 * setting, and the Host shows the Plugin Stopped.
 */
import { strict as assert } from 'node:assert';
import { chmod, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { makeDirectory, startPluginServer } from './helpers/plugin.ts';

/** Start the Plugin Server with these settings, and hand back how it ended. */
async function refusedWith(t: TestContext, env: Record<string, string>) {
  const plugin = await startPluginServer(t, { env });
  const ending = await plugin.ended();
  return { code: ending.code, said: plugin.output().trim(), lines: plugin.lines() };
}

function assertOneSentenceNaming(
  refused: { code: number | null; said: string; lines: readonly string[] },
  variable: string,
) {
  assert.notEqual(refused.code, 0);
  assert.ok(refused.said.startsWith('scribe: '), `stderr said: ${refused.said}`);
  assert.ok(refused.said.includes(variable), `stderr said: ${refused.said}`);
  assert.equal(refused.said.split('\n').length, 1, `stderr said more than one line: ${refused.said}`);
  assert.equal(refused.lines.length, 0, 'something reached stdout');
}

test('with SCRIBE_WHISPER not set, it exits with a sentence that names it', async (t) => {
  assertOneSentenceNaming(await refusedWith(t, { SCRIBE_WHISPER: '' }), 'SCRIBE_WHISPER');
});

test('with SCRIBE_WHISPER naming no file, it exits with a sentence that names it', async (t) => {
  const refused = await refusedWith(t, { SCRIBE_WHISPER: '/no/such/whisper-cli' });

  assertOneSentenceNaming(refused, 'SCRIBE_WHISPER');
  assert.ok(refused.said.includes('/no/such/whisper-cli'), refused.said);
});

test('with SCRIBE_WHISPER naming a directory, it exits with a sentence that names it', async (t) => {
  const directory = await makeDirectory(t);

  assertOneSentenceNaming(await refusedWith(t, { SCRIBE_WHISPER: directory }), 'SCRIBE_WHISPER');
});

test('with SCRIBE_WHISPER naming a file that may not be run, it exits with a sentence', async (t) => {
  const directory = await makeDirectory(t);
  const file = join(directory, 'whisper-cli');
  await writeFile(file, '');
  await chmod(file, 0o644);

  assertOneSentenceNaming(await refusedWith(t, { SCRIBE_WHISPER: file }), 'SCRIBE_WHISPER');
});

test('with SCRIBE_WHISPER_MODEL not set, it exits with a sentence that names it', async (t) => {
  const refused = await refusedWith(t, { SCRIBE_WHISPER_MODEL: '' });

  assertOneSentenceNaming(refused, 'SCRIBE_WHISPER_MODEL');
});

test('with SCRIBE_WHISPER_MODEL naming no file, it exits with a sentence that names it', async (t) => {
  const refused = await refusedWith(t, { SCRIBE_WHISPER_MODEL: '/no/such/ggml-small.bin' });

  assertOneSentenceNaming(refused, 'SCRIBE_WHISPER_MODEL');
  assert.ok(refused.said.includes('/no/such/ggml-small.bin'), refused.said);
});

test('with no Minutes command set, it still starts', async (t) => {
  const plugin = await startPluginServer(t, { env: { SCRIBE_MINUTES_COMMAND: '' } });

  const answer = await plugin.handshake();

  assert.equal(answer.error, undefined, plugin.output());
});

test('an empty directory starts empty and holds only scribe.db', async (t) => {
  const plugin = await startPluginServer(t);
  await plugin.handshake();
  await plugin.call('list_calls');
  plugin.stop();
  await plugin.ended();

  assert.deepEqual(await readdir(plugin.directory), ['scribe.db']);
});
