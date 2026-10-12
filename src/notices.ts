/**
 * A Notice before each Event: one word through the Host, a minute before the
 * Event starts, so the operator knows with the Plugin Page closed (FirstMate
 * ADR-0014). A click on it opens the Calls list at the Event's banner.
 *
 * Each Event gets one Notice, once: an Event is named by its UID and its
 * start, and a new read of the calendar does not give it a second one. The
 * calendar never sends a Notice of its own: a read that failed is said on the
 * Plugin Page, where it is fixed.
 *
 * The Host takes one Notice from a Plugin every 5 s and refuses the rest, so
 * the Notices wait on a queue and go one after another. A refusal for "too
 * soon", as after a restart of this Plugin Server, puts the Notice back at the
 * front. Any other refusal drops it, said once on stderr. The Host never cuts
 * a text that is too long, it refuses it, so scribe cuts its own.
 */
import { askHost } from './bus.ts';
import type { Calendar } from './calendar.ts';
import type { Event } from './events.ts';
import type { Settings } from './settings.ts';

/** The method a Notice is sent with. */
const NOTICE_METHOD = 'firstmate/notice';

/** The longest title the Host takes, in characters. */
const TITLE_LIMIT = 64;

/** How long scribe waits after one Notice before the next: the Host's own gap. */
const NOTICE_GAP_MS = 5_000;

/** The Host answers a Notice at once; this much is a Host that is not there. */
const ANSWER_WAIT_MS = 10_000;

/** How often scribe looks for an Event whose Notice is due. */
const CHECK_MS = 1_000;

/** Where a click on the Notice opens, under `/p/scribe/`: the Calls list's banner. */
const NOTICE_PATH = '#upcoming';

/** How the Host's refusal for "too soon" starts. Its numbers change; these words do not. */
const TOO_SOON = /^A Plugin may send one Notice every \d+(\.\d+)? s\. /;

/** What marks a name scribe cut. */
const SHORTENED = '…';

/** One Notice, as scribe asks the Host to show it. */
type Notice = {
  readonly title: string;
  readonly body: string;
  readonly path: string;
};

/** Send a Notice the lead before each Event the calendar holds, from now on. */
export function noticesFor(
  calendar: Pick<Calendar, 'between'>,
  settings: Pick<Settings, 'noticeLeadMs'>,
): void {
  const send = openQueue();
  const lead = settings.noticeLeadMs;
  /** The Events given a Notice, by UID and start, until they start. */
  const given = new Map<string, number>();

  const check = (): void => {
    const now = Date.now();
    for (const [key, start] of given) if (start <= now) given.delete(key);
    for (const event of calendar.between(now, now + lead + 1)) {
      if (event.start <= now || event.start - lead > now) continue;
      const key = `${event.uid} ${event.start}`;
      if (given.has(key)) continue;
      given.set(key, event.start);
      send(noticeFor(event, now));
    }
  };
  setInterval(check, Math.max(1, Math.min(CHECK_MS, lead))).unref();
}

/** The Notice of an Event that starts soon: `Sprint review in 1 min`, and when. */
function noticeFor(event: Event, now: number): Notice {
  const minutes = Math.max(1, Math.round((event.start - now) / 60_000));
  const after = ` in ${minutes} min`;
  const name = oneLine(event.name) || 'An Event';
  return {
    title: `${shorten(name, TITLE_LIMIT - [...after].length)}${after}`,
    body: `Starts at ${timeOfDay(event.start)} on Google Meet. To record it, start a Call in scribe.`,
    path: NOTICE_PATH,
  };
}

/** The queue: hand it a Notice, and it goes when the Host takes the next one. */
function openQueue(): (notice: Notice) => void {
  const waiting: Notice[] = [];
  // True while a Notice is with the Host, and through the gap after it.
  let busy = false;

  const next = (): void => {
    if (busy) return;
    const notice = waiting.shift();
    if (notice === undefined) return;
    busy = true;
    void askHost(NOTICE_METHOD, notice, ANSWER_WAIT_MS).then((answer) => {
      if (answer.kind === 'refused' && TOO_SOON.test(answer.said)) waiting.unshift(notice);
      else if (answer.kind === 'refused') dropped(notice, answer.said);
      else if (answer.kind === 'timed-out') dropped(notice, 'the Host did not answer.');
      // The gap holds no Plugin Server up: one that is asked to stop stops.
      setTimeout(() => {
        busy = false;
        next();
      }, NOTICE_GAP_MS).unref();
    });
  };

  return (notice) => {
    waiting.push(notice);
    next();
  };
}

/** A Notice the Host would not take is said once, and not sent again. */
function dropped(notice: Notice, why: string): void {
  process.stderr.write(`scribe: the Notice "${notice.title}" is dropped: ${why}\n`);
}

/** A time of day as the operator's clock reads it: 14:05. */
function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** A text on one line, as a Notice shows it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A text cut to at most this many characters, with a mark that says so. It
 * counts and cuts by code point, as the Host counts, so a letter outside the
 * Basic Multilingual Plane is never cut in half.
 */
function shorten(text: string, most: number): string {
  const points = [...text];
  if (points.length <= most) return text;
  return `${points.slice(0, most - 1).join('').trimEnd()}${SHORTENED}`;
}
