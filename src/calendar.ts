/**
 * The operator's calendar, read from its secret iCal address (ADR-0006): now,
 * every few minutes, and again when the address is saved.
 *
 * The Events are held in memory and never in `scribe.db`: the calendar is
 * the record of them, and a new read replaces them whole. What the last read
 * gave is one result, a count or the sentence of its fault, for the Settings
 * view to show. A calendar whose name is not its owner's address gives
 * declined Events too, and the read says so in one sentence. A read that
 * fails sends no Notice and ends nothing: scribe records as it did before
 * there were Events.
 *
 * The address is a secret. No sentence here names it, not even a fault's:
 * the network's own message may carry the address, so only its code is said.
 */
import type { CallEvent } from './calls.ts';
import { eventsBetween, readFeed, type Event, type Series } from './events.ts';
import type { Choices, Settings } from './settings.ts';

/** A feed that sends nothing for this long is not going to answer. */
const READ_WAIT_MS = 30_000;

/** What the last read of the calendar gave, as `get_settings` tells it. */
export type ReadView = {
  /** When it was read, as an ISO 8601 instant. */
  readonly at: string;
  /** How many Events the calendar holds, or null when the read failed. */
  readonly count: number | null;
  /** Why the read failed, as one sentence with no address in it, or null. */
  readonly problem: string | null;
  /** Why declined Events are not skipped, as one sentence, or null when they are. */
  readonly declined: string | null;
};

/** What the read says when the calendar's name gives no owner to skip the declines of. */
const DECLINED_SHOWN =
  "Declined Events show too, because the calendar's name is not an address, so scribe " +
  'cannot tell whose calendar it is.';

/** The calendar, in one running Plugin Server. */
export type Calendar = {
  /** Every Event that has not ended at `from` and starts before `to`, by start. */
  between(from: number, to: number): readonly Event[];
  /** What the last read gave, or null when there is no address or no read yet. */
  lastRead(): ReadView | null;
  /** The address may have changed: forget what was read, and read it now. */
  reread(): void;
};

/** Read the calendar the settings name, now and every `calendarReadMs`. */
export function calendarFor(
  choices: Pick<Choices, 'calendarUrl'>,
  settings: Pick<Settings, 'calendarReadMs'>,
): Calendar {
  let series: readonly Series[] = [];
  let last: ReadView | null = null;
  /** The address the Events came from, so a new one never shows the old one's. */
  let readFrom: string | null = null;
  /** Which read is the current one: an answer to an older read is dropped. */
  let generation = 0;
  let reading = false;

  const read = async (): Promise<void> => {
    const address = choices.calendarUrl();
    if (address !== readFrom) {
      series = [];
      last = null;
      readFrom = address;
    }
    if (address === null) return;
    const mine = (generation += 1);
    reading = true;
    let result: { series: readonly Series[]; owner: string | null } | { problem: string };
    try {
      result = readFeed(await fetchFeed(address));
    } catch (fault) {
      result = { problem: problemOf(fault) };
    }
    if (mine !== generation) return;
    reading = false;
    const at = new Date().toISOString();
    if ('series' in result) {
      series = result.series;
      const declined = result.owner === null ? DECLINED_SHOWN : null;
      last = { at, count: series.length, problem: null, declined };
    } else {
      // The Events of the last good read stay: a network that drops for a
      // moment does not lose the next Event.
      last = { at, count: null, problem: result.problem, declined: null };
    }
  };

  void read();
  setInterval(() => {
    if (!reading) void read();
  }, settings.calendarReadMs).unref();

  return {
    between: (from, to) => eventsBetween(series, from, to),
    lastRead: () => last,
    reread: () => {
      generation += 1;
      reading = false;
      void read();
    },
  };
}

/** A Call started this long before an Event, or later until it ends, is for it. */
const EVENT_REACH_MS = 5 * 60_000;

/**
 * The Event a Call started at `at` is for: one that starts within five minutes
 * or has started and not ended. Of two, the one that started last wins, as
 * the operator leaves the older one for it.
 */
export function eventAt(calendar: Pick<Calendar, 'between'>, at: number): CallEvent | null {
  const inReach = calendar.between(at, at + EVENT_REACH_MS);
  const last = inReach.reduce<Event | null>(
    (latest, event) => (latest === null || event.start > latest.start ? event : latest),
    null,
  );
  return last === null ? null : { name: last.name, start: new Date(last.start).toISOString() };
}

/** The feed's text, or a fault that says why it could not be read. */
async function fetchFeed(address: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(address, { signal: AbortSignal.timeout(READ_WAIT_MS) });
  } catch (fault) {
    throw unanswered(fault);
  }
  if (response.status === 404 || response.status === 403 || response.status === 401) {
    throw new Error(
      `The calendar's secret address answered ${response.status}: it was reset, or a ` +
        'Workspace admin turned it off. Copy "Secret address in iCal format" again from ' +
        "your calendar's settings in Google Calendar.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `The calendar's secret address answered ${response.status}. scribe reads it again ` +
        'in a few minutes.',
    );
  }
  try {
    return await response.text();
  } catch (fault) {
    throw unanswered(fault);
  }
}

/** A read that got no whole answer, with only the network's code kept. */
function unanswered(fault: unknown): Error {
  const named = fault as { name?: unknown; cause?: { code?: unknown } } | null;
  const code = named?.cause?.code;
  const why =
    named?.name === 'TimeoutError'
      ? ` in ${READ_WAIT_MS / 1000} s`
      : typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
        ? ` (${code})`
        : '';
  return new Error(
    `The calendar's secret address did not answer${why}. scribe reads it again in a few ` +
      'minutes.',
  );
}

/** The sentence of a fault, which never carries the address. */
function problemOf(fault: unknown): string {
  const sentence = fault instanceof Error ? fault.message : '';
  if (sentence.startsWith("The calendar's secret address")) return sentence;
  return (
    "The calendar's secret address did not answer with an iCal calendar. Copy " +
    '"Secret address in iCal format" again from your calendar\'s settings in Google Calendar.'
  );
}
