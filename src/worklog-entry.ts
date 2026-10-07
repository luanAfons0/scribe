/**
 * A Call's Entry in Worklog: once the command has made the Minutes, the
 * Topics go to the Worklog Plugin over the Tool Bus, as one `Done` Entry in
 * its current Cycle (FirstMate ADR-0009). Making the Minutes again changes
 * that Entry's title and body, and leaves its Status to the operator.
 *
 * Only the title, the times and the Topics leave scribe. The Jottings, the
 * Transcript and the audio never do. Sending is the last thing that happens
 * to the Minutes and can never undo them: whatever goes wrong is one sentence
 * on the Call, and the Minutes stay `made`.
 */
import { callPlugin, type BusResult } from './bus.ts';
import { keepEntry, setEntryError, viewOf, type CallView } from './calls.ts';
import { sentenceFor } from './mcp.ts';
import type { Choices, Settings } from './settings.ts';
import { within, type Store } from './store.ts';

/** What sends a Call's Entry to Worklog. */
export type EntrySender = {
  /** The command has just made this Call's Minutes: send its Entry. */
  made(id: number): void;
};

/** The EntrySender, over one Store, to the Worklog Plugin the settings name. */
export function entrySenderFor(
  store: Store,
  settings: Pick<Settings, 'worklogWaitMs'>,
  choices: Pick<Choices, 'worklogPlugin'>,
): EntrySender {
  const failed = (id: number, sentence: string): void => {
    try {
      within(store, () => setEntryError(store, id, sentence));
    } catch {
      // The Call was deleted while Worklog answered. There is nothing to show.
    }
  };

  /**
   * Change the Entry the Call already has, so Worklog holds one per Call; make
   * one when it has none, or when the one it had was deleted in Worklog.
   */
  const write = async (plugin: string, call: CallView, topics: string): Promise<BusResult> => {
    const wait = settings.worklogWaitMs;
    const title = titleOf(call);
    if (call.entryId !== null) {
      const changed = await callPlugin(
        plugin,
        'update_entry',
        { id: call.entryId, title, body: topics },
        wait,
      );
      if (changed.kind !== 'refused' || !GONE.test(changed.said)) return changed;
    }
    return callPlugin(plugin, 'create_entry', { title, body: topics, status: 'Done' }, wait);
  };

  const send = async (plugin: string, call: CallView): Promise<void> => {
    if (call.topics === null) {
      failed(
        call.id,
        'The Minutes command wrote no Topics, so no Entry went to Worklog. ' +
          'Make the Minutes again.',
      );
      return;
    }
    const sent = await write(plugin, call, call.topics);
    if (sent.kind === 'timed-out') {
      failed(call.id, `${plugin} did not answer in ${settings.worklogWaitMs} ms. ${AGAIN}`);
      return;
    }
    if (sent.kind === 'refused') {
      failed(call.id, refusal(plugin, sent.said));
      return;
    }
    const entryId = idOf(sent.result);
    if (entryId === null) {
      failed(call.id, `${plugin} answered with no Entry id. ${AGAIN}`);
      return;
    }
    try {
      within(store, () => keepEntry(store, call.id, entryId));
    } catch {
      // The Call was deleted while Worklog answered. Its Entry stays there.
    }
  };

  return {
    made(id) {
      const plugin = choices.worklogPlugin();
      if (plugin === null) return;
      let call: CallView;
      try {
        call = viewOf(store, id, false);
      } catch {
        return; // The Call was deleted as its Minutes were kept.
      }
      send(plugin, call).catch((fault: unknown) =>
        failed(id, `The Entry could not be sent to ${plugin}: ${sentenceFor(fault)}`),
      );
    },
  };
}

/**
 * What Worklog says when an Entry it was asked to change is not there: the
 * operator deleted it. Worklog has no code of its own for that, so its
 * sentence is the signal, and any other refusal leaves the Entry id alone.
 */
const GONE = /^No Entry has the id /;

/** What the operator does about a failed send. */
const AGAIN = 'Make the Minutes again to send it.';

/**
 * The Entry's title: `Reunião 14:00 - 15:10: <title>`, in this machine's time.
 * A Call with no title has its times alone, as the moment it started stands
 * in for a title everywhere else.
 */
function titleOf(call: CallView): string {
  const ended = call.endedAt ?? call.startedAt;
  const times = `Reunião ${clockOf(call.startedAt)} - ${clockOf(ended)}`;
  return call.title === null ? times : `${times}: ${call.title.replace(/\s+/g, ' ')}`;
}

function clockOf(iso: string): string {
  const moment = new Date(iso);
  const hours = String(moment.getHours()).padStart(2, '0');
  return `${hours}:${String(moment.getMinutes()).padStart(2, '0')}`;
}

/** The Entry id out of what Worklog's create_entry answered, or null. */
function idOf(result: unknown): number | null {
  const entry = (result as { structuredContent?: { id?: unknown } } | null)?.structuredContent;
  const id = entry?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
}

/** A refusal from the Host or from Worklog, as a sentence the operator acts on. */
function refusal(plugin: string, said: string): string {
  const grant = said.includes('holds no Grant')
    ? ` Run "firstmate grant scribe ${plugin}", then make the Minutes again.`
    : ` ${AGAIN}`;
  return `${plugin} did not take the Entry: ${said}${grant}`;
}
