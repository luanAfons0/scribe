/**
 * An operator with no whisper.cpp gets one from the Plugin Page: a build for
 * this system, and a model of their choice, each fetched only when asked,
 * checked against a known SHA-256 before it is kept, kept under scribe's own
 * Plugin directory, and set in its settings (ADR-0005).
 *
 * A local server plays GitHub and Hugging Face. The list of downloads scribe
 * reads is the test's own, through `SCRIBE_DOWNLOADS`, so its checksums are
 * those of the fixture archives.
 */
import { strict as assert } from 'node:assert';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pcm, said, send, startCall, transcribed } from './helpers/audio.ts';
import {
  structureOf,
  startedAndShaken,
  type Answer,
  type Started,
} from './helpers/plugin.ts';
import {
  download,
  downloadsFile,
  FIXTURE_PROGRAM,
  fixtureBytes,
  serveFiles,
  SYSTEM,
  type Build,
} from './helpers/server.ts';

/** One download in flight or failed, as get_downloads tells it. */
type Fetch = {
  readonly name: string;
  readonly received: number;
  readonly size: number;
  readonly failed: string | null;
};

/** What get_downloads answers. */
type Downloads = {
  readonly whisper: {
    readonly release: string;
    readonly build: { readonly size: number } | null;
    readonly missing: string | null;
    readonly fetch: Fetch | null;
  };
  readonly models: {
    readonly offered: readonly { readonly name: string; readonly size: number }[];
    readonly fetch: Fetch | null;
  };
};

type Setting = { readonly value: unknown; readonly from: string; readonly problem: string | null };
type Settings = { readonly whisper: Setting; readonly whisperModel: Setting };

/** No whisper.cpp and no model from the environment: the Page is where they come from. */
const UNSET = { SCRIBE_WHISPER: '', SCRIBE_WHISPER_MODEL: '' };

async function downloads(plugin: Started): Promise<Downloads> {
  return structureOf<{ downloads: Downloads }>(await plugin.call('get_downloads')).downloads;
}

async function settings(plugin: Started): Promise<Settings> {
  return structureOf<{ settings: Settings }>(await plugin.call('get_settings')).settings;
}

/** Wait until neither download is in flight, and hand back what get_downloads says then. */
async function settled(plugin: Started): Promise<Downloads> {
  const until = Date.now() + 10_000;
  for (;;) {
    const seen = await downloads(plugin);
    const busy = [seen.whisper.fetch, seen.models.fetch].some(
      (fetch) => fetch !== null && fetch.failed === null,
    );
    if (!busy) return seen;
    if (Date.now() > until) throw new Error(`a download never ended: ${JSON.stringify(seen)}`);
    await new Promise((later) => setTimeout(later, 50));
  }
}

/** What a Plugin directory holds, as relative paths, every level down. */
async function filesIn(directory: string): Promise<readonly string[]> {
  const found = await readdir(directory, { recursive: true });
  return found.map((path) => path.split('\\').join('/')).sort();
}

/** A server with a fixture build and the fixture model, and the list of downloads that names them. */
async function served(
  t: test.TestContext,
  options: { readonly format?: 'zip' | 'tar.gz'; readonly build?: boolean } = {},
) {
  const format = options.format ?? 'zip';
  const archive = await fixtureBytes(`whisper-build.${format}`);
  const model = await fixtureBytes('model.bin');
  const server = await serveFiles(t, {
    [`/whisper.${format}`]: archive,
    '/ggml-small.bin': model,
    '/ggml-tiny.bin': model,
  });
  const build: Build = {
    ...download(server.url(`/whisper.${format}`), archive),
    format,
    program: FIXTURE_PROGRAM,
  };
  const env = await downloadsFile(t, {
    release: 'v1.9.4',
    builds: options.build === false ? {} : { [SYSTEM]: build },
    models: [
      { name: 'ggml-tiny.bin', ...download(server.url('/ggml-tiny.bin'), model) },
      { name: 'ggml-small.bin', ...download(server.url('/ggml-small.bin'), model) },
    ],
  });
  return { server, env: { ...UNSET, ...env } };
}

function refusal(answer: Answer): string {
  assert.ok(answer.error !== undefined, `it was not refused: ${JSON.stringify(answer.result)}`);
  return answer.error.message;
}

test('get_downloads offers the build for this system and the models, and fetches nothing', async (t) => {
  const { server, env } = await served(t);
  const plugin = await startedAndShaken(t, { env });

  const seen = await downloads(plugin);

  assert.equal(seen.whisper.release, 'v1.9.4');
  assert.ok(seen.whisper.build !== null && seen.whisper.build.size > 0);
  assert.equal(seen.whisper.missing, null);
  assert.equal(seen.whisper.fetch, null);
  assert.deepEqual(
    seen.models.offered.map((model) => model.name),
    ['ggml-tiny.bin', 'ggml-small.bin'],
  );
  assert.equal(seen.models.fetch, null);
  assert.deepEqual(server.asked(), []);
  assert.deepEqual(await filesIn(plugin.directory), ['scribe.db']);
});

for (const format of ['zip', 'tar.gz'] as const) {
  test(`fetch_whisper fetches a ${format} build, keeps it in the Plugin directory, and sets it`, async (t) => {
    const { server, env } = await served(t, { format });
    const plugin = await startedAndShaken(t, { env });

    const started = structureOf<{ downloads: Downloads }>(await plugin.call('fetch_whisper'));
    const seen = await settled(plugin);
    const after = await settings(plugin);

    assert.ok(started.downloads.whisper.fetch !== null);
    assert.equal(seen.whisper.fetch, null);
    assert.deepEqual(server.asked(), [`/whisper.${format}`]);
    assert.equal(after.whisper.from, 'file');
    assert.equal(after.whisper.problem, null);
    assert.ok(
      String(after.whisper.value).startsWith(plugin.directory),
      `${after.whisper.value} is not in the Plugin directory`,
    );
    assert.equal(after.whisperModel.value, null, 'the model was fetched without being asked for');
  });
}

test('with whisper.cpp and a model fetched from the Page, a Call records and is transcribed', async (t) => {
  const { env } = await served(t);
  const plugin = await startedAndShaken(t, { env });

  await plugin.call('fetch_whisper');
  await plugin.call('fetch_model', { name: 'ggml-small.bin' });
  await settled(plugin);
  const id = await startCall(plugin);
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }, { seconds: 2 }]));
  await plugin.call('stop_call', { id });
  const call = await transcribed(plugin, id);

  assert.deepEqual(said(call), ['0 Você: tone 3000']);
});

test('fetch_model fetches the one model asked for, keeps it, and sets it', async (t) => {
  const { server, env } = await served(t);
  const plugin = await startedAndShaken(t, { env });

  await plugin.call('fetch_model', { name: 'ggml-tiny.bin' });
  const seen = await settled(plugin);
  const after = await settings(plugin);

  assert.equal(seen.models.fetch, null);
  assert.deepEqual(server.asked(), ['/ggml-tiny.bin']);
  assert.equal(after.whisperModel.value, join(plugin.directory, 'downloads', 'models', 'ggml-tiny.bin'));
  assert.equal(after.whisperModel.problem, null);
  assert.equal(after.whisper.value, null, 'whisper.cpp was fetched without being asked for');
});

test('a model that is not offered is refused with a sentence that names those that are', async (t) => {
  const { server, env } = await served(t);
  const plugin = await startedAndShaken(t, { env });

  const said = refusal(await plugin.call('fetch_model', { name: 'ggml-huge.bin' }));

  assert.match(said, /ggml-tiny\.bin, ggml-small\.bin/);
  assert.match(said, /"ggml-huge\.bin"/);
  assert.deepEqual(server.asked(), []);
});

/** A server whose bytes are not those the list names, for the build and for a model. */
async function tampered(t: test.TestContext, routes: Record<string, Buffer | number | 'stall'>) {
  const archive = await fixtureBytes('whisper-build.zip');
  const model = await fixtureBytes('model.bin');
  const server = await serveFiles(t, routes);
  const env = await downloadsFile(t, {
    builds: {
      [SYSTEM]: {
        ...download(server.url('/whisper.zip'), archive),
        format: 'zip',
        program: FIXTURE_PROGRAM,
      },
    },
    models: [{ name: 'ggml-small.bin', ...download(server.url('/ggml-small.bin'), model) }],
  });
  return { ...UNSET, ...env };
}

/** Start both downloads, and hand back the sentence each failed with. */
async function bothFailed(plugin: Started): Promise<readonly string[]> {
  await plugin.call('fetch_whisper');
  await plugin.call('fetch_model', { name: 'ggml-small.bin' });
  const seen = await settled(plugin);
  return [seen.whisper.fetch?.failed ?? 'it did not fail', seen.models.fetch?.failed ?? 'it did not fail'];
}

test('a download whose SHA-256 does not match is refused in one sentence, and nothing of it is kept', async (t) => {
  // The same size as the real bytes, one byte changed: only the SHA-256 tells them apart.
  const changed = (bytes: Buffer): Buffer => {
    const copy = Buffer.from(bytes);
    copy[copy.length - 1] = (copy[copy.length - 1]! + 1) % 256;
    return copy;
  };
  const env = await tampered(t, {
    '/whisper.zip': changed(await fixtureBytes('whisper-build.zip')),
    '/ggml-small.bin': changed(await fixtureBytes('model.bin')),
  });
  const plugin = await startedAndShaken(t, { env });

  const failed = await bothFailed(plugin);
  const after = await settings(plugin);

  for (const sentence of failed) {
    assert.match(sentence, /is not the file scribe expects: its SHA-256 does not match, so nothing was kept\.$/);
  }
  assert.deepEqual(await filesIn(plugin.directory), ['scribe.db']);
  assert.equal(after.whisper.value, null);
  assert.equal(after.whisperModel.value, null);
});

test('a download the server refuses is said in one sentence that names the answer, and nothing is kept', async (t) => {
  const env = await tampered(t, { '/whisper.zip': 404, '/ggml-small.bin': 503 });
  const plugin = await startedAndShaken(t, { env });

  const [whisper, model] = await bothFailed(plugin);

  assert.match(whisper!, /^whisper\.cpp v0\.0\.1 could not be fetched from http:\S+\/whisper\.zip: it answered 404, so nothing was kept\.$/);
  assert.match(model!, /^ggml-small\.bin could not be fetched from http:\S+: it answered 503, so nothing was kept\.$/);
  assert.deepEqual(await filesIn(plugin.directory), ['scribe.db']);
});

test('a download that goes quiet is given up after SCRIBE_FETCH_IDLE_MS, and a second ask waits for it', async (t) => {
  const env = await tampered(t, { '/whisper.zip': 'stall', '/ggml-small.bin': 'stall' });
  const plugin = await startedAndShaken(t, { env: { ...env, SCRIBE_FETCH_IDLE_MS: '300' } });

  await plugin.call('fetch_whisper');
  const again = refusal(await plugin.call('fetch_whisper'));
  const seen = await settled(plugin);

  assert.match(again, /being fetched already/);
  assert.match(seen.whisper.fetch?.failed ?? '', /it sent nothing for 300 ms, so nothing was kept\.$/);
  assert.deepEqual(await filesIn(plugin.directory), ['scribe.db']);
});

for (const format of ['zip', 'tar.gz'] as const) {
  test(`a ${format} build with an entry that leaves its directory is refused, and nothing is kept`, async (t) => {
    const archive = await fixtureBytes(`escape.${format}`);
    const server = await serveFiles(t, { [`/escape.${format}`]: archive });
    const env = await downloadsFile(t, {
      builds: {
        [SYSTEM]: {
          ...download(server.url(`/escape.${format}`), archive),
          format,
          program: 'build/whisper',
        },
      },
      models: [],
    });
    const plugin = await startedAndShaken(t, { env: { ...UNSET, ...env } });

    await plugin.call('fetch_whisper');
    const seen = await settled(plugin);

    assert.match(seen.whisper.fetch?.failed ?? '', /could not be unpacked: .*(outside|names no file)/);
    assert.deepEqual(await filesIn(plugin.directory), ['scribe.db']);
  });
}

test('where whisper.cpp publishes no build, the Page is told how to get one, and a path is taken', async (t) => {
  const { server, env } = await served(t, { build: false });
  const plugin = await startedAndShaken(t, { env });

  const seen = await downloads(plugin);
  const refused = refusal(await plugin.call('fetch_whisper'));
  const saved = await plugin.call('update_settings', { whisper: join(plugin.directory, 'whisper-cli') });

  assert.equal(seen.whisper.build, null);
  assert.match(seen.whisper.missing ?? '', /publishes no build for .*https:\/\/github\.com\/ggml-org\/whisper\.cpp.*absolute path/);
  assert.equal(refused, seen.whisper.missing);
  assert.equal(saved.error, undefined);
  assert.deepEqual(server.asked(), []);
});
