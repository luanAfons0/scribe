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
 * a span of time. Today a Series happens once, at its own DTSTART. Recurring
 * rules expand here, in `occurrencesOf`, and nowhere else.
 */
import { every, first, readCalendar, textOf, whenOf, type Component } from './ical.ts';

/** One Event, as scribe holds it in memory. A Call keeps only its name and start. */
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
};

/** The first Google Meet link in a text. */
const MEET = /https:\/\/meet\.google\.com\/[A-Za-z0-9\-_/?=&.%]+/;

/** Read a feed into its Series, or throw when the text is not an iCal calendar. */
export function readSeries(text: string): readonly Series[] {
  const calendar = readCalendar(text);
  const name = first(calendar.properties, 'X-WR-CALNAME');
  const owner = name !== undefined && name.value.includes('@') ? name.value.trim() : null;
  return calendar.events.flatMap((component) => {
    const series = seriesOf(component, owner);
    return series === null ? [] : [series];
  });
}

/** Every Event of these Series that has not ended at `from` and starts before `to`, by start. */
export function eventsBetween(series: readonly Series[], from: number, to: number): Event[] {
  return series
    .flatMap((one) => occurrencesOf(one, from, to))
    .sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}

/** The times this Series happens in the span: today, its one time, when it falls in it. */
function occurrencesOf(series: Series, from: number, to: number): Event[] {
  const end = series.start + series.length;
  if (end <= from || series.start >= to) return [];
  return [{ uid: series.uid, name: series.name, start: series.start, end, meet: series.meet }];
}

/** The Series one VEVENT is, or null when it is not an Event. */
function seriesOf(component: Component, owner: string | null): Series | null {
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
  return {
    uid: first(component, 'UID')?.value.trim() ?? '',
    name: textOf(first(component, 'SUMMARY')?.value ?? '').trim(),
    meet,
    start: start.ms,
    length,
  };
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
