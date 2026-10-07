/**
 * No program scribe started outlives its Plugin Server. whisper.cpp and the
 * Minutes command each run with every process they start, and when the Host
 * closes stdin, or a signal ends the Plugin Server, each of them is ended with
 * its whole tree: nothing is left holding a CPU with nobody to answer.
 *
 * The fixtures hang on purpose, and each writes the id of a process it started
 * itself, so a test can see that the tree went and not only its root.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pcm, send, startCall, until } from './helpers/audio.ts';
import {
  makeDirectory,
  minutesCommand,
  startedAndShaken,
  type Started,
} from './helpers/plugin.ts';

/** Whether a process has ended, within a few seconds. */
async function gone(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 50; tries += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((later) => setTimeout(later, 100));
  }
  return false;
}

/** The id a hanging fixture wrote, once it has written it. */
async function startedBy(file: string): Promise<number> {
  for (let tries = 0; tries < 100; tries += 1) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text !== '') return Number(text);
    await new Promise((later) => setTimeout(later, 50));
  }
  throw new Error(`nothing was written to ${file}`);
}

/** A stopped Call whose Minutes command hangs, and the id of what that command started. */
async function hangingMinutes(t: test.TestContext): Promise<{ plugin: Started; pid: number }> {
  const file = join(await makeDirectory(t), 'started.pid');
  const plugin = await startedAndShaken(t, {
    env: { SCRIBE_MINUTES_COMMAND: minutesCommand(), SCRIBE_TEST_MINUTES_HANG: file },
  });
  const id = await startCall(plugin);
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  await plugin.call('stop_call', { id });
  await until(plugin, id, (call) => call.minutesState === 'making');
  return { plugin, pid: await startedBy(file) };
}

/** A recording Call whose whisper.cpp hangs, and the id of what whisper.cpp started. */
async function hangingWhisper(t: test.TestContext): Promise<{ plugin: Started; pid: number }> {
  const file = join(await makeDirectory(t), 'started.pid');
  const plugin = await startedAndShaken(t, { env: { SCRIBE_TEST_WHISPER_HANG: file } });
  const id = await startCall(plugin);
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  await plugin.call('stop_call', { id });
  return { plugin, pid: await startedBy(file) };
}

for (const [what, hanging] of [
  ['the Minutes command', hangingMinutes],
  ['whisper.cpp', hangingWhisper],
] as const) {
  test(`when the Host closes stdin, ${what} is ended with every process it started`, async (t) => {
    const { plugin, pid } = await hanging(t);

    plugin.stop();
    const ending = await plugin.ended();

    assert.equal(ending.code, 0, plugin.output());
    assert.ok(await gone(pid), `process ${pid}, which ${what} started, still runs`);
  });

  test(
    `when a signal ends the Plugin Server, ${what} is ended with every process it started`,
    { skip: process.platform === 'win32' && 'Windows sends a process no signal it can catch' },
    async (t) => {
      const { plugin, pid } = await hanging(t);

      plugin.signal('SIGTERM');
      await plugin.ended();

      assert.ok(await gone(pid), `process ${pid}, which ${what} started, still runs`);
    },
  );
}
