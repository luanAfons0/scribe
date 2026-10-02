/**
 * The audio of a Call on its way to Whisper: chunk files in `audio/`, joined
 * into windows of about 30 s per track, each cut at the quietest moment near
 * its end so that no word is cut in two.
 *
 * The page sends 16 kHz mono PCM, 16 bits a sample, one track at a time
 * (ADR-0001). A chunk file is named by its Call, its track and the sample it
 * starts at, counted from the start of the Call in that track's own audio, so
 * what waits for Whisper can be read off the directory alone. No audio is kept
 * longer than it takes Whisper to read it: the chunks of a window are deleted
 * once its WAV file is written, and the WAV file once Whisper has read it.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where audio waits for Whisper, relative to the Plugin directory. */
export const AUDIO = 'audio';

/** The one audio format scribe takes: what the page asks the browser for. */
export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

/** A window is about this long: long enough for Whisper to have context. */
const WINDOW_SAMPLES = 30 * SAMPLE_RATE;
/** A window is cut no sooner than this, at the quietest moment after it. */
const EARLIEST_CUT = 25 * SAMPLE_RATE;
/** Loudness is measured in frames of this many samples: 100 ms. */
const FRAME = SAMPLE_RATE / 10;
/**
 * How loud the loudest 100 ms of audio must be to be speech, per track. Below
 * it, audio is not given to Whisper, because Whisper makes words up out of
 * silence. The tab carries the call as the browser plays it: about -44 dBFS
 * is well under speech and well over a quiet line. The mic carries the room
 * as well — breath, keys, fans — under noise suppression and gain control
 * that lift speech well above it, so it is held to about -36 dBFS.
 */
const SPEECH_RMS: Readonly<Record<Track, number>> = { mic: 500, tab: 200 };

/** Which track a chunk is from: the mic (`Eu`) or the shared tab (`Outros`). */
export type Track = 'mic' | 'tab';

/** One window, written and ready for Whisper. */
export type Window = {
  readonly callId: number;
  readonly track: Track;
  /** The WAV file Whisper reads. */
  readonly path: string;
  /** Where the window starts, in milliseconds from the start of the Call. */
  readonly startMs: number;
};

/** A chunk file's name, sorted by the sample it starts at when read back. */
function chunkName(callId: number, track: Track, sample: number): string {
  return `${callId}-${track}-${String(sample).padStart(12, '0')}.pcm`;
}

/** Keep one chunk of a Call's track, starting at this sample. */
export function keepChunk(callId: number, track: Track, sample: number, pcm: Buffer): void {
  mkdirSync(AUDIO, { recursive: true });
  writeFileSync(join(AUDIO, chunkName(callId, track, sample)), pcm);
}

/** The chunk files of one Call's track that wait for a window, oldest first. */
function waiting(callId: number, track: Track): readonly { name: string; sample: number }[] {
  const prefix = `${callId}-${track}-`;
  return files()
    .filter((name) => name.startsWith(prefix) && name.endsWith('.pcm'))
    .sort()
    .map((name) => ({ name, sample: Number(name.slice(prefix.length, -'.pcm'.length)) }));
}

function files(): readonly string[] {
  try {
    return readdirSync(AUDIO);
  } catch {
    return [];
  }
}

/**
 * Join the chunks of one Call's track into a window, when there is enough for
 * one, or, when the Call is over, whatever is left. Answers the window, or
 * null when there is none yet or when all of it was silence.
 */
export function takeWindow(callId: number, track: Track, last: boolean): Window | null {
  const chunks = waiting(callId, track);
  const first = chunks[0];
  if (first === undefined) return null;
  const pcm = Buffer.concat(chunks.map((chunk) => readFileSync(join(AUDIO, chunk.name))));
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / BYTES_PER_SAMPLE);
  if (!last && samples.length < WINDOW_SAMPLES) return null;

  const cut = last ? samples.length : quietestAfter(samples, EARLIEST_CUT);
  const taken = samples.subarray(0, cut);
  const rest = samples.subarray(cut);

  let window: Window | null = null;
  if (loudest(taken) >= SPEECH_RMS[track]) {
    const path = join(AUDIO, `${callId}-${track}-${String(first.sample).padStart(12, '0')}.wav`);
    writeFileSync(path, wav(taken));
    window = { callId, track, path, startMs: Math.round((first.sample / SAMPLE_RATE) * 1000) };
  }
  // The rest is written before the chunks go, so a crash in between leaves
  // audio twice rather than none.
  if (rest.length > 0) {
    keepChunk(callId, track, first.sample + cut, Buffer.from(rest.slice().buffer));
  }
  for (const chunk of chunks) rmSync(join(AUDIO, chunk.name), { force: true });
  return window;
}

/** The sample the quietest frame from `from` to the end starts at. */
function quietestAfter(samples: Int16Array, from: number): number {
  let best = samples.length;
  let quietest = Infinity;
  for (let start = from; start + FRAME <= samples.length; start += FRAME) {
    const level = rms(samples.subarray(start, start + FRAME));
    if (level < quietest) {
      quietest = level;
      best = start;
    }
  }
  return best;
}

/** How loud the loudest 100 ms of this audio is. */
function loudest(samples: Int16Array): number {
  let peak = 0;
  for (let start = 0; start < samples.length; start += FRAME) {
    peak = Math.max(peak, rms(samples.subarray(start, start + FRAME)));
  }
  return peak;
}

function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/** This audio as a WAV file: the one input whisper.cpp reads with no ffmpeg. */
function wav(samples: Int16Array): Buffer {
  const data = samples.length * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, data)]);
}

/**
 * Whether a stretch of a window, in milliseconds from its start, holds a
 * moment loud enough to be speech on its track. Whisper writes words over the
 * quiet start of a window that has speech later in it; a line with nothing
 * loud under it is one of those.
 */
export function spokenBetween(window: Window, startMs: number, endMs: number): boolean {
  // Copied, so the samples start on an even byte whatever buffer the read used.
  const data = Uint8Array.prototype.slice.call(readFileSync(window.path), 44);
  const all = new Int16Array(data.buffer, 0, Math.floor(data.length / BYTES_PER_SAMPLE));
  const from = Math.max(0, Math.floor((startMs / 1000) * SAMPLE_RATE));
  const to = Math.min(all.length, Math.ceil((endMs / 1000) * SAMPLE_RATE));
  return loudest(all.subarray(from, Math.max(from, to))) >= SPEECH_RMS[window.track];
}

/** Delete one file of audio, once Whisper has read it or nobody will. */
export function forget(path: string): void {
  rmSync(path, { force: true });
}

/** Delete every file of audio a Call still has, of either track. */
export function forgetCall(callId: number): void {
  for (const name of files()) {
    if (name.startsWith(`${callId}-`)) rmSync(join(AUDIO, name), { force: true });
  }
}

/** The Calls that still have chunks waiting, from a run that did not finish. */
export function callsWithChunks(): readonly number[] {
  const ids = files()
    .filter((name) => name.endsWith('.pcm'))
    .map((name) => Number(name.split('-')[0]));
  return [...new Set(ids)].filter(Number.isSafeInteger);
}

/** The windows a run that did not finish wrote and never gave to Whisper. */
export function leftoverWindows(): readonly Window[] {
  const found: Window[] = [];
  for (const name of files()) {
    const parts = /^(\d+)-(mic|tab)-(\d+)\.wav$/.exec(name);
    if (parts === null) continue;
    found.push({
      callId: Number(parts[1]),
      track: parts[2] as Track,
      path: join(AUDIO, name),
      startMs: Math.round((Number(parts[3]) / SAMPLE_RATE) * 1000),
    });
  }
  return found;
}
