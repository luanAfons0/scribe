/**
 * scribe is set up from its Plugin Page. It keeps what the operator chose in
 * `settings.json` in its own Plugin directory, beside `scribe.db` (FirstMate
 * ADR-0005), so it works however the Host was started. The variable of the
 * same name still beats the file, and the file beats the default.
 *
 * Whisper is what scribe is for, but a missing whisper.cpp no longer ends the
 * Plugin Server (ADR-0004): it runs, says what is missing, and refuses to
 * record with one sentence that names the setting.
 *
 * Everything here goes through the tools, as the Plugin Page and the Host do,
 * and reads the files the Plugin Server leaves in its directory.
 */
import { strict as assert } from 'node:assert';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pcm, send, startCall, until } from './helpers/audio.ts';
import {
  FIXTURES,
  fixture,
  makeDirectory,
  startedAndShaken,
  startPluginServer,
  structureOf,
  type Answer,
  type Started,
} from './helpers/plugin.ts';

/** The settings file, in the Plugin directory. */
const FILE = 'settings.json';

/** The fixture model, as an absolute path. */
const MODEL = join(FIXTURES, 'model.bin');

/** The environment with no whisper.cpp and no model in it. */
const NO_WHISPER = { SCRIBE_WHISPER: '', SCRIBE_WHISPER_MODEL: '' };

/** One setting, as get_settings and update_settings answer it. */
type Setting = {
  value: unknown;
  from: 'environment' | 'file' | 'default';
  saved: unknown;
  variable: string;
  problem: string | null;
};

type Settings = {
  whisper: Setting;
  whisperModel: Setting;
  minutesCommand: Setting;
  worklogPlugin: Setting;
};

/** The settings, as the settings tools answer them. */
function settingsOf(answer: Answer): Settings {
  return structureOf<{ settings: Settings }>(answer).settings;
}

/** Stop a Plugin Server the way the Host does, and wait for it to end. */
async function stopped(plugin: Started): Promise<void> {
  plugin.stop();
  await plugin.ended();
}

/** A Plugin Server with nothing in its environment for whisper.cpp. */
function withNoWhisper(t: TestContext, directory?: string): Promise<Started> {
  return startedAndShaken(t, {
    env: NO_WHISPER,
    ...(directory === undefined ? {} : { directory }),
  });
}

test('with no whisper.cpp set, it answers initialize and stays up', async (t) => {
  const plugin = await startPluginServer(t, { env: NO_WHISPER });

  const answer = await plugin.handshake();
  const listed = await plugin.call('list_calls');

  assert.equal(answer.error, undefined, plugin.output());
  assert.equal(listed.error, undefined, plugin.output());
  assert.equal(plugin.output(), '');
});

test('with no whisper.cpp set, recording is refused with a sentence that names the setting', async (t) => {
  const plugin = await withNoWhisper(t);

  const answer = await plugin.call('start_call');
  const listed = structureOf<{ calls: unknown[] }>(await plugin.call('list_calls'));

  assert.ok(answer.error !== undefined, 'start_call was not refused');
  assert.ok(answer.error.message.includes('whisper.cpp executable'), answer.error.message);
  assert.ok(answer.error.message.includes('SCRIBE_WHISPER'), answer.error.message);
  assert.deepEqual(listed.calls, []);
});

test('with no model set, recording is refused with a sentence that names the setting', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_WHISPER_MODEL: '' } });

  const answer = await plugin.call('start_call');

  assert.ok(answer.error?.message.includes('whisper.cpp model'), answer.error?.message);
  assert.ok(answer.error?.message.includes('SCRIBE_WHISPER_MODEL'), answer.error?.message);
});

test('get_settings shows what is missing beside the setting', async (t) => {
  const plugin = await withNoWhisper(t);

  const settings = settingsOf(await plugin.call('get_settings'));
  const refused = await plugin.call('start_call');

  assert.deepEqual(settings.whisper, {
    value: null,
    from: 'default',
    saved: null,
    variable: 'SCRIBE_WHISPER',
    problem: refused.error?.message,
  });
  assert.ok(settings.whisperModel.problem?.includes('whisper.cpp model'));
  assert.ok(settings.minutesCommand.problem?.includes('SCRIBE_MINUTES_COMMAND'));
  assert.equal(settings.worklogPlugin.problem, null);
  assert.deepEqual(await readdir(plugin.directory), ['scribe.db']);
});

test('with SCRIBE_WHISPER naming no file, the sentence names the variable and the path', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_WHISPER: '/no/such/whisper-cli' } });

  const answer = await plugin.call('start_call');
  const settings = settingsOf(await plugin.call('get_settings'));

  assert.ok(answer.error?.message.includes('SCRIBE_WHISPER'), answer.error?.message);
  assert.ok(answer.error?.message.includes('/no/such/whisper-cli'), answer.error?.message);
  assert.equal(settings.whisper.problem, answer.error?.message);
  assert.equal(settings.whisper.from, 'environment');
});

test('with SCRIBE_WHISPER naming a directory, recording is refused with a sentence', async (t) => {
  const directory = await makeDirectory(t);
  const plugin = await startedAndShaken(t, { env: { SCRIBE_WHISPER: directory } });

  const answer = await plugin.call('start_call');

  assert.ok(answer.error?.message.includes('not a file'), answer.error?.message);
});

/** Windows has no mode bit that stops a file from being run. */
const NO_MODE_BITS = process.platform === 'win32' ? 'Windows runs a file by its extension' : false;

test(
  'with SCRIBE_WHISPER naming a file that may not be run, recording is refused with a sentence',
  { skip: NO_MODE_BITS },
  async (t) => {
    const directory = await makeDirectory(t);
    const file = join(directory, 'whisper-cli');
    await writeFile(file, '');
    await chmod(file, 0o644);
    const plugin = await startedAndShaken(t, { env: { SCRIBE_WHISPER: file } });

    const answer = await plugin.call('start_call');

    assert.ok(answer.error?.message.includes('may not be run'), answer.error?.message);
  },
);

test('each setting set through update_settings is kept in the Plugin directory and survives a restart', async (t) => {
  const first = await startedAndShaken(t, {
    env: { ...NO_WHISPER, SCRIBE_MINUTES_COMMAND: '', SCRIBE_WORKLOG_PLUGIN: '' },
  });
  const chosen = {
    whisper: fixture('whisper'),
    whisperModel: MODEL,
    minutesCommand: [fixture('minutes'), '--fast'],
    worklogPlugin: 'worklog',
  };

  const answered = settingsOf(await first.call('update_settings', chosen));
  await stopped(first);
  const second = await startedAndShaken(t, {
    directory: first.directory,
    env: { ...NO_WHISPER, SCRIBE_MINUTES_COMMAND: '', SCRIBE_WORKLOG_PLUGIN: '' },
  });
  const read = settingsOf(await second.call('get_settings'));

  for (const [name, value] of Object.entries(chosen)) {
    const setting = answered[name as keyof Settings];
    assert.deepEqual(
      { value: setting.value, from: setting.from, saved: setting.saved, problem: setting.problem },
      { value, from: 'file', saved: value, problem: null },
      name,
    );
  }
  assert.deepEqual(read, answered);
  assert.deepEqual(JSON.parse(await readFile(join(first.directory, FILE), 'utf8')), chosen);
  assert.equal(second.output(), '');
});

test('whisper.cpp and the Minutes command set on the Page record a Call and make its Minutes', async (t) => {
  const first = await withNoWhisper(t);
  await first.call('update_settings', {
    whisper: fixture('whisper'),
    whisperModel: MODEL,
    minutesCommand: [fixture('minutes')],
  });

  const id = await startCall(first);
  await send(first, id, 'tab', pcm([{ seconds: 2 }, { seconds: 1, level: 4000 }]));
  await first.call('stop_call', { id });
  const call = await until(first, id, (seen) => seen.minutesState === 'made');

  assert.equal(call.title, 'Prazo da entrega');
  assert.ok(call.transcript.length > 0, 'Whisper heard nothing');
});

test('each variable beats its setting, and the settings tools say the environment decides it', async (t) => {
  const directory = await makeDirectory(t);
  const saved = {
    whisper: '/saved/whisper-cli',
    whisperModel: '/saved/ggml-small.bin',
    minutesCommand: ['saved-runner'],
    worklogPlugin: 'saved-worklog',
  };
  await writeFile(join(directory, FILE), JSON.stringify(saved));
  const env = {
    SCRIBE_WHISPER: fixture('whisper'),
    SCRIBE_WHISPER_MODEL: MODEL,
    SCRIBE_MINUTES_COMMAND: JSON.stringify([fixture('minutes')]),
    SCRIBE_WORKLOG_PLUGIN: 'worklog',
  };
  const plugin = await startedAndShaken(t, { directory, env });

  const read = settingsOf(await plugin.call('get_settings'));
  const changed = settingsOf(await plugin.call('update_settings', { worklogPlugin: 'another' }));
  const started = await plugin.call('start_call');

  assert.deepEqual(read.whisper, {
    value: fixture('whisper'),
    from: 'environment',
    saved: '/saved/whisper-cli',
    variable: 'SCRIBE_WHISPER',
    problem: null,
  });
  assert.equal(read.whisperModel.from, 'environment');
  assert.equal(read.whisperModel.value, MODEL);
  assert.deepEqual(read.minutesCommand.value, [fixture('minutes')]);
  assert.equal(read.minutesCommand.from, 'environment');
  assert.equal(read.worklogPlugin.from, 'environment');
  assert.deepEqual(changed.worklogPlugin, {
    value: 'worklog',
    from: 'environment',
    saved: 'another',
    variable: 'SCRIBE_WORKLOG_PLUGIN',
    problem: null,
  });
  assert.equal(started.error, undefined, started.error?.message);
});

test('a variable set to nothing decides nothing, and the file decides', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_WORKLOG_PLUGIN: '  ' } });

  const changed = settingsOf(await plugin.call('update_settings', { worklogPlugin: 'worklog' }));

  assert.equal(changed.worklogPlugin.from, 'file');
  assert.equal(changed.worklogPlugin.value, 'worklog');
});

for (const [what, given, names] of [
  ['a relative whisper.cpp path', { whisper: 'bin/whisper-cli' }, 'whisper'],
  ['a whisper.cpp path that is a number', { whisper: 3 }, 'whisper'],
  ['an empty model path', { whisperModel: '' }, 'whisperModel'],
  ['a Minutes command as a shell line', { minutesCommand: 'ollama run llama3' }, 'minutesCommand'],
  ['an empty Minutes command', { minutesCommand: [] }, 'minutesCommand'],
  ['a Minutes command with a number in it', { minutesCommand: ['ollama', 3] }, 'minutesCommand'],
  ['a Worklog Plugin that is no Registry name', { worklogPlugin: 'Work Log' }, 'worklogPlugin'],
  ['a setting scribe does not have', { whisperPath: '/x' }, 'whisperPath'],
] as const) {
  test(`${what} is refused with one sentence, and the file is left as it was`, async (t) => {
    const plugin = await startedAndShaken(t);
    await plugin.call('update_settings', {
      worklogPlugin: 'worklog',
      whisper: fixture('whisper'),
    });
    const before = await readFile(join(plugin.directory, FILE), 'utf8');

    const answer = await plugin.call('update_settings', { worklogPlugin: 'other', ...given });

    const message = answer.error?.message ?? '';
    assert.ok(message.startsWith('update_settings'), message);
    assert.ok(message.includes(names), message);
    const sentences = message.trim().split(/\.\s+(?=[A-Z])/);
    assert.equal(sentences.length, 1, `more than one sentence: ${message}`);
    assert.equal(await readFile(join(plugin.directory, FILE), 'utf8'), before);
    assert.equal(settingsOf(await plugin.call('get_settings')).worklogPlugin.value, 'worklog');
  });
}

test('null takes a setting out of the file, and the default decides it again', async (t) => {
  const plugin = await startedAndShaken(t, { env: { SCRIBE_WORKLOG_PLUGIN: '' } });
  await plugin.call('update_settings', { worklogPlugin: 'worklog' });

  const changed = settingsOf(await plugin.call('update_settings', { worklogPlugin: null }));

  assert.deepEqual(changed.worklogPlugin, {
    value: null,
    from: 'default',
    saved: null,
    variable: 'SCRIBE_WORKLOG_PLUGIN',
    problem: null,
  });
  assert.deepEqual(JSON.parse(await readFile(join(plugin.directory, FILE), 'utf8')), {});
});

test('a key this scribe does not know is kept in the file', async (t) => {
  const directory = await makeDirectory(t);
  await writeFile(join(directory, FILE), JSON.stringify({ later: { kept: true } }));
  const plugin = await startedAndShaken(t, { directory });

  await plugin.call('update_settings', { worklogPlugin: 'worklog' });

  assert.deepEqual(JSON.parse(await readFile(join(directory, FILE), 'utf8')), {
    later: { kept: true },
    worklogPlugin: 'worklog',
  });
});

test('a settings file that is not JSON does not stop it; it says so, and a save replaces it', async (t) => {
  const directory = await makeDirectory(t);
  await writeFile(join(directory, FILE), '{ "whisper": ');
  const plugin = await startPluginServer(t, { directory, env: NO_WHISPER });

  const shaken = await plugin.handshake();
  const read = settingsOf(await plugin.call('get_settings'));
  const refused = await plugin.call('start_call');
  await plugin.call('update_settings', { whisper: fixture('whisper'), whisperModel: MODEL });
  const started = await plugin.call('start_call');

  assert.equal(shaken.error, undefined, plugin.output());
  assert.ok(read.whisper.problem?.includes(FILE), read.whisper.problem ?? '');
  assert.equal(read.whisper.from, 'file');
  assert.ok(refused.error?.message.includes(FILE), refused.error?.message);
  assert.equal(started.error, undefined, started.error?.message);
  assert.deepEqual(JSON.parse(await readFile(join(directory, FILE), 'utf8')), {
    whisper: fixture('whisper'),
    whisperModel: MODEL,
  });
});

test('a setting in the file that is not in its form is said beside it, and the others still work', async (t) => {
  const directory = await makeDirectory(t);
  await writeFile(join(directory, FILE), JSON.stringify({ whisper: 3, worklogPlugin: 'worklog' }));
  const plugin = await startedAndShaken(t, {
    directory,
    env: { ...NO_WHISPER, SCRIBE_WORKLOG_PLUGIN: '' },
  });

  const read = settingsOf(await plugin.call('get_settings'));

  assert.ok(read.whisper.problem?.includes(FILE), read.whisper.problem ?? '');
  assert.ok(read.whisper.problem?.includes('whisper'), read.whisper.problem ?? '');
  assert.equal(read.worklogPlugin.value, 'worklog');
});

test('a Minutes command whose program is not found is said beside the setting', async (t) => {
  const plugin = await startedAndShaken(t);

  const changed = settingsOf(
    await plugin.call('update_settings', { minutesCommand: ['no-such-model-runner'] }),
  );

  assert.equal(changed.minutesCommand.from, 'file');
  assert.ok(changed.minutesCommand.problem?.includes('no-such-model-runner'));
});

test('an empty directory starts empty and holds only scribe.db', async (t) => {
  const plugin = await startPluginServer(t);
  await plugin.handshake();
  await plugin.call('list_calls');
  await plugin.call('get_settings');
  await stopped(plugin);

  assert.deepEqual(await readdir(plugin.directory), ['scribe.db']);
});
