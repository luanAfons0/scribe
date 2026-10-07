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
 * What is there already, the build of the same release fetched before, is set
 * aside and removed only once the new one is in place and its setting saved.
 * A rename or a save that fails puts it back, so the build in use is never
 * lost. A Plugin Server that stops halfway leaves `.part` files, which the
 * next start removes, and a build set aside, which it puts back or removes.
 *
 * A download runs while the tools answer: the tool that starts it answers at
 * once, and `get_downloads` says how far it got, or the one sentence it
 * failed with.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, open, rename, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { thisSystem, type Download, type Downloads } from './downloads.ts';
import { badInput, sentenceFor } from './mcp.ts';
import type { Choices, Settings } from './settings.ts';
import { unpack } from './unpack.ts';

/** The directory, inside the Plugin directory, that holds what scribe fetched. */
export const DOWNLOADS_DIRECTORY = 'downloads';

/** The end of the name of what a download writes before it is in place. */
const PART = '.part';

/** The end of the name of what was in place, set aside while a new one takes its place. */
const ASIDE = '.old';

/**
 * One download in flight, or the one that failed last. The fetcher changes it
 * in place as bytes come; the view gets a copy.
 */
export type FetchView = {
  /** What is fetched: whisper.cpp and its release, or the model's file name. */
  readonly name: string;
  /** How many bytes have come so far. */
  received: number;
  /** How many bytes it is. */
  readonly size: number;
  /** The one sentence it failed with, or null while it is in flight. */
  failed: string | null;
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
    /** The model the Page offers first, or null for the first one. */
    readonly default: string | null;
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

/** The two downloads that may run at once: one of whisper.cpp, one of a model. */
type Slot = 'whisper' | 'model';

/** One download, as `startDownload` runs it. */
type Job = {
  /** What is fetched, as the view and every sentence name it. */
  readonly name: string;
  /** Where it comes from, how big it is, and its SHA-256. */
  readonly source: Download;
  /** Where it stays once it is in place: a file or a directory. */
  readonly kept: string;
  /** The file the bytes are written into as they come. */
  readonly into: string;
  /** The setting that names what was fetched. */
  readonly setting: 'whisper' | 'whisperModel';
  /**
   * Make what is kept, at `part`, out of the checked bytes in `into`, and
   * hand back the path the setting names once `part` is at `kept`.
   */
  readonly make: (part: string) => Promise<string>;
};

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
  const fetches: Record<Slot, FetchView | null> = { whisper: null, model: null };
  clearInterrupted(top);

  /** Start one download, and answer at once; it ends kept and set, or failed with a sentence. */
  const startDownload = (slot: Slot, job: Job): void => {
    const current = fetches[slot];
    if (current !== null && current.failed === null) {
      throw badInput(
        `${current.name} is being fetched already; get_downloads says how far it got.`,
      );
    }
    const progress: FetchView = {
      name: job.name,
      received: 0,
      size: job.source.size,
      failed: null,
    };
    fetches[slot] = progress;
    const part = `${job.kept}${PART}`;
    const home = dirname(job.kept);
    const fetchAndKeep = async (): Promise<void> => {
      await mkdir(home, { recursive: true });
      await rm(part, { recursive: true, force: true });
      await downloadAndVerify(job.source, job.into, progress, settings.fetchIdleMs);
      const named = await job.make(part);
      await putInPlace(part, job.kept, () => choices.update({ [job.setting]: named }));
    };
    void fetchAndKeep().then(
      () => {
        if (fetches[slot] === progress) fetches[slot] = null;
      },
      async (fault: unknown) => {
        await rm(job.into, { force: true }).catch(() => undefined);
        await rm(part, { recursive: true, force: true }).catch(() => undefined);
        await removeIfEmpty(home, top);
        progress.failed = `${sentenceFor(fault).replace(/\.$/, '')}, so nothing was kept.`;
      },
    );
  };

  return {
    view: () => ({
      whisper: {
        release,
        build: build === null ? null : { size: build.size },
        missing: build === null ? noBuild(release) : null,
        fetch: fetches.whisper === null ? null : { ...fetches.whisper },
      },
      models: {
        offered: list.models.map((offered) => ({ name: offered.name, size: offered.size })),
        default: list.defaultModel,
        fetch: fetches.model === null ? null : { ...fetches.model },
      },
    }),

    fetchWhisper: () => {
      if (build === null) throw badInput(noBuild(release));
      const name = `whisper.cpp ${release}`;
      const kept = join(top, 'whisper.cpp', `${release}-${thisSystem()}`);
      const into = `${kept}.${build.format}${PART}`;
      startDownload('whisper', {
        name,
        source: build,
        kept,
        into,
        setting: 'whisper',
        make: async (part) => {
          const bytes = await readFile(into);
          await rm(into, { force: true });
          await mkdir(part);
          try {
            unpack(bytes, build.format, part);
          } catch (fault) {
            throw new Error(
              `${name} from ${build.url} could not be unpacked: ${sentenceFor(fault)}`,
            );
          }
          const inside = build.program.split('/');
          const program = join(part, ...inside);
          if (!(await stat(program).catch(() => null))?.isFile()) {
            throw new Error(`${name} from ${build.url} holds no ${build.program}.`);
          }
          await chmod(program, 0o755);
          return join(kept, ...inside);
        },
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
      const kept = join(top, 'models', chosen.name);
      // A model is one file, written where it is made: it is in place once renamed.
      startDownload('model', {
        name: chosen.name,
        source: chosen,
        kept,
        into: `${kept}${PART}`,
        setting: 'whisperModel',
        make: async () => kept,
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
 * Put what was made at `part` where it stays, at `kept`, and save the setting
 * that names it. What was at `kept` is set aside first and removed only at the
 * end, so a rename or a save that fails puts it back: the build in use is
 * never lost, and nothing new is left.
 */
async function putInPlace(part: string, kept: string, save: () => void): Promise<void> {
  const aside = `${kept}${ASIDE}`;
  await rm(aside, { recursive: true, force: true });
  const had = await stat(kept).then(
    () => true,
    () => false,
  );
  if (had) await rename(kept, aside);
  try {
    await rename(part, kept);
  } catch (fault) {
    if (had) await rename(aside, kept);
    throw fault;
  }
  try {
    save();
  } catch (fault) {
    await rm(kept, { recursive: true, force: true });
    if (had) await rename(aside, kept);
    throw fault;
  }
  await rm(aside, { recursive: true, force: true });
}

/**
 * Take away what a Plugin Server that stopped mid-download left under
 * `downloads/`: every `.part` file and directory. What was set aside is put
 * back when nothing took its place, and removed when something did. It runs
 * once, at start, before any download can.
 */
function clearInterrupted(top: string): void {
  try {
    clearEach(top);
  } catch (fault) {
    process.stderr.write(
      `scribe: what a stopped download left in ${top} could not all be removed: ` +
        `${sentenceFor(fault)}\n`,
    );
  }
}

function clearEach(top: string): void {
  for (const home of entriesOf(top)) {
    if (!statSync(home).isDirectory()) continue;
    for (const path of entriesOf(home)) {
      if (path.endsWith(PART)) rmSync(path, { recursive: true, force: true });
      if (!path.endsWith(ASIDE)) continue;
      const kept = path.slice(0, -ASIDE.length);
      if (existsSync(kept)) rmSync(path, { recursive: true, force: true });
      else renameSync(path, kept);
    }
  }
}

/** The paths of what a directory holds, or none when it is not there. */
function entriesOf(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).map((name) => join(directory, name));
}

/**
 * Download one file into `into`, working out its SHA-256 as it comes, and
 * throw a sentence when it cannot be fetched, goes quiet for `idleMs`, or is
 * not the file the list names. Its bytes are never kept for any other use.
 */
async function downloadAndVerify(
  source: Download,
  into: string,
  progress: FetchView,
  idleMs: number,
): Promise<void> {
  const failed = (why: string): Error =>
    new Error(`${progress.name} could not be fetched from ${source.url}: ${why}.`);
  const quiet = new AbortController();
  let timer = setTimeout(() => quiet.abort(), idleMs);
  const hash = createHash('sha256');
  const out = await open(into, 'w');
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

/** Remove the directories a failed download made, each only when nothing else is in it. */
async function removeIfEmpty(...directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    await rmdir(directory).catch(() => undefined);
  }
}
