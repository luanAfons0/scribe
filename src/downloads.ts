/**
 * What scribe can fetch for an operator who has no whisper.cpp: a build of it
 * for each system that has one, and the models it reads, each with the
 * address it comes from, its size and its SHA-256 (ADR-0005).
 *
 * The list is data, in `downloads.json` beside this file, so a new release is
 * a change of data and no logic changes with it:
 *
 * - The builds are the assets of one whisper.cpp release on GitHub
 *   (`ggml-org/whisper.cpp`, the nightly tag a release names: v1.9.4 is
 *   b5130). Their SHA-256 is the `digest` GitHub gives each release asset,
 *   checked against the bytes when they were pinned.
 * - The models are files of `ggerganov/whisper.cpp` on Hugging Face, at one
 *   commit, so the bytes behind an address never change. Their SHA-256 is
 *   the Git LFS object id Hugging Face gives each file.
 * - `defaultModel` names the model the Page offers first: the one that was
 *   measured to keep up with a live Call.
 * - `diarizer` is sherpa-onnx's speaker diarization, which tells the people in
 *   the call's sound apart (ADR-0007): a build of one sherpa-onnx release on
 *   GitHub for each system that has one that runs, and its two models, as
 *   the spike measured and pinned them. A build archive holds every program
 *   of sherpa-onnx, so `keep` names the few members the diarizer needs.
 *
 * `SCRIBE_DOWNLOADS` names another file of the same form, read in place of
 * this one. It is how a test serves its own fixtures; an operator has no
 * reason to set it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The environment variable that names a list of downloads read in place of scribe's own. */
export const DOWNLOADS_VARIABLE = 'SCRIBE_DOWNLOADS';

/** scribe's own list of downloads. */
const OWN = fileURLToPath(new URL('./downloads.json', import.meta.url));

/** One file to fetch: where it is, how big it is, and its SHA-256 as hex. */
export type Download = {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
};

/** How a build is packed. */
export type Format = 'zip' | 'tar.gz' | 'tar.bz2';

/** Every format scribe unpacks. */
const FORMATS: readonly Format[] = ['zip', 'tar.gz', 'tar.bz2'];

/** A whisper.cpp build: an archive, and the path of whisper-cli inside it. */
export type Build = Download & { readonly format: Format; readonly program: string };

/** A whisper.cpp model: one file, kept under its own name. */
export type Model = Download & { readonly name: string };

/**
 * A sherpa-onnx build: an archive, and the members of it the diarizer needs,
 * each kept under its own base name.
 */
export type DiarizerBuild = Download & {
  readonly format: Format;
  readonly keep: readonly string[];
};

/** The diarizer's segmentation model: an archive, and the one member of it that is the model. */
export type Segmentation = Download & { readonly format: Format; readonly member: string };

/** The diarizer, as it can be fetched: a build for each system, and its two models. */
export type DiarizerDownloads = {
  /** The sherpa-onnx release the builds are of, such as 1.13.8. */
  readonly release: string;
  /** A build for each system and architecture that has one, by `<platform>-<arch>`. */
  readonly builds: Readonly<Record<string, DiarizerBuild>>;
  readonly segmentation: Segmentation;
  /** The embedding model: one file. */
  readonly embedding: Download;
};

/** Everything scribe can fetch. */
export type Downloads = {
  readonly whisper: {
    /** The whisper.cpp release the builds are of, such as v1.9.4. */
    readonly release: string;
    /** A build for each system and architecture that has one, by `<platform>-<arch>`. */
    readonly builds: Readonly<Record<string, Build>>;
  };
  /** The models offered, in the order the Page offers them. */
  readonly models: readonly Model[];
  /** The model the Page offers first, by its name, or null for the first one. */
  readonly defaultModel: string | null;
  readonly diarizer: DiarizerDownloads;
};

/** This system and architecture, as the list names a build. */
export function thisSystem(): string {
  return `${process.platform}-${process.arch}`;
}

/** Read the list of downloads, or throw a sentence that names the file and what is wrong. */
export function readDownloads(env: NodeJS.ProcessEnv = process.env): Downloads {
  const given = (env[DOWNLOADS_VARIABLE] ?? '').trim();
  const path = given === '' ? OWN : given;
  const wrong = (what: string): Error =>
    new Error(`The list of downloads at ${path} ${what}.`);
  let whole: unknown;
  try {
    whole = JSON.parse(readFileSync(path, 'utf8'));
  } catch (fault) {
    throw wrong(`cannot be read as JSON: ${(fault as Error).message}`);
  }
  const top = whole as {
    whisper?: { release?: unknown; builds?: unknown };
    models?: unknown;
    defaultModel?: unknown;
    diarizer?: { release?: unknown; builds?: unknown; segmentation?: unknown; embedding?: unknown };
  };
  if (typeof top?.whisper?.release !== 'string') throw wrong('needs whisper.release');
  const builds = top.whisper.builds;
  if (typeof builds !== 'object' || builds === null || Array.isArray(builds)) {
    throw wrong('needs whisper.builds as an object');
  }
  for (const [system, build] of Object.entries(builds)) {
    if (!isDownload(build) || !FORMATS.includes(build['format'] as Format) ||
      typeof build['program'] !== 'string') {
      throw wrong(`has a build for ${system} without url, size, sha256, format and program`);
    }
  }
  if (!Array.isArray(top.models)) throw wrong('needs models as an array');
  const offered: string[] = [];
  for (const model of top.models) {
    const name = (model as Record<string, unknown> | null)?.['name'];
    if (!isDownload(model) || typeof name !== 'string' || !/^[\w.-]+$/.test(name)) {
      throw wrong('has a model without a plain file name, url, size and sha256');
    }
    offered.push(name);
  }
  const defaultModel = top.defaultModel ?? null;
  if (
    defaultModel !== null &&
    (typeof defaultModel !== 'string' || !offered.includes(defaultModel))
  ) {
    throw wrong('has a defaultModel that is not the name of one of its models');
  }
  const diarizer = top.diarizer;
  if (typeof diarizer?.release !== 'string') throw wrong('needs diarizer.release');
  const diarizerBuilds = diarizer.builds;
  if (typeof diarizerBuilds !== 'object' || diarizerBuilds === null ||
    Array.isArray(diarizerBuilds)) {
    throw wrong('needs diarizer.builds as an object');
  }
  for (const [system, build] of Object.entries(diarizerBuilds)) {
    const keep = (build as Record<string, unknown> | null)?.['keep'];
    if (!isArchive(build) || !Array.isArray(keep) || keep.length === 0 ||
      !keep.every((member) => typeof member === 'string' && member !== '')) {
      throw wrong(
        `has a diarizer build for ${system} without url, size, sha256, format and keep`,
      );
    }
  }
  const segmentation = diarizer.segmentation;
  if (!isArchive(segmentation) || typeof segmentation['member'] !== 'string') {
    throw wrong('needs diarizer.segmentation with url, size, sha256, format and member');
  }
  if (!isDownload(diarizer.embedding)) {
    throw wrong('needs diarizer.embedding with url, size and sha256');
  }
  return { ...(whole as Downloads), defaultModel };
}

/** Whether a value is a download packed in a format scribe unpacks. */
function isArchive(given: unknown): given is Download & Record<string, unknown> {
  return isDownload(given) && FORMATS.includes(given['format'] as Format);
}

function isDownload(given: unknown): given is Download & Record<string, unknown> {
  const it = given as Record<string, unknown> | null;
  return (
    typeof it === 'object' && it !== null &&
    typeof it['url'] === 'string' &&
    typeof it['size'] === 'number' && Number.isSafeInteger(it['size']) && it['size'] > 0 &&
    typeof it['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(it['sha256'])
  );
}
