/**
 * Which entries of the operator's calendar are Events, and when each happens.
 *
 * An Event has a Google Meet link and starts at a set time. The link is the
 * conference data Google writes, `X-GOOGLE-CONFERENCE`, or else the first
 * `https://meet.google.com/…` in the description or the location (ADR-0006).
 * An entry is not an Event when it is all day, when it is cancelled, or when
 * the operator declined it: the operator is the calendar's owner, whose
 * address Google writes as the calendar's name.
 *
 * The feed is read into Series, and a Series gives the Events that happen in
 * a span of time: once, at its own DTSTART, or at each time of its RRULE.
 * Recurring rules expand here, in `occurrencesOf`, and nowhere else.
 *
 * Google writes a time of a recurring entry that was moved or cancelled as
 * one more VEVENT with the same UID and a RECURRENCE-ID: the time it
 * replaces. That VEVENT is a Series of its own, which happens once, and the
 * time it replaces is taken out of the recurring Series, as an EXDATE is.
 */
import {
  every,
  first,
  readCalendar,
  textOf,
  whenOf,
  type Component,
  type Wall,
  type Zone,
} from './ical.ts';
import { readRule, startsOf, type Rule } from './recurrence.ts';

/** One Event, as scribe holds it in memory. Nothing of it is kept in scribe.db. */
export type Event = {
  /** The UID of the entry it comes from: with the start, it names this Event. */
  readonly uid: string;
  /** Its name, the entry's SUMMARY. */
  readonly name: string;
  /** When it starts, in ms since the epoch. */
  readonly start: number;
  /** When it ends, in ms since the epoch. */
  readonly end: number;
  /** Its Google Meet link. */
  readonly meet: string;
};

/** One entry of the feed that is an Event: what it is, and when it happens. */
export type Series = {
  readonly uid: string;
  readonly name: string;
  readonly meet: string;
  /** When its first time starts, in ms since the epoch. */
  readonly start: number;
  /** How long each time lasts, in ms. */
  readonly length: number;
  /** How it recurs, or null when it happens once. */
  readonly repeat: Repeat | null;
};

/** How a Series recurs: its rule, from the wall time of its first time. */
type Repeat = {
  readonly rule: Rule;
  /** The wall time of the first time, which the rule repeats. */
  readonly wall: Wall;
  /** The zone of that wall time. */
  readonly zone: Zone;
  /** The starts that do not happen here: each EXDATE and each RECURRENCE-ID of the UID. */
  readonly except: ReadonlySet<number>;
};

/** The first Google Meet link in a text. */
const MEET = /https:\/\/meet\.google\.com\/[A-Za-z0-9\-_/?=&.%]+/;

/** Read a feed into its Series, or throw when the text is not an iCal calendar. */
export function readSeries(text: string): readonly Series[] {
  const calendar = readCalendar(text);
  const name = first(calendar.properties, 'X-WR-CALNAME');
  const owner = name !== undefined && name.value.includes('@') ? name.value.trim() : null;
  const replaced = replacedTimes(calendar.events);
  return calendar.events.flatMap((component) => {
    const uid = first(component, 'UID')?.value.trim() ?? '';
    const series = seriesOf(component, owner, replaced.get(uid) ?? []);
    return series === null ? [] : [series];
  });
}

/** Every Event of these Series that has not ended at `from` and starts before `to`, by start. */
export function eventsBetween(series: readonly Series[], from: number, to: number): Event[] {
  return series
    .flatMap((one) => occurrencesOf(one, from, to))
    .sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}

/** The times this Series happens that have not ended at `from` and start before `to`. */
function occurrencesOf(series: Series, from: number, to: number): Event[] {
  const { repeat, length } = series;
  const starts =
    repeat === null
      ? [series.start]
      : startsOf(repeat.rule, repeat.wall, repeat.zone, from - length, to).filter(
          (start) => !repeat.except.has(start),
        );
  return starts
    .filter((start) => start + length > from && start < to)
    .map((start) => ({
      uid: series.uid,
      name: series.name,
      start,
      end: start + length,
      meet: series.meet,
    }));
}

/**
 * The starts each UID's moved or cancelled times replace, from the
 * RECURRENCE-ID of every VEVENT, whether or not that VEVENT is an Event.
 */
function replacedTimes(components: readonly Component[]): Map<string, number[]> {
  const replaced = new Map<string, number[]>();
  for (const component of components) {
    const line = first(component, 'RECURRENCE-ID');
    const when = line === undefined ? null : whenOf(line);
    if (when?.kind !== 'time') continue;
    const uid = first(component, 'UID')?.value.trim() ?? '';
    replaced.set(uid, [...(replaced.get(uid) ?? []), when.ms]);
  }
  return replaced;
}

/** The Series one VEVENT is, or null when it is not an Event. */
function seriesOf(
  component: Component,
  owner: string | null,
  replaced: readonly number[],
): Series | null {
  if (first(component, 'STATUS')?.value.trim().toUpperCase() === 'CANCELLED') return null;
  if (owner !== null && declinedBy(component, owner)) return null;
  const meet = meetOf(component);
  if (meet === null) return null;
  const startLine = first(component, 'DTSTART');
  const start = startLine === undefined ? null : whenOf(startLine);
  // An all-day entry never counts: it has no time to give a Notice before.
  if (start === null || start.kind !== 'time') return null;
  const endLine = first(component, 'DTEND');
  const end = endLine === undefined ? null : whenOf(endLine);
  const length = end !== null && end.kind === 'time' ? Math.max(0, end.ms - start.ms) : 0;
  // A VEVENT with a RECURRENCE-ID is one time of a Series: it happens once.
  const rules = first(component, 'RECURRENCE-ID') === undefined ? every(component, 'RRULE') : [];
  let repeat: Repeat | null = null;
  if (rules.length > 0) {
    const rule = rules.length === 1 ? readRule(rules[0]?.value ?? '', start.zone) : null;
    // A rule scribe does not read gives no Event, not a guessed one.
    if (rule === null) return null;
    const except = new Set([...excludedTimes(component), ...replaced]);
    repeat = { rule, wall: start.wall, zone: start.zone, except };
  }
  return {
    uid: first(component, 'UID')?.value.trim() ?? '',
    name: textOf(first(component, 'SUMMARY')?.value ?? '').trim(),
    meet,
    start: start.ms,
    length,
    repeat,
  };
}

/** The starts every EXDATE line takes out. One line may hold several, with commas. */
function excludedTimes(component: Component): number[] {
  return every(component, 'EXDATE').flatMap((line) =>
    line.value.split(',').flatMap((value) => {
      const when = whenOf({ ...line, value });
      return when?.kind === 'time' ? [when.ms] : [];
    }),
  );
}

/** Whether the owner's own ATTENDEE line says they declined. */
function declinedBy(component: Component, owner: string): boolean {
  const mailto = `mailto:${owner}`.toLowerCase();
  return every(component, 'ATTENDEE').some(
    (attendee) =>
      attendee.value.trim().toLowerCase() === mailto &&
      attendee.params['PARTSTAT']?.toUpperCase() === 'DECLINED',
  );
}

/** The Meet link: the conference data, or else the first one in the description or location. */
function meetOf(component: Component): string | null {
  const conference = first(component, 'X-GOOGLE-CONFERENCE')?.value.trim() ?? '';
  const fromConference = MEET.exec(conference);
  // Conference data that is not Google Meet, such as an add-on's, does not count.
  if (fromConference !== null && fromConference.index === 0) return fromConference[0];
  for (const name of ['DESCRIPTION', 'LOCATION']) {
    const found = MEET.exec(textOf(first(component, name)?.value ?? ''));
    if (found !== null) return found[0];
  }
  return null;
}
