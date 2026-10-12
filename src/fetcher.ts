/**
 * whisper.cpp and its model, and the diarizer, fetched when the operator asks
 * from the Plugin Page, and never otherwise (ADR-0005, ADR-0007).
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
 * The diarizer is three downloads kept as one directory: a sherpa-onnx build,
 * of which only the members the list names are kept, the segmentation model,
 * of which only the model is kept, and the embedding model. Its progress is
 * that of the three together, and the setting names the directory.
 *
 * A download runs while the tools answer: the tool that starts it answers at
 * once, and `get_downloads` says how far it got, or the one sentence it
 * failed with.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, open, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { thisSystem, type Download, type Downloads, type Format } from './downloads.ts';
import { badInput, sentenceFor } from './mcp.ts';
import {
  DIARIZER_PROGRAM,
  EMBEDDING_MODEL,
  SEGMENTATION_MODEL,
  type Choices,
  type Settings,
} from './settings.ts';
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
  /** What is fetched: whisper.cpp or sherpa-onnx and its release, or the model's file name. */
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
  readonly diarizer: {
    /** The sherpa-onnx release a build would be of. */
    readonly release: string;
    /** This system, as a person names it, such as Linux x64. */
    readonly system: string;
    /** The build for this system, with both models, as the bytes of all three; or null. */
    readonly build: { readonly size: number } | null;
    /** How to get the diarizer when there is no build to fetch, or null. */
    readonly missing: string | null;
    readonly fetch: FetchView | null;
  };
};

/** The fetching of whisper.cpp, its model and the diarizer, in one running Plugin Server. */
export type Fetcher = {
  /** What can be fetched for this system, and how far each download got. */
  view(): DownloadsView;
  /** Start fetching the whisper.cpp build for this system, or refuse with a sentence. */
  fetchWhisper(): void;
  /** Start fetching the model of this name, or refuse with a sentence. */
  fetchModel(name: unknown): void;
  /** Start fetching the diarizer for this system and its two models, or refuse with a sentence. */
  fetchDiarizer(): void;
};

/** The downloads that may run at once: one of each. */
type Slot = 'whisper' | 'model' | 'diarizer';

/** One file a job downloads, and the file its bytes are written into as they come. */
type Part = { readonly source: Download; readonly into: string };

/** One download, as `startDownload` runs it. */
type Job = {
  /** What is fetched, as the view and every sentence name it. */
  readonly name: string;
  /** What it downloads, one after another, each checked before the next. */
  readonly parts: readonly Part[];
  /** Where it stays once it is in place: a file or a directory. */
  readonly kept: string;
  /** The setting that names what was fetched. */
  readonly setting: 'whisper' | 'whisperModel' | 'diarizer';
  /**
   * Make what is kept, at `part`, out of the checked bytes of each part, and
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
  const diarizer = list.diarizer;
  const diarizerBuild = diarizer.builds[thisSystem()] ?? null;
  const fetches: Record<Slot, FetchView | null> = { whisper: null, model: null, diarizer: null };
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
      size: job.parts.reduce((sum, part) => sum + part.source.size, 0),
      failed: null,
    };
    fetches[slot] = progress;
    const part = `${job.kept}${PART}`;
    const home = dirname(job.kept);
    const fetchAndKeep = async (): Promise<void> => {
      await mkdir(home, { recursive: true });
      await rm(part, { recursive: true, force: true });
      for (const each of job.parts) {
        await downloadAndVerify(each.source, each.into, progress, settings.fetchIdleMs);
      }
      const named = await job.make(part);
      await putInPlace(part, job.kept, () => choices.update({ [job.setting]: named }));
    };
    void fetchAndKeep().then(
      () => {
        if (fetches[slot] === progress) fetches[slot] = null;
      },
      async (fault: unknown) => {
        for (const each of job.parts) {
          await rm(each.into, { force: true }).catch(() => undefined);
        }
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
      diarizer: {
        release: diarizer.release,
        system: systemName(),
        build:
          diarizerBuild === null
            ? null
            : { size: diarizerBuild.size + diarizer.segmentation.size + diarizer.embedding.size },
        missing: diarizerBuild === null ? noDiarizer(diarizer.release) : null,
        fetch: fetches.diarizer === null ? null : { ...fetches.diarizer },
      },
    }),

    fetchWhisper: () => {
      if (build === null) throw badInput(noBuild(release));
      const name = `whisper.cpp ${release}`;
      const kept = join(top, 'whisper.cpp', `${release}-${thisSystem()}`);
      const into = `${kept}.${build.format}${PART}`;
      startDownload('whisper', {
        name,
        parts: [{ source: build, into }],
        kept,
        setting: 'whisper',
        make: async (part) => {
          await mkdir(part);
          await unpackPart(name, build, build.format, into, part);
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
        parts: [{ source: chosen, into: `${kept}${PART}` }],
        kept,
        setting: 'whisperModel',
        make: async () => kept,
      });
    },

    fetchDiarizer: () => {
      if (diarizerBuild === null) throw badInput(noDiarizer(diarizer.release));
      const name = `sherpa-onnx ${diarizer.release}`;
      const kept = join(top, 'diarizer', `${diarizer.release}-${thisSystem()}`);
      const build = `${kept}.build.${diarizerBuild.format}${PART}`;
      const segmentation = `${kept}.segmentation.${diarizer.segmentation.format}${PART}`;
      const embedding = `${kept}.${EMBEDDING_MODEL}${PART}`;
      startDownload('diarizer', {
        name,
        parts: [
          { source: diarizerBuild, into: build },
          { source: diarizer.segmentation, into: segmentation },
          { source: diarizer.embedding, into: embedding },
        ],
        kept,
        setting: 'diarizer',
        // One directory, with every file side by side: the Linux program finds
        // its ONNX Runtime beside itself.
        make: async (part) => {
          await mkdir(part);
          const members = diarizerBuild.keep.map((member): [string, string] => [
            member,
            posix.basename(member),
          ]);
          await unpackPart(name, diarizerBuild, diarizerBuild.format, build, part, members);
          await unpackPart(name, diarizer.segmentation, diarizer.segmentation.format,
            segmentation, part, [[diarizer.segmentation.member, SEGMENTATION_MODEL]]);
          await rename(embedding, join(part, EMBEDDING_MODEL));
          const program = join(part, DIARIZER_PROGRAM);
          if (!(await stat(program).catch(() => null))?.isFile()) {
            throw new Error(`${name} from ${diarizerBuild.url} holds no ${DIARIZER_PROGRAM}.`);
          }
          await chmod(program, 0o755);
          return kept;
        },
      });
    },
  };
}

/**
 * Unpack the checked download at `into` into `part`, and remove it; with
 * `keep`, only those members, each at the name it maps to.
 */
async function unpackPart(
  name: string,
  source: Download,
  format: Format,
  into: string,
  part: string,
  keep?: readonly (readonly [string, string])[],
): Promise<void> {
  try {
    unpack(into, format, part, keep === undefined ? undefined : new Map(keep));
  } catch (fault) {
    throw new Error(`${name} from ${source.url} could not be unpacked: ${sentenceFor(fault)}`);
  } finally {
    await rm(into, { force: true });
  }
}

/** This system, as a person names it: the Page cannot tell, as a wsl Place runs Linux. */
function systemName(): string {
  const names: Readonly<Record<string, string>> = {
    linux: 'Linux',
    win32: 'Windows',
    darwin: 'macOS',
  };
  return `${names[process.platform] ?? process.platform} ${process.arch}`;
}

/** What the Page says where sherpa-onnx publishes no build that runs on this system. */
function noDiarizer(release: string): string {
  return (
    `sherpa-onnx ${release} offers no diarizer scribe can fetch for ${thisSystem()}: build ` +
    'sherpa-onnx-offline-speaker-diarization from https://github.com/k2-fsa/sherpa-onnx, put ' +
    `it in one directory with the two models, named ${SEGMENTATION_MODEL} and ` +
    `${EMBEDDING_MODEL}, as scribe's README says, and set SCRIBE_DIARIZER to that directory ` +
    'where the Host is started.'
  );
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
  // The view counts every part of a job together; this file's own bytes are counted here.
  let received = 0;
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
        received += chunk.length;
        progress.received += chunk.length;
        if (received > source.size) break;
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
  if (received !== source.size || hash.digest('hex') !== source.sha256) {
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
