/**
 * An operator sets Speakers up from the Plugin Page, as they set whisper.cpp
 * up: sherpa-onnx's diarizer for this system and its two models, fetched only
 * when asked, each checked against a known SHA-256, and kept as one diarizer
 * directory under scribe's own Plugin directory (ADR-0007). Of the build,
 * only what the diarizer needs is kept: the archive holds every program.
 *
 * A local server plays GitHub. The list of downloads scribe reads is the
 * test's own, through `SCRIBE_DOWNLOADS`, so its checksums are those of the
 * fixtures. With no diarizer set, scribe works as before, and nothing says a
 * problem.
 */
import { strict as assert } from 'node:assert';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { makeDirectory, startedAndShaken, structureOf, type Started } from './helpers/plugin.ts';
import {
  download,
  downloadsFile,
  fixtureBytes,
  serveFiles,
  SYSTEM,
  type Diarizer,
} from './helpers/server.ts';

/** The diarizer's program, as this system names it. */
const PROGRAM =
  process.platform === 'win32'
    ? 'sherpa-onnx-offline-speaker-diarization.exe'
    : 'sherpa-onnx-offline-speaker-diarization';

type Fetch = {
  readonly name: string;
  readonly received: number;
  readonly size: number;
  readonly failed: string | null;
};

type DiarizerView = {
  readonly release: string;
  readonly system: string;
  readonly build: { readonly size: number } | null;
  readonly missing: string | null;
  readonly fetch: Fetch | null;
};

type Setting = {
  readonly value: unknown;
  readonly from: string;
  readonly saved: unknown;
  readonly problem: string | null;
};

async function diarizerView(plugin: Started): Promise<DiarizerView> {
  const answer = await plugin.call('get_downloads');
  return structureOf<{ downloads: { diarizer: DiarizerView } }>(answer).downloads.diarizer;
}

async function diarizerSetting(plugin: Started): Promise<Setting> {
  const answer = await plugin.call('get_settings');
  return structureOf<{ settings: { diarizer: Setting } }>(answer).settings.diarizer;
}

/** Wait until the diarizer is not being fetched, and hand back what get_downloads says then. */
async function settled(plugin: Started): Promise<DiarizerView> {
  const until = Date.now() + 10_000;
  for (;;) {
    const seen = await diarizerView(plugin);
    if (seen.fetch === null || seen.fetch.failed !== null) return seen;
    if (Date.now() > until) throw new Error(`the download never ended: ${JSON.stringify(seen)}`);
    await new Promise((later) => setTimeout(later, 50));
  }
}

/** What a directory holds, as relative paths, every level down. */
async function filesIn(directory: string): Promise<readonly string[]> {
  const found = await readdir(directory, { recursive: true });
  return found.map((path) => path.split('\\').join('/')).sort();
}

/**
 * A server with the fixture build and both models, and the list of downloads
 * naming them. `serve` replaces what a path answers, so a test can serve other
 * bytes than the list names.
 */
async function served(
  t: test.TestContext,
  options: {
    readonly build?: string;
    readonly keep?: readonly string[];
    readonly serve?: Readonly<Record<string, Buffer>>;
    readonly forThisSystem?: boolean;
  } = {},
) {
  const archive = await fixtureBytes(options.build ?? 'diarizer-build.tar.bz2');
  const segmentation = await fixtureBytes('segmentation.tar.bz2');
  const embedding = await fixtureBytes('embedding.onnx');
  const server = await serveFiles(t, {
    '/build.tar.bz2': archive,
    '/segmentation.tar.bz2': segmentation,
    '/embedding.onnx': embedding,
    ...options.serve,
  });
  const diarizer: Diarizer = {
    release: '1.13.8',
    builds:
      options.forThisSystem === false
        ? {}
        : {
            [SYSTEM]: {
              ...download(server.url('/build.tar.bz2'), archive),
              format: 'tar.bz2',
              keep: options.keep ?? [`diarizer/bin/${PROGRAM}`, 'diarizer/lib/libonnxruntime.so'],
            },
          },
    segmentation: {
      ...download(server.url('/segmentation.tar.bz2'), segmentation),
      format: 'tar.bz2',
      member: 'segmentation/model.onnx',
    },
    embedding: download(server.url('/embedding.onnx'), embedding),
  };
  const env = await downloadsFile(t, { builds: {}, models: [], diarizer });
  const size = archive.length + segmentation.length + embedding.length;
  return { server, env, size };
}

/** Where a fetched diarizer is kept. */
function keptAt(plugin: Started): string {
  return join(plugin.directory, 'downloads', 'diarizer', `1.13.8-${SYSTEM}`);
}

test(
  'get_downloads offers the diarizer for this system with its two models, and fetches nothing',
  async (t) => {
    const { server, env, size } = await served(t);
    const plugin = await startedAndShaken(t, { env });

    const seen = await diarizerView(plugin);

    assert.deepEqual(seen, {
      release: '1.13.8',
      system: `${process.platform === 'win32' ? 'Windows' : 'Linux'} ${process.arch}`,
      build: { size },
      missing: null,
      fetch: null,
    });
    assert.deepEqual(server.asked(), []);
  },
);

test('with no diarizer set, get_settings says none and names no problem', async (t) => {
  const plugin = await startedAndShaken(t);

  const setting = await diarizerSetting(plugin);

  assert.equal(setting.value, null);
  assert.equal(setting.from, 'default');
  assert.equal(setting.problem, null);
});

test(
  'fetch_diarizer fetches the build and both models, checks them, keeps only what the ' +
    'diarizer needs, and sets it',
  async (t) => {
    const { server, env, size } = await served(t);
    const plugin = await startedAndShaken(t, { env });

    const started = structureOf<{ downloads: { diarizer: DiarizerView } }>(
      await plugin.call('fetch_diarizer'),
    );
    const seen = await settled(plugin);
    const setting = await diarizerSetting(plugin);

    assert.equal(started.downloads.diarizer.fetch?.name, 'sherpa-onnx 1.13.8');
    assert.equal(started.downloads.diarizer.fetch?.size, size);
    assert.equal(seen.fetch, null);
    assert.deepEqual(
      [...server.asked()].sort(),
      ['/build.tar.bz2', '/embedding.onnx', '/segmentation.tar.bz2'],
    );
    assert.deepEqual(setting, {
      value: keptAt(plugin),
      from: 'file',
      saved: keptAt(plugin),
      problem: null,
      variable: 'SCRIBE_DIARIZER',
      ignored: null,
    });
    assert.deepEqual(await filesIn(keptAt(plugin)), [
      'embedding.onnx',
      'libonnxruntime.so',
      PROGRAM,
      'segmentation.onnx',
    ].sort());
  },
);

test(
  'a kept member that spans bzip2 blocks unpacks byte for byte, and one that is not kept is ' +
    'passed over',
  async (t) => {
    // diarizer-blocks.tar.bz2 is bzip2 -1, so a block holds 100 kB of the tar,
    // and each program in it, at 155 kB and 251 kB, spans two blocks or more.
    const { env } = await served(t, {
      build: 'diarizer-blocks.tar.bz2',
      keep: [`diarizer/bin/${PROGRAM}`],
    });
    const plugin = await startedAndShaken(t, { env });

    await plugin.call('fetch_diarizer');
    const seen = await settled(plugin);

    assert.equal(seen.fetch, null, seen.fetch?.failed ?? '');
    const lines = Array.from({ length: 6000 }, (_, n) => `line ${n} of the diarizer\n`);
    assert.equal(await readFile(join(keptAt(plugin), PROGRAM), 'utf8'), lines.join(''));
    assert.deepEqual(await filesIn(keptAt(plugin)), [
      'embedding.onnx',
      PROGRAM,
      'segmentation.onnx',
    ].sort());
  },
);

test(
  'a diarizer download whose SHA-256 does not match is refused in one sentence, and nothing ' +
    'is kept',
  async (t) => {
    const segmentation = Buffer.from(await fixtureBytes('segmentation.tar.bz2'));
    segmentation[segmentation.length - 1] = (segmentation[segmentation.length - 1]! + 1) % 256;
    const { env } = await served(t, { serve: { '/segmentation.tar.bz2': segmentation } });
    const plugin = await startedAndShaken(t, { env });

    await plugin.call('fetch_diarizer');
    const seen = await settled(plugin);

    assert.match(
      seen.fetch?.failed ?? '',
      /^sherpa-onnx 1\.13\.8 from http:\S+\/segmentation\.tar\.bz2 is not the file scribe expects: its SHA-256 does not match, so nothing was kept\.$/,
    );
    assert.deepEqual(await filesIn(plugin.directory), ['scribe.db']);
    assert.equal((await diarizerSetting(plugin)).value, null);
  },
);

test(
  'a diarizer build with an entry that leaves its directory is refused, even where that entry ' +
    'is not kept, and nothing is kept',
  async (t) => {
    const { env } = await served(t, {
      build: 'diarizer-escape.tar.bz2',
      keep: [`diarizer/bin/sherpa-onnx-offline-speaker-diarization`],
    });
    const plugin = await startedAndShaken(t, { env });

    await plugin.call('fetch_diarizer');
    const seen = await settled(plugin);

    assert.match(
      seen.fetch?.failed ?? '',
      /could not be unpacked: \.\.\/escaped would land outside the directory/,
    );
    assert.deepEqual(await filesIn(plugin.directory), ['scribe.db']);
  },
);

test(
  'a diarizer build that does not hold a member it should keep is refused, and nothing is kept',
  async (t) => {
    const { env } = await served(t, { keep: ['diarizer/bin/not-there'] });
    const plugin = await startedAndShaken(t, { env });

    await plugin.call('fetch_diarizer');
    const seen = await settled(plugin);

    assert.match(seen.fetch?.failed ?? '', /diarizer\/bin\/not-there is not in the archive/);
    assert.deepEqual(await filesIn(plugin.directory), ['scribe.db']);
  },
);

test(
  'where sherpa-onnx publishes no build for this system, the Page is told how to get one',
  async (t) => {
    const { server, env } = await served(t, { forThisSystem: false });
    const plugin = await startedAndShaken(t, { env });

    const seen = await diarizerView(plugin);
    const refused = await plugin.call('fetch_diarizer');

    assert.equal(seen.build, null);
    assert.match(seen.missing ?? '', /SCRIBE_DIARIZER/);
    assert.equal(refused.error?.message, seen.missing);
    assert.deepEqual(server.asked(), []);
  },
);

/** A diarizer directory made by hand: the program and both models. */
async function handMade(t: test.TestContext): Promise<string> {
  const directory = await makeDirectory(t);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, PROGRAM), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(directory, 'segmentation.onnx'), 'model');
  await writeFile(join(directory, 'embedding.onnx'), 'model');
  return directory;
}

test('SCRIBE_DIARIZER beats the settings file, as SCRIBE_WHISPER does', async (t) => {
  const fromVariable = await handMade(t);
  const fromFile = await handMade(t);
  const plugin = await startedAndShaken(t, { env: { SCRIBE_DIARIZER: fromVariable } });

  await plugin.call('update_settings', { diarizer: fromFile });
  const setting = await diarizerSetting(plugin);

  assert.equal(setting.value, fromVariable);
  assert.equal(setting.from, 'environment');
  assert.equal(setting.saved, fromFile);
  assert.equal(setting.problem, null);
});

test('a diarizer directory without a model says which one is missing', async (t) => {
  const directory = await makeDirectory(t);
  await writeFile(join(directory, PROGRAM), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(directory, 'segmentation.onnx'), 'model');
  const plugin = await startedAndShaken(t);

  await plugin.call('update_settings', { diarizer: directory });
  const setting = await diarizerSetting(plugin);

  assert.equal(setting.value, directory);
  assert.match(setting.problem ?? '', /embedding\.onnx/);
  assert.match(setting.problem ?? '', /Speakers/);
});
