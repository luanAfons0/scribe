/**
 * When a recurring Event happens: an RRULE, as far as Google writes it
 * (ADR-0006), with no dependency.
 *
 * scribe reads FREQ DAILY, WEEKLY and MONTHLY, with INTERVAL, UNTIL, COUNT,
 * BYDAY, BYMONTHDAY and WKST. A rule with any other part is not read at all:
 * an Event at a guessed time is worse than no Event.
 *
 * A rule repeats the wall time of its first time, in that time's zone: a
 * 10:00 in New York is 10:00 there on both sides of a change of daylight
 * saving time. So the times are found as wall dates, with plain day
 * arithmetic, and only the ones near the span asked for become instants.
 */
import { instantOf, whenOf, type Wall, type Zone } from './ical.ts';

/** One day, in ms. */
const DAY = 24 * 60 * 60_000;

/**
 * More than any zone is ahead of or behind UTC: a wall time read as UTC is
 * never this far from its instant.
 */
const ZONE_SLACK = 2 * DAY;

/** The weekdays as iCal names them, from Sunday, which is day 0. */
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The parts of a rule scribe reads. A rule with any other part is not read. */
const KNOWN = new Set(['FREQ', 'INTERVAL', 'UNTIL', 'COUNT', 'BYDAY', 'BYMONTHDAY', 'WKST']);

/** One BYDAY entry: a weekday, and which one of the month it is, or 0 for every one. */
type ByDay = {
  /** From 0, Sunday, to 6, Saturday. */
  readonly weekday: number;
  /** 1 for the first in the month, -1 for the last, 0 for each one. */
  readonly ordinal: number;
};

/** When a rule stops: after an instant, or after a day of the wall calendar. */
type Until =
  | { readonly kind: 'time'; readonly ms: number }
  | { readonly kind: 'day'; readonly day: number };

/** How a Series recurs: its rule, from the wall time of its first time. */
export type Repeat = {
  readonly rule: Rule;
  /** The wall time of the first time, which the rule repeats. */
  readonly wall: Wall;
  /** The zone of that wall time. */
  readonly zone: Zone;
  /** The starts that do not happen: each EXDATE and each RECURRENCE-ID of the UID. */
  readonly except: ReadonlySet<number>;
};

/** An RRULE scribe can read. */
export type Rule = {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  /** Every how many days, weeks or months. */
  readonly interval: number;
  readonly until: Until | null;
  /** How many times in all, the first time included. */
  readonly count: number | null;
  /** The BYDAY entries, or null when the rule has none. */
  readonly byDay: readonly ByDay[] | null;
  /** The BYMONTHDAY entries, -1 for the last day, or null when the rule has none. */
  readonly byMonthDay: readonly number[] | null;
  /** The day a week starts on, from 0, Sunday. */
  readonly weekStart: number;
};

/**
 * Read an RRULE value, or give null when scribe does not read this rule. A
 * floating UNTIL is read in the first time's zone.
 */
export function readRule(value: string, zone: Zone): Rule | null {
  const parts = new Map<string, string>();
  for (const part of value.trim().split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) return null;
    const name = part.slice(0, equals).toUpperCase();
    if (!KNOWN.has(name) || parts.has(name)) return null;
    parts.set(name, part.slice(equals + 1).trim().toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;
  const interval = positive(parts.get('INTERVAL') ?? '1');
  const count = read(parts.get('COUNT'), positive);
  const until = read(parts.get('UNTIL'), (text) => untilOf(text, zone));
  const byDay = read(parts.get('BYDAY'), byDayOf);
  const byMonthDay = read(parts.get('BYMONTHDAY'), byMonthDayOf);
  const weekStart = WEEKDAYS.indexOf(parts.get('WKST') ?? 'MO');
  if (interval === null || weekStart < 0) return null;
  if (count === undefined || until === undefined) return null;
  if (byDay === undefined || byMonthDay === undefined) return null;
  if (count !== null && until !== null) return null;
  // A numbered weekday, "the second Tuesday", is a month's; a day of the
  // month is a month's too; and a month takes one of the two, not both.
  if (freq !== 'MONTHLY' && byDay?.some((entry) => entry.ordinal !== 0)) return null;
  if (freq !== 'MONTHLY' && byMonthDay !== null) return null;
  if (byDay !== null && byMonthDay !== null) return null;
  return { freq, interval, until, count, byDay, byMonthDay, weekStart };
}

/**
 * Every instant the rule starts a time at, from `from` until before `to`,
 * but the starts it takes out. The first time, the wall time of the Repeat in
 * its zone, always counts toward COUNT, even when it is taken out.
 */
export function startsOf(repeat: Repeat, from: number, to: number): number[] {
  const { rule, wall: first, zone, except } = repeat;
  const starts: number[] = [];
  const clock = ((first.hour * 60 + first.minute) * 60 + first.second) * 1000;
  let counted = 0;
  // The last day a time in the span can be on, as a wall date.
  const lastDay = Math.ceil((to + ZONE_SLACK) / DAY);
  for (const day of daysOf(rule, dayOf(first), lastDay)) {
    counted += 1;
    if (rule.count !== null && counted > rule.count) break;
    const until = rule.until;
    if (until?.kind === 'day' && day > until.day) break;
    // The wall time, read as if it were UTC: never two days from its instant.
    const near = day * DAY + clock;
    if (near >= to + ZONE_SLACK) break;
    // A time long before the span is counted, and needs no instant: if it is
    // past UNTIL, so is every time in the span, which is checked below.
    if (near < from - ZONE_SLACK) continue;
    const { hour, minute, second } = first;
    const start = instantOf({ ...wallOf(day), hour, minute, second }, zone);
    if (start === null) break;
    if (until?.kind === 'time' && start > until.ms) break;
    if (start >= from && start < to && !except.has(start)) starts.push(start);
  }
  return starts;
}

/**
 * The days the rule happens on, as day numbers from 1970-01-01, in order:
 * the first day, then each day of the rule after it, until a period starts
 * after `lastDay`. A rule may find no day in any period, such as the 30th of
 * every twelfth month from a February: the end of the span ends it.
 */
function* daysOf(rule: Rule, firstDay: number, lastDay: number): Generator<number> {
  yield firstDay;
  for (let period = 0; ; period += 1) {
    const { start, days } = periodOf(rule, firstDay, period);
    if (start > lastDay) return;
    for (const day of days) {
      if (day > firstDay) yield day;
    }
  }
}

/**
 * One period of the rule, the `period`th day, week or month: the day it
 * starts on, and the days of the rule in it, in order.
 */
function periodOf(
  rule: Rule,
  firstDay: number,
  period: number,
): { readonly start: number; readonly days: number[] } {
  if (rule.freq === 'DAILY') {
    const day = firstDay + period * rule.interval;
    const weekdays = rule.byDay?.map((entry) => entry.weekday);
    const days = weekdays === undefined || weekdays.includes(weekdayOf(day)) ? [day] : [];
    return { start: day, days };
  }
  if (rule.freq === 'WEEKLY') {
    const weekStart = firstDay - ((weekdayOf(firstDay) - rule.weekStart + 7) % 7);
    const start = weekStart + period * 7 * rule.interval;
    const weekdays = rule.byDay?.map((entry) => entry.weekday) ?? [weekdayOf(firstDay)];
    return {
      start,
      days: sorted(weekdays.map((weekday) => start + ((weekday - rule.weekStart + 7) % 7))),
    };
  }
  const { year, month, day } = wallOf(firstDay);
  const monthIndex = year * 12 + (month - 1) + period * rule.interval;
  const start = Date.UTC(Math.floor(monthIndex / 12), monthIndex % 12, 1) / DAY;
  const length = Date.UTC(Math.floor(monthIndex / 12), (monthIndex % 12) + 1, 1) / DAY - start;
  if (rule.byDay !== null) {
    return {
      start,
      days: sorted(rule.byDay.flatMap((entry) => weekdaysInMonth(start, length, entry))),
    };
  }
  const days = (rule.byMonthDay ?? [day])
    .map((wanted) => (wanted > 0 ? wanted : length + wanted + 1))
    .filter((wanted) => wanted >= 1 && wanted <= length);
  return { start, days: sorted(days.map((wanted) => start + wanted - 1)) };
}

/** The days of a month a BYDAY entry names: each such weekday, or the numbered one. */
function weekdaysInMonth(start: number, length: number, entry: ByDay): number[] {
  const firstOne = start + ((entry.weekday - weekdayOf(start) + 7) % 7);
  const all: number[] = [];
  for (let day = firstOne; day < start + length; day += 7) all.push(day);
  if (entry.ordinal === 0) return all;
  const picked = entry.ordinal > 0 ? all[entry.ordinal - 1] : all[all.length + entry.ordinal];
  return picked === undefined ? [] : [picked];
}

/** Read UNTIL: a time with a Z, a floating time read in `zone`, or a day. */
function untilOf(value: string, zone: Zone): Until | null {
  const params: Record<string, string> = zone !== null && zone !== 'UTC' ? { TZID: zone } : {};
  const when = whenOf({ name: 'UNTIL', params, value });
  if (when === null) return null;
  if (when.kind === 'time') return { kind: 'time', ms: when.ms };
  return { kind: 'day', day: Date.UTC(when.year, when.month - 1, when.day) / DAY };
}

/** Read BYDAY: MO,WE or 2TU or -1FR. */
function byDayOf(value: string): ByDay[] | null {
  const entries: ByDay[] = [];
  for (const part of value.split(',')) {
    const found = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part.trim());
    if (found === null) return null;
    const ordinal = found[1] === undefined ? 0 : Number(found[1]);
    if (found[1] !== undefined && (ordinal === 0 || Math.abs(ordinal) > 5)) return null;
    entries.push({ weekday: WEEKDAYS.indexOf(found[2] ?? ''), ordinal });
  }
  return entries;
}

/** Read BYMONTHDAY: 12 or -1, each from -31 to 31 and not 0. */
function byMonthDayOf(value: string): number[] | null {
  const days = value.split(',').map((part) => Number(part.trim()));
  const valid = days.every((day) => Number.isInteger(day) && day !== 0 && Math.abs(day) <= 31);
  return valid ? days : null;
}

/**
 * A part read: null when the rule has no such part, undefined when it has
 * one scribe cannot read.
 */
function read<T>(
  value: string | undefined,
  reader: (text: string) => T | null,
): T | null | undefined {
  if (value === undefined) return null;
  return reader(value) ?? undefined;
}

/** A whole number above 0, or null. */
function positive(value: string): number | null {
  const number = Number(value);
  return /^\d+$/.test(value) && number > 0 ? number : null;
}

/** The day number of a wall date: days since 1970-01-01. */
function dayOf(wall: Pick<Wall, 'year' | 'month' | 'day'>): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day) / DAY;
}

/** The wall date of a day number, at midnight. */
function wallOf(day: number): Wall {
  const date = new Date(day * DAY);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/** The weekday of a day number, from 0, Sunday. 1970-01-01 was a Thursday. */
function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** The days, from the earliest, each once. */
function sorted(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}
