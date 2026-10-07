/**
 * When a Call's Minutes are made: at once when it is stopped and Whisper has
 * read all of its audio, and again each time someone asks.
 *
 * Making them takes a model seconds or minutes, so a request only starts the
 * work: the Call shows `making`, then `made` or `failed` with the sentence
 * that says why. A Call that is Cut gets its Minutes only when someone asks,
 * so a Plugin Server that starts after a crash does not run a model on its
 * own. Once the command's Minutes are kept, `made` hears of it: that is when
 * the Call's Entry goes to Worklog, and never after Minutes saved by hand.
 */
import {
  forgetUnfinishedMinutes,
  keepMinutes,
  setMinutesState,
  viewOf,
  type CallView,
} from './calls.ts';
import type { Command } from './command.ts';
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
  settings: Pick<Settings, 'minutesCommand' | 'minutesTimeoutMs'>,
  busyWith: (id: number) => boolean,
  made: (id: number) => void,
): MinutesMaker {
  within(store, () => forgetUnfinishedMinutes(store));

  const begin = (command: Command, call: CallView): void => {
    within(store, () => setMinutesState(store, call.id, 'making'));
    makeMinutes(command, promptFor(call), settings.minutesTimeoutMs)
      .then((answer) => within(store, () => keepMinutes(store, call.id, answer)))
      .then(() => made(call.id))
      .catch((fault: unknown) => {
        // Whatever went wrong — the command, or keeping what it printed — is
        // the Call's to show. It never takes the Plugin Server down with it.
        try {
          within(store, () => setMinutesState(store, call.id, 'failed', sentenceFor(fault)));
        } catch (worse) {
          process.stderr.write(
            `scribe: the Minutes of Call ${call.id} failed, and so did saying so: ` +
              `${sentenceFor(worse)}\n`,
          );
        }
      });
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
      let command: Command;
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
