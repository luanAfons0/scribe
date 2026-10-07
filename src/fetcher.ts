/**
 * whisper.cpp and its model, fetched when the operator asks from the Plugin
 * Page, and never otherwise (ADR-0005).
 *
 * Each download is streamed into a file beside where it will be kept, its
 * SHA-256 worked out as it comes, and checked before anything is kept. A
 * build is then unpacked by scribe's own reader (`unpack.ts`). Only once
 * everything is in place is it renamed to where it stays, under `downloads/`
 * in the Plugin directory, and its absolute path written into the settings
 * file: so nothing else has to be set, and nothing from a failed download is
 * left behind.
 *
 * A download runs while the tools answer: the tool that starts it answers at
 * once, and `get_downloads` says how far it got, or the one sentence it
 * failed with.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rename, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { thisSystem, type Download, type Downloads } from './downloads.ts';
import { badInput, sentenceFor } from './mcp.ts';
import type { Choices, Settings } from './settings.ts';
import { unpack } from './unpack.ts';

/** The directory, inside the Plugin directory, that holds what scribe fetched. */
export const DOWNLOADS_DIRECTORY = 'downloads';

/** One download in flight, or the one that failed last. */
export type FetchView = {
  /** What is fetched: whisper.cpp and its release, or the model's file name. */
  readonly name: string;
  /** How many bytes have come so far. */
  readonly received: number;
  /** How many bytes it is. */
  readonly size: number;
  /** The one sentence it failed with, or null while it is in flight. */
  readonly failed: string | null;
};

/** What `get_downloads` answers. */
export type DownloadsView = {
  readonly whisper: {
    /** The whisper.cpp release a build would be of. */
    readonly release: string;
    /** The build for this system, or null when whisper.cpp publishes none. */
    readonly build: { readonly size: number } | null;
    /** How to get whisper.cpp when there is no build to fetch, or null. */
    readonly missing: string | null;
    readonly fetch: FetchView | null;
  };
  readonly models: {
    /** The models offered, each with its size in bytes. */
    readonly offered: readonly { readonly name: string; readonly size: number }[];
    readonly fetch: FetchView | null;
  };
};

/** The fetching of whisper.cpp and its model, in one running Plugin Server. */
export type Fetcher = {
  /** What can be fetched for this system, and how far each download got. */
  view(): DownloadsView;
  /** Start fetching the whisper.cpp build for this system, or refuse with a sentence. */
  fetchWhisper(): void;
  /** Start fetching the model of this name, or refuse with a sentence. */
  fetchModel(name: unknown): void;
};

/** One download as it goes: what the view shows, changed in place as bytes come. */
type Progress = { name: string; received: number; size: number; failed: string | null };

/** The Fetcher over this list of downloads, keeping what it fetches in `directory`. */
export function fetcherFor(
  list: Downloads,
  choices: Choices,
  settings: Pick<Settings, 'fetchIdleMs'>,
  directory = '.',
): Fetcher {
  const build = list.whisper.builds[thisSystem()] ?? null;
  const release = list.whisper.release;
  const top = resolve(directory, DOWNLOADS_DIRECTORY);
  let whisper: Progress | null = null;
  let model: Progress | null = null;

  const running = (progress: Progress | null): boolean =>
    progress !== null && progress.failed === null;

  /** Run one download to its end: null when it is kept, its sentence when it failed. */
  const run = (progress: Progress, work: () => Promise<void>, cleanUp: () => Promise<void>) =>
    work().then(
      () => null,
      async (fault: unknown) => {
        await cleanUp().catch(() => undefined);
        progress.failed = `${sentenceFor(fault).replace(/\.$/, '')}, so nothing was kept.`;
        return progress.failed;
      },
    );

  return {
    view: () => ({
      whisper: {
        release,
        build: build === null ? null : { size: build.size },
        missing: build === null ? noBuild(release) : null,
        fetch: whisper === null ? null : { ...whisper },
      },
      models: {
        offered: list.models.map((offered) => ({ name: offered.name, size: offered.size })),
        fetch: model === null ? null : { ...model },
      },
    }),

    fetchWhisper: () => {
      if (build === null) throw badInput(noBuild(release));
      if (running(whisper)) {
        throw badInput('whisper.cpp is being fetched already; get_downloads says how far it got.');
      }
      const progress: Progress = {
        name: `whisper.cpp ${release}`,
        received: 0,
        size: build.size,
        failed: null,
      };
      whisper = progress;
      const home = join(top, 'whisper.cpp');
      const kept = join(home, `${release}-${thisSystem()}`);
      const part = `${kept}.part`;
      const archive = `${kept}.${build.format}.part`;
      void run(
        progress,
        async () => {
          await mkdir(home, { recursive: true });
          await rm(part, { recursive: true, force: true });
          await fetchChecked(build, archive, progress, settings.fetchIdleMs);
          const bytes = await readFile(archive);
          await rm(archive, { force: true });
          await mkdir(part);
          try {
            unpack(bytes, build.format, part);
          } catch (fault) {
            throw new Error(
              `${progress.name} from ${build.url} could not be unpacked: ${sentenceFor(fault)}`,
            );
          }
          const program = join(part, ...build.program.split('/'));
          if (!(await stat(program).catch(() => null))?.isFile()) {
            throw new Error(`${progress.name} from ${build.url} holds no ${build.program}.`);
          }
          await chmod(program, 0o755);
          await rm(kept, { recursive: true, force: true });
          await rename(part, kept);
          choices.update({ whisper: join(kept, ...build.program.split('/')) });
        },
        async () => {
          await rm(archive, { force: true });
          await rm(part, { recursive: true, force: true });
          await emptied(home, top);
        },
      ).then((failed) => {
        if (failed === null && whisper === progress) whisper = null;
      });
    },

    fetchModel: (name) => {
      const chosen = list.models.find((offered) => offered.name === name);
      if (chosen === undefined) {
        throw badInput(
          `fetch_model takes "name" as one of ${list.models.map((m) => m.name).join(', ')}, ` +
            `and was given ${JSON.stringify(name)}.`,
        );
      }
      if (running(model)) {
        throw badInput(
          `${model!.name} is being fetched already; get_downloads says how far it got.`,
        );
      }
      const progress: Progress = {
        name: chosen.name,
        received: 0,
        size: chosen.size,
        failed: null,
      };
      model = progress;
      const home = join(top, 'models');
      const kept = join(home, chosen.name);
      const part = `${kept}.part`;
      void run(
        progress,
        async () => {
          await mkdir(home, { recursive: true });
          await fetchChecked(chosen, part, progress, settings.fetchIdleMs);
          await rename(part, kept);
          choices.update({ whisperModel: kept });
        },
        async () => {
          await rm(part, { force: true });
          await emptied(home, top);
        },
      ).then((failed) => {
        if (failed === null && model === progress) model = null;
      });
    },
  };
}

/** What the Page says where whisper.cpp publishes no build for this system. */
function noBuild(release: string): string {
  return (
    `whisper.cpp ${release} publishes no build for ${thisSystem()}: build whisper-cli from ` +
    'https://github.com/ggml-org/whisper.cpp, as its README says, and give its absolute ' +
    'path here.'
  );
}

/**
 * Fetch one file into `part`, working out its SHA-256 as it comes, and throw
 * a sentence when it cannot be fetched, goes quiet for `idleMs`, or is not the
 * file the list names. Its bytes are never kept for any other use.
 */
async function fetchChecked(
  source: Download,
  part: string,
  progress: Progress,
  idleMs: number,
): Promise<void> {
  const failed = (why: string): Error =>
    new Error(`${progress.name} could not be fetched from ${source.url}: ${why}.`);
  const quiet = new AbortController();
  let timer = setTimeout(() => quiet.abort(), idleMs);
  const hash = createHash('sha256');
  const out = await open(part, 'w');
  try {
    let answer: Response;
    try {
      answer = await fetch(source.url, { signal: quiet.signal });
    } catch (fault) {
      throw failed(quiet.signal.aborted ? `it sent nothing for ${idleMs} ms` : reason(fault));
    }
    if (!answer.ok || answer.body === null) throw failed(`it answered ${answer.status}`);
    try {
      for await (const chunk of answer.body) {
        clearTimeout(timer);
        timer = setTimeout(() => quiet.abort(), idleMs);
        progress.received += chunk.length;
        if (progress.received > source.size) break;
        hash.update(chunk);
        await out.write(chunk);
      }
    } catch (fault) {
      throw failed(quiet.signal.aborted ? `it sent nothing for ${idleMs} ms` : reason(fault));
    }
  } finally {
    clearTimeout(timer);
    await out.close();
  }
  if (progress.received !== source.size || hash.digest('hex') !== source.sha256) {
    throw new Error(
      `${progress.name} from ${source.url} is not the file scribe expects: its SHA-256 does ` +
        'not match.',
    );
  }
}

/** Why a fetch failed, from what fetch threw: its cause says more than "fetch failed". */
function reason(fault: unknown): string {
  const cause = (fault as { cause?: unknown } | null)?.cause;
  return sentenceFor(cause instanceof Error ? cause : fault).replace(/\.$/, '');
}

/** Take away directories a failed download made, each only when nothing else is in it. */
async function emptied(...directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    await rmdir(directory).catch(() => undefined);
  }
}
