/**
 * A whisper.cpp build is unpacked by scribe's own reader, and the reader
 * trusts no number an archive gives it: a size, an offset or a length that
 * leads past the bytes it holds is refused, and so is an entry that unpacks
 * to more than it says, or a path the archive holds twice (ADR-0005).
 *
 * Each archive here is built by the test, byte by byte, so it can lie in the
 * one field the test is about. A local server serves it as the build for this
 * system, and the test reads the sentence the fetch failed with.
 */
import { strict as assert } from 'node:assert';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { startedAndShaken, structureOf, type Started } from './helpers/plugin.ts';
import { download, downloadsFile, serveFiles, SYSTEM } from './helpers/server.ts';

/** No whisper.cpp and no model from the environment: the Page is where they come from. */
const UNSET = { SCRIBE_WHISPER: '', SCRIBE_WHISPER_MODEL: '' };

/** The program inside every build here. */
const PROGRAM = 'build/whisper';

/** A small script, as the program a build holds. */
const SCRIPT = Buffer.from('#!/bin/sh\necho whisper\n');

type Fetch = { readonly failed: string | null };
type Downloads = { readonly whisper: { readonly fetch: Fetch | null } };
type Settings = { readonly whisper: { readonly value: unknown; readonly from: string } };

/** One entry of a tar this test builds, with a size field that may lie. */
type TarEntry = {
  readonly name: string;
  readonly type: '0' | '5';
  readonly data?: Buffer;
  /** What the size field says, in place of the data's own length. */
  readonly sizeField?: string;
};

/** A tar.gz of these entries, in the ustar form. */
function tarGz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000755\0', 100, 8, 'ascii');
    const size = entry.sizeField ?? `${data.length.toString(8).padStart(11, '0')}\0`;
    header.write(size, 124, 12, 'ascii');
    header.write(entry.type, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** One entry of a zip this test builds, with lengths that may lie. */
type ZipEntry = {
  readonly name: string;
  readonly data: Buffer;
  readonly deflate?: boolean;
  /** What the central directory says the packed length is. */
  readonly packed?: number;
  /** What the central directory says the size is. */
  readonly size?: number;
};

/** A zip of these entries, made on Unix, with no comment. */
function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = entry.deflate === true ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate === true ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt8(3, 5);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entry.packed ?? body.length, 20);
    central.writeUInt32LE(entry.size ?? entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A Plugin Server whose build for this system is this archive. */
async function withBuild(
  t: test.TestContext,
  format: 'zip' | 'tar.gz',
  archive: Buffer,
): Promise<Started> {
  const server = await serveFiles(t, { [`/build.${format}`]: archive });
  const env = await downloadsFile(t, {
    builds: {
      [SYSTEM]: { ...download(server.url(`/build.${format}`), archive), format, program: PROGRAM },
    },
    models: [],
  });
  return startedAndShaken(t, { env: { ...UNSET, ...env } });
}

/** Fetch the build, wait for the fetch to end, and hand back the sentence it failed with. */
async function fetched(plugin: Started): Promise<string | null> {
  await plugin.call('fetch_whisper');
  const until = Date.now() + 10_000;
  for (;;) {
    const seen = structureOf<{ downloads: Downloads }>(await plugin.call('get_downloads'));
    const fetch = seen.downloads.whisper.fetch;
    if (fetch === null || fetch.failed !== null) return fetch?.failed ?? null;
    if (Date.now() > until) throw new Error('the fetch never ended');
    await new Promise((later) => setTimeout(later, 50));
  }
}

/** Assert the fetch was refused while unpacking, for this reason, and kept nothing. */
async function refused(plugin: Started, reason: RegExp): Promise<void> {
  const failed = (await fetched(plugin)) ?? 'it did not fail';
  assert.match(failed, /could not be unpacked: /);
  assert.match(failed, reason);
  assert.match(failed, /, so nothing was kept\.$/);
  assert.deepEqual(await readdir(plugin.directory), ['scribe.db']);
}

test('a zip entry that unpacks to more than its declared size is refused', async (t) => {
  const archive = zip([
    { name: PROGRAM, data: Buffer.alloc(100_000, 0x61), deflate: true, size: 10 },
  ]);
  const plugin = await withBuild(t, 'zip', archive);

  await refused(plugin, /build\/whisper unpacks to more than the 10 bytes/);
});

test('a zip entry whose packed length runs past the archive is refused', async (t) => {
  const archive = zip([{ name: PROGRAM, data: SCRIPT, packed: 1_000_000 }]);
  const plugin = await withBuild(t, 'zip', archive);

  await refused(plugin, /build\/whisper runs past the end of the archive/);
});

test('a tar entry whose data runs past the archive is refused', async (t) => {
  const archive = tarGz([
    { name: PROGRAM, type: '0', data: SCRIPT, sizeField: '00000303240\0' },
  ]);
  const plugin = await withBuild(t, 'tar.gz', archive);

  await refused(plugin, /build\/whisper runs past the end of the archive/);
});

test('a tar entry whose size is not a number is refused', async (t) => {
  const archive = tarGz([{ name: PROGRAM, type: '0', data: SCRIPT, sizeField: 'zzzzzzzzzzz\0' }]);
  const plugin = await withBuild(t, 'tar.gz', archive);

  await refused(plugin, /build\/whisper has a size that is not a number/);
});

for (const format of ['zip', 'tar.gz'] as const) {
  test(`a ${format} that holds one path twice is refused`, async (t) => {
    const archive =
      format === 'zip'
        ? zip([
            { name: PROGRAM, data: SCRIPT },
            { name: './build/whisper', data: Buffer.from('other') },
          ])
        : tarGz([
            { name: PROGRAM, type: '0', data: SCRIPT },
            { name: './build/whisper', type: '0', data: Buffer.from('other') },
          ]);
    const plugin = await withBuild(t, format, archive);

    await refused(plugin, /build\/whisper is in the archive twice/);
  });
}

for (const format of ['zip', 'tar.gz'] as const) {
  test(`a ${format} that starts with its own directory as ./ still unpacks`, async (t) => {
    const archive =
      format === 'zip'
        ? zip([
            { name: './', data: Buffer.alloc(0) },
            { name: 'build/', data: Buffer.alloc(0) },
            { name: PROGRAM, data: SCRIPT },
          ])
        : tarGz([
            { name: './', type: '5' },
            { name: './build/', type: '5' },
            { name: `./${PROGRAM}`, type: '0', data: SCRIPT },
          ]);
    const plugin = await withBuild(t, format, archive);

    const failed = await fetched(plugin);
    const settings = structureOf<{ settings: Settings }>(await plugin.call('get_settings'));

    assert.equal(failed, null);
    assert.equal(settings.settings.whisper.from, 'file');
  });
}
