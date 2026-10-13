/**
 * Audio for tests, as the page sends it: 16 kHz mono 16-bit PCM, as base64.
 *
 * The fixture whisper prints one line for each run of loud audio, named by
 * the loudest sample in it, so a test says what it wants heard by where it
 * puts a tone and how loud it makes it.
 */
import type { Started } from './plugin.ts';
import { structureOf } from './plugin.ts';

/** The sample rate scribe takes. */
export const RATE = 16_000;

/** One stretch of audio: silence, or a tone at this level, for this long. */
export type Stretch = { readonly seconds: number; readonly level?: number };

/** These stretches, one after another, as PCM. */
export function pcm(stretches: readonly Stretch[]): Buffer {
  const parts = stretches.map(({ seconds, level = 0 }) => {
    const samples = new Int16Array(Math.round(seconds * RATE));
    // A square wave: loud all through, so the fixture hears every frame of it.
    for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? level : -level;
    return Buffer.from(samples.buffer);
  });
  return Buffer.concat(parts);
}

/** PCM cut into chunks of five seconds, the way the page sends it. */
export function chunks(audio: Buffer, seconds = 5): readonly string[] {
  const size = seconds * RATE * 2;
  const cut: string[] = [];
  for (let at = 0; at < audio.length; at += size) {
    cut.push(audio.subarray(at, at + size).toString('base64'));
  }
  return cut;
}

/** Send all of one track's audio to a Call, chunk by chunk, from `from`. */
export async function send(
  plugin: Started,
  id: number,
  track: 'mic' | 'tab',
  audio: Buffer,
  from = 0,
): Promise<number> {
  let seq = from;
  for (const pcm of chunks(audio)) {
    const answer = await plugin.call('append_audio', { id, track, seq, pcm });
    if (answer.error !== undefined) throw new Error(answer.error.message);
    seq += 1;
  }
  return seq;
}

/** One line of a Transcript, as get_call answers it. */
export type Line = {
  readonly speaker: 'Você' | 'Outros';
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
};

/** One Call, whole, as get_call answers it. */
export type Call = {
  readonly id: number;
  readonly title: string | null;
  readonly state: 'recording' | 'ended' | 'cut';
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly sentToWorklogAt: string | null;
  readonly jottings: string;
  readonly transcript: readonly Line[];
  readonly transcribing: boolean;
  readonly minutes: string | null;
  readonly minutesState: 'none' | 'making' | 'made' | 'failed';
  readonly minutesError: string | null;
  readonly topics: string | null;
  readonly entryId: number | null;
  readonly entryError: string | null;
  readonly sendingToWorklog: boolean;
  readonly topicsChangedSinceSent: boolean;
};

/** One Call, by id. */
export async function getCall(plugin: Started, id: number): Promise<Call> {
  return structureOf<{ call: Call }>(await plugin.call('get_call', { id })).call;
}

/** Start a Call, and hand back its id. */
export async function startCall(plugin: Started): Promise<number> {
  return structureOf<{ call: { id: number } }>(await plugin.call('start_call')).call.id;
}

/** Wait until this is true of the Call, and hand the Call back. */
export async function until(
  plugin: Started,
  id: number,
  wanted: (call: Call) => boolean,
  within = 10_000,
): Promise<Call> {
  const started = Date.now();
  for (;;) {
    const call = await getCall(plugin, id);
    if (wanted(call)) return call;
    if (Date.now() - started > within) {
      throw new Error(`the Call never got there: ${JSON.stringify(call)}\n${plugin.output()}`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** Wait until Whisper has read all of a Call's audio. */
export function transcribed(plugin: Started, id: number): Promise<Call> {
  return until(plugin, id, (call) => call.state !== 'recording' && !call.transcribing);
}

/** A Transcript as short sentences a test can compare. */
export function said(call: Call): readonly string[] {
  return call.transcript.map((line) => `${line.startMs} ${line.speaker}: ${line.text}`);
}
