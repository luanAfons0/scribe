/**
 * A calendar feed, and a Plugin Server that reads it, for the tests of Events.
 *
 * Three test files serve a feed from the local server and save its address as
 * the operator does. They share these parts so that one feed is written one
 * way, with times relative to the test's own now.
 */
import { strict as assert } from 'node:assert';
import type { TestContext } from 'node:test';
import { startedAndShaken, structureOf, type Started } from './plugin.ts';
import { serveFiles, type Route } from './server.ts';

/** The path the feed is served at, shaped as Google shapes a secret address. */
export const FEED = '/calendar/ical/operador%40example.com/private-0f9e8d7c6b5a43210/basic.ics';

/** The part of the address that makes it a secret. */
export const SECRET = 'private-0f9e8d7c6b5a43210';

/** The calendar's owner, as Google names it in the feed. */
export const OWNER = 'operador@example.com';

/** One minute, in milliseconds. */
export const MINUTE = 60_000;

/** One hour, in milliseconds. */
export const HOUR = 60 * MINUTE;

/** The line that gives an Event a Meet link. */
export const MEET = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';

/** The calendar's address, as get_settings tells it. */
export type Secret = {
  set: boolean;
  saved: boolean;
  from: string;
  variable: string;
  problem: string | null;
  ignored: string | null;
  read: {
    at: string;
    count: number | null;
    problem: string | null;
    declined: string | null;
  } | null;
};

/** A time as iCal writes it in UTC: 20261012T140000Z. */
export function utc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** One VEVENT: the lines given, between its BEGIN and END. */
export function vevent(...lines: readonly string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

/** An Event that starts at `start` and lasts an hour, with these lines more. */
export function timed(
  uid: string,
  name: string,
  start: number,
  ...more: readonly string[]
): string {
  return vevent(
    `UID:${uid}`,
    `DTSTART:${utc(start)}`,
    `DTEND:${utc(start + HOUR)}`,
    `SUMMARY:${name}`,
    ...more,
  );
}

/** A whole feed of these VEVENTs, with this calendar name and CRLF line ends. */
export function feedCalled(name: string, ...events: readonly string[]): Buffer {
  return Buffer.from(
    [
      'BEGIN:VCALENDAR',
      'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
      'VERSION:2.0',
      `X-WR-CALNAME:${name}`,
      'X-WR-TIMEZONE:America/Sao_Paulo',
      ...events,
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  );
}

/** A whole feed of these VEVENTs, as Google writes it for the owner. */
export function feed(...events: readonly string[]): Buffer {
  return feedCalled(OWNER, ...events);
}

/** The calendar's address, as get_settings tells it now. */
export async function secret(plugin: Started): Promise<Secret> {
  return structureOf<{ settings: { calendarUrl: Secret } }>(await plugin.call('get_settings'))
    .settings.calendarUrl;
}

/** Wait until the calendar has been read since `after`, and hand back what it gave. */
export async function readSince(plugin: Started, after = ''): Promise<NonNullable<Secret['read']>> {
  const started = Date.now();
  for (;;) {
    const { read } = await secret(plugin);
    if (read !== null && read.at > after) return read;
    if (Date.now() - started > 5_000) {
      throw new Error(`the calendar was never read: ${JSON.stringify(read)}\n${plugin.output()}`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** A Plugin Server with the feed's address saved, as the operator saves it. */
export async function withFeed(
  t: TestContext,
  routes: Readonly<Record<string, Route>>,
  env: Readonly<Record<string, string>> = {},
): Promise<{ plugin: Started; address: string }> {
  const served = await serveFiles(t, routes);
  const plugin = await startedAndShaken(t, { env });
  const address = served.url(FEED);
  const saved = await plugin.call('update_settings', { calendarUrl: address });
  assert.equal(saved.error, undefined, saved.error?.message);
  return { plugin, address };
}
