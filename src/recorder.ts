/**
 * The Call that records now: where each of its tracks has got to, and what is
 * done with each chunk of audio the page sends.
 *
 * The page sends each track's chunks one after another, numbered from 0, so a
 * chunk sent twice — a retry after an answer that was lost — is kept once, and
 * a chunk that skips ahead is refused rather than leave a hole in the audio. A
 * track's place is counted in samples, so a line's moment comes from the audio
 * itself and never from a clock.
 *
 * A Call ends without Stop when its page goes away: the tab closed, the
 * browser quit, the machine slept. Then no audio comes, and after
 * `SCRIBE_CUT_AFTER_MS` of none the Call is Cut, with what Whisper has heard
 * so far. A Plugin Server that starts and finds a Call still recording has no
 * page sending to it — the page was sending to the one that went away — so
 * that Call is Cut at once, and the audio left behind goes to Whisper.
 */
import {
  callsWithChunks,
  keepChunk,
  leftoverWindows,
  SAMPLE_RATE,
  takeWindow,
  type Track,
} from './audio.ts';
import { endCall, recordingCall, startCall, type CallSummary } from './calls.ts';
import { badInput } from './mcp.ts';
import type { Settings } from './settings.ts';
import type { Transcriber } from './transcriber.ts';
import { within, type Store } from './store.ts';

/** The tracks a Call has, in the order a flush takes them. */
export const TRACKS: readonly Track[] = ['mic', 'tab'];

/** The most audio one chunk may carry: 30 s, six times what the page sends. */
const MOST_BYTES = 30 * SAMPLE_RATE * 2;

/** What append_audio answers. */
export type Appended = {
  readonly callId: number;
  readonly track: Track;
  readonly seq: number;
  /** False when this chunk had been kept already. */
  readonly kept: boolean;
};

/** The one Call that records, and what is done with its audio. */
export type Recorder = {
  start(): CallSummary;
  append(callId: number, track: Track, seq: number, pcm: Buffer): Appended;
  stop(id: number | null): CallSummary;
};

type Live = {
  readonly callId: number;
  readonly next: Record<Track, number>;
  readonly sample: Record<Track, number>;
  /** When the last chunk came, on this process's own clock. */
  heard: number;
};

/** How often a recording Call is checked for audio that stopped coming. */
const CHECK_MS = 1000;

/**
 * The Recorder, over one Store, giving its windows to one Transcriber. It
 * Cuts a Call it finds still recording before it serves anything.
 */
export function recorderFor(
  store: Store,
  transcriber: Transcriber,
  settings: Pick<Settings, 'cutAfterMs'>,
): Recorder {
  let live: Live | null = null;

  /** Give Whisper every window a track has ready, or all it has at the end. */
  const flush = (callId: number, track: Track, last: boolean): void => {
    for (;;) {
      const window = takeWindow(callId, track, last);
      if (window !== null) transcriber.give(window);
      if (window === null || last) return;
    }
  };

  const cut = (callId: number): void => {
    within(store, () => endCall(store, callId, 'cut'));
    for (const track of TRACKS) flush(callId, track, true);
  };

  // What the last run left: a Call that records with nobody sending, windows
  // written and never read, and chunks never joined into a window.
  const orphan = recordingCall(store);
  if (orphan !== null) within(store, () => endCall(store, orphan.id, 'cut'));
  for (const window of leftoverWindows()) transcriber.give(window);
  for (const callId of callsWithChunks()) {
    for (const track of TRACKS) flush(callId, track, true);
  }

  // The check never holds the process up: it ends when the Host closes stdin.
  setInterval(() => {
    if (live !== null && Date.now() - live.heard > settings.cutAfterMs) {
      const callId = live.callId;
      live = null;
      cut(callId);
    }
  }, Math.min(CHECK_MS, settings.cutAfterMs)).unref();

  return {
    start() {
      const call = within(store, () => startCall(store));
      live = {
        callId: call.id,
        next: { mic: 0, tab: 0 },
        sample: { mic: 0, tab: 0 },
        heard: Date.now(),
      };
      return call;
    },

    append(callId, track, seq, pcm) {
      if (live === null || live.callId !== callId) {
        throw badInput(`Call ${callId} is not recording, so its audio is not kept.`);
      }
      if (pcm.length % 2 !== 0 || pcm.length > MOST_BYTES) {
        throw badInput(
          'append_audio takes "pcm" as base64 of 16 kHz mono 16-bit PCM, at most 30 s of it.',
        );
      }
      live.heard = Date.now();
      const expected = live.next[track];
      if (seq < expected) return { callId, track, seq, kept: false };
      if (seq > expected) {
        throw badInput(
          `append_audio expected chunk ${expected} of the ${track} track of Call ${callId}, ` +
            `and was given chunk ${seq}.`,
        );
      }
      keepChunk(callId, track, live.sample[track], pcm);
      live.sample[track] += pcm.length / 2;
      live.next[track] = seq + 1;
      flush(callId, track, false);
      return { callId, track, seq, kept: true };
    },

    stop(id) {
      const running = recordingCall(store);
      if (running === null) throw badInput('No Call is recording, so there is none to stop.');
      if (id !== null && id !== running.id) {
        throw badInput(`Call ${id} is not recording; Call ${running.id} is.`);
      }
      const ended = within(store, () => endCall(store, running.id, 'ended'));
      live = null;
      for (const track of TRACKS) flush(ended.id, track, true);
      return ended;
    },
  };
}
