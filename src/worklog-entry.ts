/**
 * A Call's Entry in Worklog: when the operator presses Send to Worklog, the
 * Topics go to the Worklog Plugin over the Tool Bus, as one `Done` Entry in
 * its current Cycle (FirstMate ADR-0009). Sending again changes that Entry's
 * title and body, and leaves its Status to the operator.
 *
 * Nothing goes on its own: making the Minutes sends nothing, so a test Call
 * or a private one stays out of Worklog until the operator reads its Topics
 * and sends them. Only the title, the times and the Topics leave scribe. The
 * Jottings, the Transcript and the audio never do. A send that goes wrong is
 * one sentence on the Call, which stays as it was.
 */
import { callPlugin, type BusResult } from './bus.ts';
import { keepEntry, setEntryError, viewOf, type CallView } from './calls.ts';
import { badInput, sentenceFor } from './mcp.ts';
import type { Choices, Settings } from './settings.ts';
import { within, type Store } from './store.ts';

/** What sends a Call's Entry to Worklog. */
export type EntrySender = {
  /**
   * Start sending this Call's Topics, or refuse with a sentence. It answers
   * at once, as the Minutes do: the Call shows `sendingToWorklog`, then
   * `sentToWorklogAt` or `entryError`.
   */
  send(id: number): void;
  /** Whether this Call's Topics are on their way to Worklog now. */
  sending(id: number): boolean;
};

/** The EntrySender, over one Store, to the Worklog Plugin the settings name. */
export function entrySenderFor(
  store: Store,
  settings: Pick<Settings, 'worklogWaitMs'>,
  choices: Pick<Choices, 'worklogPlugin'>,
): EntrySender {
  /** The Calls whose Topics are on their way, so one Call never makes two. */
  const running = new Set<number>();

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

  const deliver = async (plugin: string, call: CallView, topics: string): Promise<void> => {
    const sent = await write(plugin, call, topics);
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
    send(id) {
      const call = viewOf(store, id, false);
      if (call.state === 'recording') {
        throw badInput(
          `Call ${id} is still recording. Stop it, and send its Topics once its Minutes are made.`,
        );
      }
      if (call.minutesState === 'making') {
        throw badInput(
          `The Minutes of Call ${id} are being made. Send its Topics when they are done.`,
        );
      }
      if (call.topics === null) {
        throw badInput(
          `Call ${id} has no Topics to send. Make its Minutes, and the command writes them.`,
        );
      }
      const plugin = choices.worklogPlugin();
      if (plugin === null) {
        throw badInput(
          'No Worklog Plugin is set, so the Topics have nowhere to go. Set the Worklog ' +
            'Plugin in Settings, as worklogPlugin, or set SCRIBE_WORKLOG_PLUGIN.',
        );
      }
      if (running.has(id)) {
        throw badInput(`The Topics of Call ${id} are being sent to Worklog already.`);
      }
      running.add(id);
      deliver(plugin, call, call.topics)
        .catch((fault: unknown) =>
          failed(id, `The Entry could not be sent to ${plugin}: ${sentenceFor(fault)}`),
        )
        .finally(() => running.delete(id));
    },

    sending: (id) => running.has(id),
  };
}

/**
 * What Worklog says when an Entry it was asked to change is not there: the
 * operator deleted it. Worklog has no code of its own for that, so its
 * sentence is the signal, and any other refusal leaves the Entry id alone.
 */
const GONE = /^No Entry has the id /;

/** What the operator does about a failed send. */
const AGAIN = 'Send it again.';

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
    ? ` Run "firstmate grant scribe ${plugin}", then send it again.`
    : ` ${AGAIN}`;
  return `${plugin} did not take the Entry: ${said}${grant}`;
}
