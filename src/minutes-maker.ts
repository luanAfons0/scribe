/**
 * When a Call's Minutes are made: at once when it is stopped and Whisper has
 * read all of its audio, and again each time someone asks.
 *
 * Making them takes a model seconds or minutes, so a request only starts the
 * work: the Call shows `making`, then `made` or `failed` with the sentence
 * that says why. A Call that is Cut gets its Minutes only when someone asks,
 * so a Plugin Server that starts after a crash does not run a model on its
 * own.
 */
import {
  forgetUnfinishedMinutes,
  keepMinutes,
  setMinutesState,
  viewOf,
  type CallView,
} from './calls.ts';
import { badInput, sentenceFor } from './mcp.ts';
import { checkCommand, makeMinutes, promptFor } from './minutes.ts';
import type { Settings } from './settings.ts';
import { within, type Store } from './store.ts';

/** What starts the Minutes of a Call. */
export type MinutesMaker = {
  /** Start making the Minutes of a Call, or refuse with a sentence. */
  make(id: number): CallView;
  /** Whisper has read all of a Call's audio. */
  heard(id: number): void;
};

/** The MinutesMaker, over one Store, asking whether Whisper is done. */
export function minutesMakerFor(
  store: Store,
  settings: Pick<Settings, 'minutesCommand'>,
  busyWith: (id: number) => boolean,
): MinutesMaker {
  within(store, () => forgetUnfinishedMinutes(store));

  const begin = (command: string, call: CallView): void => {
    within(store, () => setMinutesState(store, call.id, 'making'));
    makeMinutes(command, promptFor(call)).then(
      (made) => within(store, () => keepMinutes(store, call.id, made.minutes, made.title)),
      (fault) => within(store, () => setMinutesState(store, call.id, 'failed', sentenceFor(fault))),
    );
  };

  return {
    make(id) {
      const call = viewOf(store, id, busyWith(id));
      if (call.state === 'recording') {
        throw badInput(`Call ${id} is still recording. Stop it, and its Minutes are made.`);
      }
      if (call.transcribing) {
        throw badInput(
          `Whisper is still reading the audio of Call ${id}. Make its Minutes when it is done.`,
        );
      }
      if (call.minutesState === 'making') {
        throw badInput(`The Minutes of Call ${id} are being made already.`);
      }
      begin(checkCommand(settings.minutesCommand), call);
      return viewOf(store, id, false);
    },

    heard(id) {
      let call: CallView;
      try {
        call = viewOf(store, id, false);
      } catch {
        return; // The Call was deleted while Whisper read it.
      }
      if (call.state !== 'ended' || call.minutesState !== 'none') return;
      if (settings.minutesCommand === null) return;
      let command: string;
      try {
        command = checkCommand(settings.minutesCommand);
      } catch (fault) {
        within(store, () => setMinutesState(store, id, 'failed', sentenceFor(fault)));
        return;
      }
      begin(command, call);
    },
  };
}
