/**
 * A Call started for an Event takes the Event's name as a title the operator
 * gave: from five minutes before the Event until it ends, and of two such
 * Events, the one that started last. The test serves a feed from the local
 * server, with times relative to its own now, and starts a Call as the Page
 * does.
 */
import { strict as assert } from 'node:assert';
import test, { type TestContext } from 'node:test';
import { getCall, pcm, send, startCall, until, type Call } from './helpers/audio.ts';
import { minutesCommand, startedAndShaken, structureOf, type Started } from './helpers/plugin.ts';
import { serveFiles } from './helpers/server.ts';

/** The path the feed is served at, shaped as Google shapes a secret address. */
const FEED = '/calendar/ical/operador%40example.com/private-5a4b3c2d1e0f98765/basic.ics';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A Call, with the Event it was started for. */
type EventCall = Call & { readonly event: { name: string; start: string } | null };

/** A time as iCal writes it in UTC: 20261012T140000Z. */
function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** A time as scribe tells it, read back from the whole second the feed holds. */
function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/** An Event with a Meet link, from `start` to `end`. */
function timed(uid: string, name: string, start: number, end = start + HOUR): string {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${utc(start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${name}`,
    'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
    'END:VEVENT',
  ].join('\r\n');
}

/** A whole feed of these VEVENTs, as Google writes it. */
function feed(...events: readonly string[]): Buffer {
  return Buffer.from(
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'X-WR-CALNAME:operador@example.com',
      ...events,
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  );
}

/** A Plugin Server that has read this feed from its saved address. */
async function withFeed(
  t: TestContext,
  served: Buffer,
  env: Readonly<Record<string, string>> = {},
): Promise<Started> {
  const server = await serveFiles(t, { [FEED]: served });
  const plugin = await startedAndShaken(t, { env });
  const saved = await plugin.call('update_settings', { calendarUrl: server.url(FEED) });
  assert.equal(saved.error, undefined, saved.error?.message);
  const started = Date.now();
  for (;;) {
    const { settings } = structureOf<{
      settings: { calendarUrl: { read: { count: number | null } | null } };
    }>(await plugin.call('get_settings'));
    if (settings.calendarUrl.read !== null) return plugin;
    if (Date.now() - started > 5_000) throw new Error(`never read\n${plugin.output()}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** Start a Call, and hand it back whole. */
async function started(plugin: Started): Promise<EventCall> {
  return (await getCall(plugin, await startCall(plugin))) as EventCall;
}

test('a Call started five minutes before an Event takes its name as a given title', async (t) => {
  const start = Date.now() + 4 * MINUTE;
  const plugin = await withFeed(t, feed(timed('a@google.com', 'Sprint review', start)));

  const call = await started(plugin);

  assert.equal(call.title, 'Sprint review');
  assert.deepEqual(call.event, { name: 'Sprint review', start: iso(start) });
});

test('during two Events at once, the Call takes the one that started last', async (t) => {
  const now = Date.now();
  const plugin = await withFeed(
    t,
    feed(
      timed('a@google.com', 'Planning', now - 30 * MINUTE),
      timed('b@google.com', '1:1 com a Ana', now - 10 * MINUTE),
      timed('c@google.com', 'Almoço do time', now - 20 * MINUTE),
    ),
  );

  const call = await started(plugin);

  assert.equal(call.title, '1:1 com a Ana');
  assert.deepEqual(call.event, { name: '1:1 com a Ana', start: iso(now - 10 * MINUTE) });
});

test('an Event that starts within five minutes beats one that runs', async (t) => {
  const now = Date.now();
  const plugin = await withFeed(
    t,
    feed(
      timed('a@google.com', 'Planning', now - 50 * MINUTE),
      timed('b@google.com', 'Sprint review', now + 3 * MINUTE),
    ),
  );

  const call = await started(plugin);

  assert.equal(call.title, 'Sprint review');
});

test('the Minutes do not replace the title of a Call started for an Event', async (t) => {
  const plugin = await withFeed(
    t,
    feed(timed('a@google.com', 'Sprint review', Date.now() + MINUTE)),
    { SCRIBE_MINUTES_COMMAND: minutesCommand() },
  );
  const id = (await started(plugin)).id;
  await plugin.call('save_jottings', { id, jottings: '# Prazo\nentrega sexta' });
  await send(plugin, id, 'tab', pcm([{ seconds: 1, level: 4000 }]));
  await plugin.call('stop_call', { id });

  const call = (await until(plugin, id, (seen) => seen.minutesState === 'made')) as EventCall;

  assert.ok(call.minutes?.startsWith('## Prazo'), call.minutes ?? '');
  assert.equal(call.title, 'Sprint review');
  assert.equal(call.event?.name, 'Sprint review');
});

test(
  'a Call started more than five minutes before an Event, or after one, has no title',
  async (t) => {
    const now = Date.now();
    const plugin = await withFeed(
      t,
      feed(
        timed('a@google.com', 'Sprint review', now + 6 * MINUTE),
        timed('b@google.com', 'Planning', now - 2 * HOUR, now - MINUTE),
      ),
    );

    const call = await started(plugin);

    assert.equal(call.title, null);
    assert.equal(call.event, null);
  },
);

test('with no calendar address, a Call has no title and no Event', async (t) => {
  const plugin = await startedAndShaken(t);

  const call = await started(plugin);

  assert.equal(call.title, null);
  assert.equal(call.event, null);
});

test('list_calls says which Event each Call was for, and nothing more of it', async (t) => {
  const start = Date.now() + 2 * MINUTE;
  const plugin = await withFeed(t, feed(timed('a@google.com', 'Sprint review', start)));
  await started(plugin);

  const { calls } = structureOf<{ calls: { title: string; event: unknown }[] }>(
    await plugin.call('list_calls'),
  );
  const answer = JSON.stringify(await plugin.call('get_call', { id: 1 }));

  assert.deepEqual(
    calls.map(({ title, event }) => ({ title, event })),
    [{ title: 'Sprint review', event: { name: 'Sprint review', start: iso(start) } }],
  );
  assert.ok(!answer.includes('meet.google.com'), 'the Meet link is on the Call');
  assert.ok(!answer.includes('private-'), "the calendar's address is on the Call");
});

test('an Event with no name leaves the title to the Minutes', async (t) => {
  const start = Date.now() + MINUTE;
  const plugin = await withFeed(
    t,
    feed(timed('a@google.com', 'X', start).replace('SUMMARY:X\r\n', '')),
    { SCRIBE_MINUTES_COMMAND: minutesCommand() },
  );
  const id = (await started(plugin)).id;
  await plugin.call('save_jottings', { id, jottings: '# Prazo\nentrega sexta' });
  await plugin.call('stop_call', { id });

  const call = (await until(plugin, id, (seen) => seen.minutesState === 'made')) as EventCall;

  assert.equal(call.title, 'Prazo da entrega');
  assert.deepEqual(call.event, { name: '', start: iso(start) });
});
