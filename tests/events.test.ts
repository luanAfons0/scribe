/**
 * Events come from the calendar's secret iCal address (ADR-0006). The test
 * serves a feed from the local server, with times relative to its own now,
 * saves its address as the operator does, and reads what `list_events` and
 * `get_settings` answer.
 *
 * The address is a secret: whoever holds it reads the whole calendar. So the
 * tests also look for it where it must never be: in a tool result, in
 * `get_settings`, and on stderr.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import test, { type TestContext } from 'node:test';
import { startedAndShaken, structureOf, type Started } from './helpers/plugin.ts';
import { serveFiles, type Route } from './helpers/server.ts';

/** The path the feed is served at, shaped as Google shapes a secret address. */
const FEED = '/calendar/ical/operador%40example.com/private-0f9e8d7c6b5a43210/basic.ics';

/** The part of the address that makes it a secret. */
const SECRET = 'private-0f9e8d7c6b5a43210';

/** The calendar's owner, as Google names it in the feed. */
const OWNER = 'operador@example.com';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** One Event, as list_events answers it. */
type Event = { name: string; start: string; end: string; meet: string };

/** A time as iCal writes it in UTC: 20261012T140000Z. */
function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** One VEVENT: the lines given, between its BEGIN and END. */
function vevent(...lines: readonly string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

/** An Event that starts at `start` and lasts an hour, with these lines more. */
function timed(uid: string, name: string, start: number, ...more: readonly string[]): string {
  return vevent(
    `UID:${uid}`,
    `DTSTART:${utc(start)}`,
    `DTEND:${utc(start + HOUR)}`,
    `SUMMARY:${name}`,
    ...more,
  );
}

/** A whole feed of these VEVENTs, as Google writes it, with CRLF line ends. */
function feed(...events: readonly string[]): Buffer {
  return Buffer.from(
    [
      'BEGIN:VCALENDAR',
      'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
      'VERSION:2.0',
      `X-WR-CALNAME:${OWNER}`,
      'X-WR-TIMEZONE:America/Sao_Paulo',
      ...events,
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  );
}

/** The owner's ATTENDEE line, with this PARTSTAT. */
function owner(partstat: string): string {
  return (
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};CN=${OWNER};` +
    `X-NUM-GUESTS=0:mailto:${OWNER}`
  );
}

/** The calendar's address, as get_settings tells it. */
type Secret = {
  set: boolean;
  saved: boolean;
  from: string;
  variable: string;
  problem: string | null;
  ignored: string | null;
  read: { at: string; count: number | null; problem: string | null } | null;
};

/** The calendar's address, as get_settings tells it now. */
async function secret(plugin: Started): Promise<Secret> {
  return structureOf<{ settings: { calendarUrl: Secret } }>(await plugin.call('get_settings'))
    .settings.calendarUrl;
}

/** Wait until the calendar has been read since `after`, and hand back what it gave. */
async function readSince(plugin: Started, after = ''): Promise<NonNullable<Secret['read']>> {
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

/** An address on loopback where nothing listens. */
async function nobodyThere(): Promise<string> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as { port: number };
  await new Promise<void>((closed) => server.close(() => closed()));
  return `http://127.0.0.1:${port}${FEED}`;
}

/** The Events scribe holds now. */
async function events(plugin: Started): Promise<Event[]> {
  return structureOf<{ events: Event[] }>(await plugin.call('list_events')).events;
}

/** Wait until list_events answers what `wanted` looks for. */
async function eventsUntil(
  plugin: Started,
  wanted: (events: Event[]) => boolean,
  within = 5_000,
): Promise<Event[]> {
  const started = Date.now();
  for (;;) {
    const found = await events(plugin);
    if (wanted(found)) return found;
    if (Date.now() - started > within) {
      throw new Error(`list_events never got there: ${JSON.stringify(found)}\n${plugin.output()}`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** A Plugin Server with the feed's address saved, as the operator saves it. */
async function withFeed(
  t: TestContext,
  routes: Record<string, Route>,
  env: Readonly<Record<string, string>> = {},
): Promise<{ plugin: Started; address: string }> {
  const served = await serveFiles(t, routes);
  const plugin = await startedAndShaken(t, { env });
  const address = served.url(FEED);
  const saved = await plugin.call('update_settings', { calendarUrl: address });
  assert.equal(saved.error, undefined, saved.error?.message);
  return { plugin, address };
}

test('list_events returns an Event with a Meet link in its conference data', async (t) => {
  const start = Date.now() + HOUR;
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      timed(
        'a@google.com',
        'Sprint review',
        start,
        'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
      ),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(found, [
    {
      name: 'Sprint review',
      start: new Date(Math.floor(start / 1000) * 1000).toISOString(),
      end: new Date(Math.floor(start / 1000) * 1000 + HOUR).toISOString(),
      meet: 'https://meet.google.com/abc-defg-hij',
    },
  ]);
});

test(
  'without conference data, the first Meet link in the description or the location counts',
  async (t) => {
    const now = Date.now();
    const { plugin } = await withFeed(t, {
      [FEED]: feed(
        timed(
          'b@google.com',
          'Retro\\, com o time',
          now + 2 * HOUR,
          // Google folds a long line: the next one starts with a space.
          'DESCRIPTION:Entre com o Google Meet: https://meet.google.com/bbb-bbbb-bbb\\nOu ',
          ' https://meet.google.com/ccc-cccc-ccc',
        ),
        timed(
          'c@google.com',
          '1:1',
          now + 3 * HOUR,
          'LOCATION:https://meet.google.com/ddd-dddd-ddd',
        ),
        timed('d@google.com', 'Almoço', now + 4 * HOUR, 'LOCATION:Restaurante'),
        timed(
          'e@google.com',
          'Zoom',
          now + 5 * HOUR,
          'X-GOOGLE-CONFERENCE:https://zoom.us/j/123',
          'DESCRIPTION:https://zoom.us/j/123',
        ),
      ),
    });

    const found = await eventsUntil(plugin, (listed) => listed.length > 0);

    assert.deepEqual(
      found.map((event) => [event.name, event.meet]),
      [
        ['Retro, com o time', 'https://meet.google.com/bbb-bbbb-bbb'],
        ['1:1', 'https://meet.google.com/ddd-dddd-ddd'],
      ],
    );
  },
);

test('only Events from now to the next day are returned, one under way too', async (t) => {
  const now = Date.now();
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      timed('later@google.com', 'Amanhã à tarde', now + 30 * HOUR, link),
      timed('soon@google.com', 'Daily', now + 10 * MINUTE, link),
      timed('ended@google.com', 'Ontem', now - 2 * HOUR, link),
      timed('now@google.com', 'Planning', now - 30 * MINUTE, link),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(found.map((event) => event.name), ['Planning', 'Daily']);
});

test('a declined Event, a cancelled Event and an all-day Event are not returned', async (t) => {
  const now = Date.now();
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  const day = utc(now + HOUR).slice(0, 8);
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      timed('declined@google.com', 'Recusado', now + HOUR, link, owner('DECLINED')),
      timed('cancelled@google.com', 'Cancelado', now + HOUR, link, 'STATUS:CANCELLED'),
      vevent(
        'UID:allday@google.com',
        `DTSTART;VALUE=DATE:${day}`,
        'SUMMARY:Dia todo',
        link,
      ),
      timed(
        'other@google.com',
        'Aceito',
        now + 2 * HOUR,
        link,
        owner('ACCEPTED'),
        'ATTENDEE;PARTSTAT=DECLINED;CN=outra@example.com:mailto:outra@example.com',
      ),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(found.map((event) => event.name), ['Aceito']);
});

test('a start in a time zone of its own is read at the right instant', async (t) => {
  // São Paulo is UTC-3 and Kolkata UTC+5:30 all year, so the wall time there
  // is known from the test's own now.
  const start = Math.floor((Date.now() + 2 * HOUR) / MINUTE) * MINUTE;
  const wall = (offset: number): string => utc(start + offset).replace('Z', '');
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      vevent(
        'UID:zone@google.com',
        `DTSTART;TZID=America/Sao_Paulo:${wall(-3 * HOUR)}`,
        `DTEND;TZID=America/Sao_Paulo:${wall(-3 * HOUR + 30 * MINUTE)}`,
        'SUMMARY:São Paulo',
        link,
      ),
      vevent(
        'UID:kolkata@google.com',
        `DTSTART;TZID="Asia/Kolkata":${wall(5.5 * HOUR + HOUR)}`,
        `DTEND;TZID="Asia/Kolkata":${wall(5.5 * HOUR + 2 * HOUR)}`,
        'SUMMARY:Kolkata',
        link,
      ),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(
    found.map((event) => [event.name, event.start, event.end]),
    [
      [
        'São Paulo',
        new Date(start).toISOString(),
        new Date(start + 30 * MINUTE).toISOString(),
      ],
      ['Kolkata', new Date(start + HOUR).toISOString(), new Date(start + 2 * HOUR).toISOString()],
    ],
  );
});

test('a feed that is not iCal gives a sentence in get_settings and no Events', async (t) => {
  const { plugin } = await withFeed(t, {
    [FEED]: Buffer.from('<!DOCTYPE html><html><body>Sign in</body></html>'),
  });

  const read = await readSince(plugin);
  const listed = await plugin.call('list_calls');

  assert.equal(read.count, null);
  assert.match(read.problem ?? '', /not answer with an iCal calendar/);
  assert.deepEqual(await events(plugin), []);
  assert.equal(listed.error, undefined);
});

test('an address that does not answer gives a sentence, and scribe keeps working', async (t) => {
  const plugin = await startedAndShaken(t);
  await plugin.call('update_settings', { calendarUrl: await nobodyThere() });

  const read = await readSince(plugin);
  const started = await plugin.call('start_call');

  assert.equal(read.count, null);
  assert.match(read.problem ?? '', /^The calendar's secret address did not answer/);
  assert.deepEqual(await events(plugin), []);
  assert.equal(started.error, undefined, started.error?.message);
});

test('an address Google no longer serves says how to get a new one', async (t) => {
  const { plugin } = await withFeed(t, { [FEED]: 404 });

  const read = await readSince(plugin);

  assert.match(read.problem ?? '', /answered 404/);
  assert.match(read.problem ?? '', /Workspace admin/);
});

test(
  'after a good and a failing read, the address is in no tool result, not in get_settings, ' +
    'and not on stderr',
  async (t) => {
    const start = Date.now() + HOUR;
    const { plugin, address } = await withFeed(t, {
      [FEED]: feed(timed('a@google.com', 'Daily', start, 'LOCATION:https://meet.google.com/x-y-z')),
    });
    const good = await readSince(plugin);
    await events(plugin);
    const refused = await plugin.call('update_settings', {
      calendarUrl: `calendar.google.com/${SECRET}/basic.ics`,
    });
    const failing = await nobodyThere();
    await plugin.call('update_settings', { calendarUrl: failing });
    const bad = await readSince(plugin, good.at);
    await events(plugin);
    await plugin.call('get_settings');

    assert.equal(good.count, 1);
    assert.notEqual(bad.problem, null);
    assert.match(refused.error?.message ?? '', /^update_settings: calendarUrl is not in its form/);
    const seen = [...plugin.lines(), plugin.output()].join('\n');
    for (const secretPart of [address, failing, SECRET, FEED, encodeURIComponent(FEED)]) {
      assert.ok(!seen.includes(secretPart), `${secretPart} was shown`);
    }
  },
);

test('the address is read again every SCRIBE_CALENDAR_READ_MS', async (t) => {
  const now = Date.now();
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  const routes: Record<string, Route> = {
    [FEED]: feed(timed('a@google.com', 'Daily', now + HOUR, link)),
  };
  const { plugin } = await withFeed(t, routes, { SCRIBE_CALENDAR_READ_MS: '100' });
  await eventsUntil(plugin, (listed) => listed.length === 1);

  routes[FEED] = feed(
    timed('a@google.com', 'Daily', now + HOUR, link),
    timed('b@google.com', 'Added today', now + 2 * HOUR, link),
  );
  const found = await eventsUntil(plugin, (listed) => listed.length === 2);

  assert.deepEqual(found.map((event) => event.name), ['Daily', 'Added today']);
});

test('get_settings says the address is set, never what it is, and null clears it', async (t) => {
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      timed('a@google.com', 'Daily', Date.now() + HOUR, 'LOCATION:https://meet.google.com/x-y-z'),
    ),
  });
  await eventsUntil(plugin, (listed) => listed.length === 1);

  const set = await secret(plugin);
  const cleared = await plugin.call('update_settings', { calendarUrl: null });
  const after = structureOf<{ settings: { calendarUrl: Secret } }>(cleared).settings.calendarUrl;

  assert.deepEqual(
    { ...set, read: { count: set.read?.count, problem: set.read?.problem } },
    {
      set: true,
      saved: true,
      from: 'file',
      variable: 'SCRIBE_CALENDAR_URL',
      problem: null,
      ignored: null,
      read: { count: 1, problem: null },
    },
  );
  assert.deepEqual(
    { set: after.set, saved: after.saved, from: after.from, read: after.read },
    { set: false, saved: false, from: 'default', read: null },
  );
  assert.deepEqual(await events(plugin), []);
});

test('SCRIBE_CALENDAR_URL beats the file; one not in its form is ignored, unshown', async (t) => {
  const served = await serveFiles(t, {
    [FEED]: feed(
      timed('a@google.com', 'Daily', Date.now() + HOUR, 'LOCATION:https://meet.google.com/x-y-z'),
    ),
  });
  const plugin = await startedAndShaken(t, { env: { SCRIBE_CALENDAR_URL: served.url(FEED) } });
  const wrong = await startedAndShaken(t, {
    env: { SCRIBE_CALENDAR_URL: `not an address ${SECRET}` },
  });

  const found = await eventsUntil(plugin, (listed) => listed.length === 1);
  const fromVariable = await secret(plugin);
  const ignored = await secret(wrong);

  assert.deepEqual(found.map((event) => event.name), ['Daily']);
  assert.equal(fromVariable.from, 'environment');
  assert.equal(fromVariable.set, true);
  assert.equal(fromVariable.saved, false);
  assert.equal(ignored.set, false);
  assert.match(ignored.ignored ?? '', /^SCRIBE_CALENDAR_URL is set, which is not/);
  assert.ok(!JSON.stringify(ignored).includes(SECRET));
  assert.ok(![...wrong.lines(), wrong.output()].join('\n').includes(SECRET));
});

const DAY = 24 * HOUR;

/** The two letters iCal names a weekday by, for the UTC day of `ms`. */
function weekday(ms: number): string {
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(ms).getUTCDay()] ?? '';
}

/** An instant to the second, as list_events tells it. */
function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

test('a weekly Event with BYDAY gives its next time, and none after UNTIL', async (t) => {
  const start = Date.now() + HOUR;
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  // The first time is two days before the weekday the test looks for, three
  // weeks ago: only BYDAY brings the series to today's weekday.
  const first = start - 3 * 7 * DAY - 2 * DAY;
  const weekly = `RRULE:FREQ=WEEKLY;BYDAY=${weekday(first)},${weekday(start)}`;
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      timed('one@google.com', '1:1', first, link, `${weekly};UNTIL=${utc(start + 7 * DAY)}`),
      timed('ended@google.com', 'Ended', first, link, `${weekly};UNTIL=${utc(start - DAY)}`),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(
    found.map((event) => [event.name, event.start, event.end]),
    [['1:1', iso(start), iso(start + HOUR)]],
  );
});

test('COUNT and INTERVAL are kept; a daily and a monthly rule give their time', async (t) => {
  const start = Date.now() + HOUR;
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  const date = new Date(start);
  // The same day of the month, four years ago, is a day every month of that
  // year that has it, and Feb 29 too.
  const yearsAgo = Date.UTC(
    date.getUTCFullYear() - 4,
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  );
  // The same numbered weekday of a month before, as "the second Tuesday".
  const nth = Math.ceil(date.getUTCDate() / 7);
  let sameNth = start - 5 * 7 * DAY;
  while (Math.ceil(new Date(sameNth).getUTCDate() / 7) !== nth) sameNth -= 7 * DAY;
  const daily = 'RRULE:FREQ=DAILY';
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      timed('daily@google.com', 'Daily', start - 10 * DAY, link, 'RRULE:FREQ=DAILY'),
      timed('two@google.com', 'Every 2 days', start - 4 * DAY, link, `${daily};INTERVAL=2`),
      timed('off@google.com', 'Off day', start - 3 * DAY, link, `${daily};INTERVAL=2`),
      timed('six@google.com', 'Sixth time', start - 5 * DAY, link, 'RRULE:FREQ=DAILY;COUNT=6'),
      timed('five@google.com', 'Five times', start - 5 * DAY, link, 'RRULE:FREQ=DAILY;COUNT=5'),
      timed('month@google.com', 'Monthly', yearsAgo, link, 'RRULE:FREQ=MONTHLY'),
      timed(
        'nth@google.com',
        'Monthly by weekday',
        sameNth,
        link,
        `RRULE:FREQ=MONTHLY;BYDAY=${nth}${weekday(start)}`,
      ),
      timed(
        'fortnight@google.com',
        'Off week',
        start - 7 * DAY,
        link,
        `RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=${weekday(start)}`,
      ),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(
    found.map((event) => event.name).sort(),
    ['Daily', 'Every 2 days', 'Monthly', 'Monthly by weekday', 'Sixth time'],
  );
  assert.deepEqual(new Set(found.map((event) => event.start)), new Set([iso(start)]));
});

test('an EXDATE takes its time out; a RECURRENCE-ID moves it, or cancels it', async (t) => {
  const start = Math.floor((Date.now() + HOUR) / MINUTE) * MINUTE;
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  // São Paulo is UTC-3 all year: its wall time is known from the test's own now.
  const wall = (ms: number): string => utc(ms - 3 * HOUR).replace('Z', '');
  const zone = 'TZID=America/Sao_Paulo';
  const zoned = (uid: string, name: string, at: number, ...more: readonly string[]): string =>
    vevent(
      `UID:${uid}`,
      `DTSTART;${zone}:${wall(at)}`,
      `DTEND;${zone}:${wall(at + HOUR)}`,
      `SUMMARY:${name}`,
      link,
      ...more,
    );
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      // The moved time comes before its Series in the feed, as Google may write it.
      zoned('moved@google.com', 'Moved', start + 2 * HOUR, `RECURRENCE-ID;${zone}:${wall(start)}`),
      zoned('moved@google.com', 'Moved', start - 5 * DAY, 'RRULE:FREQ=DAILY'),
      zoned(
        'excluded@google.com',
        'Excluded',
        start - 5 * DAY,
        'RRULE:FREQ=DAILY',
        `EXDATE;${zone}:${wall(start - DAY)},${wall(start)}`,
      ),
      zoned('cancelled@google.com', 'Cancelled', start - 5 * DAY, 'RRULE:FREQ=DAILY'),
      zoned(
        'cancelled@google.com',
        'Cancelled',
        start,
        `RECURRENCE-ID;${zone}:${wall(start)}`,
        'STATUS:CANCELLED',
      ),
      zoned(
        'kept@google.com',
        'Kept',
        start - 5 * DAY,
        'RRULE:FREQ=DAILY',
        `EXDATE;${zone}:${wall(start - DAY)}`,
      ),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(
    found.map((event) => [event.name, event.start, event.end]),
    [
      ['Kept', iso(start), iso(start + HOUR)],
      ['Moved', iso(start + 2 * HOUR), iso(start + 3 * HOUR)],
    ],
  );
});

test('a TZID keeps the wall time of a weekly Event across daylight saving time', async (t) => {
  const start = Math.floor((Date.now() + HOUR) / MINUTE) * MINUTE;
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  const zone = 'America/New_York';
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  /** The wall time in New York of an instant, as numbers. */
  const wallIn = (ms: number): Record<string, number> =>
    Object.fromEntries(
      format.formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]),
    );
  const at = wallIn(start);
  // Some weeks back, the same instant has another hour in New York: the
  // first time is on the other side of a change of daylight saving time.
  let weeks = 1;
  while (wallIn(start - weeks * 7 * DAY)['hour'] === at['hour']) weeks += 1;
  // The first time is the same wall time, that many weeks back on the wall calendar.
  const firstDay = new Date(
    Date.UTC(at['year'] ?? 0, (at['month'] ?? 0) - 1, (at['day'] ?? 0) - weeks * 7),
  );
  const two = (number: number | undefined): string => String(number).padStart(2, '0');
  const wall =
    `${firstDay.getUTCFullYear()}${two(firstDay.getUTCMonth() + 1)}${two(firstDay.getUTCDate())}` +
    `T${two(at['hour'])}${two(at['minute'])}00`;
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      vevent(
        'UID:stand-up@google.com',
        `DTSTART;TZID=${zone}:${wall}`,
        'SUMMARY:Stand-up',
        link,
        'RRULE:FREQ=WEEKLY',
      ),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(found.map((event) => [event.name, event.start]), [['Stand-up', iso(start)]]);
});

test('a rule scribe does not read gives no Event, not a guessed one', async (t) => {
  const start = Date.now() + HOUR;
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  const unread = [
    'RRULE:FREQ=YEARLY',
    'RRULE:FREQ=HOURLY',
    `RRULE:FREQ=WEEKLY;BYDAY=${weekday(start)};BYSETPOS=1`,
    `RRULE:FREQ=WEEKLY;BYDAY=2${weekday(start)}`,
    'RRULE:FREQ=DAILY;COUNT=0',
    'RRULE:FREQ=DAILY;INTERVAL=two',
    `RRULE:FREQ=DAILY;COUNT=3;UNTIL=${utc(start + DAY)}`,
  ];
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      ...unread.map((rule, at) => timed(`unread-${at}@google.com`, rule, start, link, rule)),
      timed('read@google.com', 'Read', start + HOUR, link, 'RRULE:FREQ=DAILY'),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(found.map((event) => event.name), ['Read']);
});

test('a rule that never comes back gives no time, and list_events answers', async (t) => {
  const start = Date.now() + HOUR;
  const link = 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij';
  const { plugin } = await withFeed(t, {
    [FEED]: feed(
      // Every twelfth month from a February is a February, which has no 30th.
      timed(
        'never@google.com',
        'Never',
        Date.UTC(2020, 1, 1, 12),
        link,
        'RRULE:FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=30',
      ),
      timed('read@google.com', 'Read', start, link),
    ),
  });

  const found = await eventsUntil(plugin, (listed) => listed.length > 0);

  assert.deepEqual(found.map((event) => event.name), ['Read']);
});
