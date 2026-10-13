/**
 * A local HTTP server that plays the places scribe fetches from: GitHub's
 * releases of whisper.cpp and Hugging Face's models. No test reaches the
 * network; each serves the bytes it chose, on loopback, and reads back what
 * scribe asked for.
 *
 * It also writes the list of downloads scribe reads in place of its own
 * (`SCRIBE_DOWNLOADS`), with URLs on this server and the SHA-256 of the bytes
 * the test meant to serve, so a test can serve other bytes and see them
 * refused. sherpa-onnx's releases are played the same way.
 */
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { FIXTURES, makeDirectory } from './plugin.ts';

/** What one path answers: these bytes, a status with no body, or a body that never ends. */
export type Route = Buffer | number | 'stall';

export type Served = {
  /** The address of a path on this server. */
  url(path: string): string;
  /** Every path scribe asked for, in order. */
  asked(): readonly string[];
};

/** Serve these routes on loopback until the test ends. */
export async function serveFiles(
  t: TestContext,
  routes: Readonly<Record<string, Route>>,
): Promise<Served> {
  const asked: string[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    asked.push(path);
    const route = routes[path];
    if (route === undefined) {
      response.writeHead(404).end();
    } else if (typeof route === 'number') {
      response.writeHead(route).end();
    } else if (route === 'stall') {
      // A few bytes, then nothing: a connection that went quiet.
      response.writeHead(200, { 'content-length': '1000000' });
      response.write(Buffer.alloc(10));
      held.push(response);
    } else {
      response.writeHead(200, { 'content-length': String(route.length) }).end(route);
    }
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  t.after(async () => {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((closed) => server.close(() => closed()));
  });
  const { port } = server.address() as AddressInfo;
  return { url: (path) => `http://127.0.0.1:${port}${path}`, asked: () => asked };
}

/** The SHA-256 of some bytes, as hex. */
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A fixture file's bytes. */
export function fixtureBytes(name: string): Promise<Buffer> {
  return readFile(join(FIXTURES, name));
}

/** This system and architecture, as the list of downloads names a build. */
export const SYSTEM = `${process.platform}-${process.arch}`;

/** The program inside a fixture build, in the form this system runs. */
export const FIXTURE_PROGRAM = process.platform === 'win32' ? 'build/whisper.cmd' : 'build/whisper';

/** One file to fetch, as the list of downloads names it. */
export type Download = {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
};

/** A whisper.cpp build, as the list of downloads names it. */
export type Build = Download & {
  readonly format: 'zip' | 'tar.gz' | 'tar.bz2';
  readonly program: string;
};

/** A model, as the list of downloads names it. */
export type Model = Download & { readonly name: string };

/** A sherpa-onnx build, as the list of downloads names it: the members of it kept. */
export type DiarizerBuild = Download & {
  readonly format: 'zip' | 'tar.gz' | 'tar.bz2';
  readonly keep: readonly string[];
};

/** The diarizer, as the list of downloads names it: its builds and its two models. */
export type Diarizer = {
  readonly release: string;
  readonly builds: Readonly<Record<string, DiarizerBuild>>;
  /** The segmentation model: an archive, and the one member of it kept. */
  readonly segmentation: Download & { readonly format: 'tar.bz2'; readonly member: string };
  /** The embedding model: one file. */
  readonly embedding: Download;
};

/** A diarizer with no build for any system, for a test that is not about it. */
const NO_DIARIZER: Diarizer = {
  release: '0.0.1',
  builds: {},
  segmentation: {
    url: 'http://127.0.0.1:9/segmentation.tar.bz2',
    size: 1,
    sha256: '0'.repeat(64),
    format: 'tar.bz2',
    member: 'segmentation/model.onnx',
  },
  embedding: { url: 'http://127.0.0.1:9/embedding.onnx', size: 1, sha256: '0'.repeat(64) },
};

/** One download of these bytes at this address. */
export function download(url: string, bytes: Buffer): Download {
  return { url, size: bytes.length, sha256: sha256(bytes) };
}

/**
 * Write a list of downloads into a directory of the test's own, and hand back
 * the environment that makes scribe read it.
 */
export async function downloadsFile(
  t: TestContext,
  list: {
    readonly release?: string;
    readonly builds: Readonly<Record<string, Build>>;
    readonly models: readonly Model[];
    /** The model the Page offers first; without one, the first model, or none. */
    readonly defaultModel?: string | null;
    /** The diarizer; without one, a diarizer with no build. */
    readonly diarizer?: Diarizer;
  },
): Promise<Record<string, string>> {
  const directory = await makeDirectory(t);
  const path = join(directory, 'downloads.json');
  const whole = {
    whisper: { release: list.release ?? 'v0.0.1', builds: list.builds },
    models: list.models,
    defaultModel:
      list.defaultModel === undefined ? (list.models[0]?.name ?? null) : list.defaultModel,
    diarizer: list.diarizer ?? NO_DIARIZER,
  };
  await writeFile(path, JSON.stringify(whole));
  return { SCRIBE_DOWNLOADS: path };
}
