/**
 * The iCal text format, as Google Calendar writes a calendar's secret
 * address: scribe's own reader, with no dependency (ADR-0006).
 *
 * It knows the text and nothing of Events: it unfolds the lines, splits each
 * into its name, its parameters and its value, and reads a date or a time.
 * Which VEVENT is an Event, and when it happens, is `events.ts`'s job.
 *
 * A time with a TZID is read through `Intl`, not through the VTIMEZONE blocks
 * of the feed: Google names IANA time zones, and Node knows them all.
 */

/** One content line: its name, its parameters, and its value. */
export type Property = {
  /** The name, in upper case: DTSTART, SUMMARY, ATTENDEE. */
  readonly name: string;
  /** The parameters, by name in upper case, each with its quotes taken off. */
  readonly params: Readonly<Record<string, string>>;
  /** The value, as the line has it: a TEXT value is still escaped. */
  readonly value: string;
};

/** One VEVENT, as its content lines in their order. */
export type Component = readonly Property[];

/** A VCALENDAR: the lines of the calendar itself, and each VEVENT in it. */
export type Calendar = {
  /** The lines outside every component, such as X-WR-CALNAME. */
  readonly properties: Component;
  /** Each VEVENT, in the order of the feed. */
  readonly events: readonly Component[];
};

/** A wall time: the date and the clock, with no time zone. */
export type Wall = {
  readonly year: number;
  /** From 1 to 12. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

/**
 * Where a wall time is read: 'UTC' for a time with a Z, an IANA time zone for
 * one with a TZID, and null for a time that floats, read where scribe runs.
 */
export type Zone = string | null;

/**
 * A time an iCal line gives: an instant, with the wall time and the zone it
 * was written in, or a day with no time, which is all day. A recurring rule
 * repeats the wall time, so the zone's change of daylight saving time does
 * not move it.
 */
export type When =
  | { readonly kind: 'time'; readonly ms: number; readonly wall: Wall; readonly zone: Zone }
  | { readonly kind: 'date'; readonly year: number; readonly month: number; readonly day: number };

/**
 * Read a VCALENDAR, or throw when the text is not one. Components other than
 * VEVENT, such as VTIMEZONE, are passed over.
 */
export function readCalendar(text: string): Calendar {
  const lines = unfold(text);
  const first = lines.find((line) => line.trim() !== '');
  if (first?.trim().toUpperCase() !== 'BEGIN:VCALENDAR') {
    throw new Error('The text is not an iCal calendar.');
  }
  const properties: Property[] = [];
  const events: Property[][] = [];
  /** The components the line is in, innermost last. */
  const open: string[] = [];
  let event: Property[] | null = null;
  for (const line of lines) {
    const property = propertyOf(line);
    if (property === null) continue;
    if (property.name === 'BEGIN') {
      open.push(property.value.toUpperCase());
      if (open.length === 2 && open[1] === 'VEVENT') event = [];
      continue;
    }
    if (property.name === 'END') {
      if (open.length === 2 && event !== null) events.push(event);
      if (open.length === 2) event = null;
      open.pop();
      continue;
    }
    if (open.length === 1) properties.push(property);
    else if (open.length === 2 && event !== null) event.push(property);
  }
  return { properties, events };
}

/** The first line of this name in a component, or undefined. */
export function first(component: Component, name: string): Property | undefined {
  return component.find((property) => property.name === name);
}

/** Every line of this name in a component. */
export function every(component: Component, name: string): readonly Property[] {
  return component.filter((property) => property.name === name);
}

/**
 * The time a DTSTART, DTEND, RECURRENCE-ID or EXDATE line gives, or null when
 * it cannot be read, such as a TZID no time zone of `Intl` has.
 */
export function whenOf(property: Property): When | null {
  const value = property.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date !== null || property.params['VALUE'] === 'DATE') {
    if (date === null) return null;
    return { kind: 'date', year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) };
  }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (time === null) return null;
  const [year, month, day, hour, minute, second] = time.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ];
  const wall = { year, month, day, hour, minute, second };
  // A time with no zone floats: it is the same wall time wherever it is read.
  const zone = time[7] === 'Z' ? 'UTC' : (property.params['TZID'] ?? null);
  const ms = instantOf(wall, zone);
  return ms === null ? null : { kind: 'time', ms, wall, zone };
}

/** The instant a wall time is in a zone, or null when `Intl` knows no such zone. */
export function instantOf(wall: Wall, zone: Zone): number | null {
  const { year, month, day, hour, minute, second } = wall;
  if (zone === 'UTC') return Date.UTC(year, month - 1, day, hour, minute, second);
  if (zone === null) return new Date(year, month - 1, day, hour, minute, second).getTime();
  try {
    return wallTimeIn(zone, year, month, day, hour, minute, second);
  } catch {
    return null;
  }
}

/** A TEXT value with its escapes read: `\n`, `\,`, `\;` and `\\`. */
export function textOf(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, escaped: string) =>
    escaped === 'n' || escaped === 'N' ? '\n' : escaped,
  );
}

/**
 * The lines, unfolded: a line that starts with a space or a tab goes on the
 * line before it, with that one character taken off.
 */
function unfold(text: string): string[] {
  return text.replace(/^﻿/, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

/** One content line read into its parts, or null when it has no colon. */
function propertyOf(line: string): Property | null {
  // The value starts at the first colon that is not inside a quoted parameter.
  let quoted = false;
  let colon = -1;
  for (let at = 0; at < line.length; at += 1) {
    const character = line[at];
    if (character === '"') quoted = !quoted;
    else if (character === ':' && !quoted) {
      colon = at;
      break;
    }
  }
  if (colon < 0) return null;
  const [name = '', ...rest] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params: Record<string, string> = {};
  for (const param of rest) {
    const equals = param.indexOf('=');
    if (equals < 0) continue;
    params[param.slice(0, equals).toUpperCase()] = param.slice(equals + 1).replace(/"/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Split text on a character, except where it is inside double quotes. */
function splitOutsideQuotes(text: string, on: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let part = '';
  for (const character of text) {
    if (character === '"') quoted = !quoted;
    if (character === on && !quoted) {
      parts.push(part);
      part = '';
    } else {
      part += character;
    }
  }
  parts.push(part);
  return parts;
}

/** One formatter per time zone, which reads an instant as its wall time there. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The instant a wall time in this IANA time zone is. Throws on a zone Intl does not know. */
function wallTimeIn(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // The zone's offset at the wall time read as UTC is right but near a change
  // of offset; a second look at the instant that gives settles it.
  const guess = wall - offsetIn(zone, wall);
  return wall - offsetIn(zone, guess);
}

/** How far ahead of UTC this time zone's wall clock is at this instant, in ms. */
function offsetIn(zone: string, ms: number): number {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((found) => found.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return asUtc - (ms - (ms % 1000));
}
