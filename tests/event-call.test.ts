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
import { FEED, HOUR, MEET, MINUTE, feed, readSince, timed, withFeed } from './helpers/calendar.ts';

/** A Call, with the Event it was started for. */
type EventCall = Call & {
  readonly event: { name: string; start: string } | null;
};

/** A time as scribe tells it, read back from the whole second the feed holds. */
function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/** A Plugin Server that has read this feed from its saved address. */
async function withFeedRead(
  t: TestContext,
  served: Buffer,
  env: Readonly<Record<string, string>> = {},
): Promise<Started> {
  const { plugin } = await withFeed(t, { [FEED]: served }, env);
  await readSince(plugin);
  return plugin;
}

/** Start a Call, and hand it back whole. */
async function started(plugin: Started): Promise<EventCall> {
  return (await getCall(plugin, await startCall(plugin))) as EventCall;
}

test('a Call started five minutes before an Event takes its name as a given title', async (t) => {
  const start = Date.now() + 4 * MINUTE;
  const plugin = await withFeedRead(t, feed(timed('a@google.com', 'Sprint review', start, MEET)));

  const call = await started(plugin);

  assert.equal(call.title, 'Sprint review');
  assert.deepEqual(call.event, { name: 'Sprint review', start: iso(start) });
});

test('during two Events at once, the Call takes the one that started last', async (t) => {
  const now = Date.now();
  const plugin = await withFeedRead(
    t,
    feed(
      timed('a@google.com', 'Planning', now - 30 * MINUTE, MEET),
      timed('b@google.com', '1:1 com a Ana', now - 10 * MINUTE, MEET),
      timed('c@google.com', 'Almoço do time', now - 20 * MINUTE, MEET),
    ),
  );

  const call = await started(plugin);

  assert.equal(call.title, '1:1 com a Ana');
  assert.deepEqual(call.event, {
    name: '1:1 com a Ana',
    start: iso(now - 10 * MINUTE),
  });
});

test('an Event that starts within five minutes beats one that runs', async (t) => {
  const now = Date.now();
  const plugin = await withFeedRead(
    t,
    feed(
      timed('a@google.com', 'Planning', now - 50 * MINUTE, MEET),
      timed('b@google.com', 'Sprint review', now + 3 * MINUTE, MEET),
    ),
  );

  const call = await started(plugin);

  assert.equal(call.title, 'Sprint review');
});

test('the Minutes do not replace the title of a Call started for an Event', async (t) => {
  const plugin = await withFeedRead(
    t,
    feed(timed('a@google.com', 'Sprint review', Date.now() + MINUTE, MEET)),
    { SCRIBE_MINUTES_COMMAND: minutesCommand() },
  );
  const id = (await started(plugin)).id;
  await plugin.call('save_jottings', {
    id,
    jottings: '# Prazo\nentrega sexta',
  });
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
    const plugin = await withFeedRead(
      t,
      feed(
        timed('a@google.com', 'Sprint review', now + 6 * MINUTE, MEET),
        timed('b@google.com', 'Planning', now - 2 * HOUR, MEET),
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
  const plugin = await withFeedRead(t, feed(timed('a@google.com', 'Sprint review', start, MEET)));
  await started(plugin);

  const { calls } = structureOf<{ calls: { title: string; event: unknown }[] }>(
    await plugin.call('list_calls'),
  );
  const answer = JSON.stringify(await plugin.call('get_call', { id: 1 }));

  assert.deepEqual(
    calls.map(({ title, event }) => ({ title, event })),
    [
      {
        title: 'Sprint review',
        event: { name: 'Sprint review', start: iso(start) },
      },
    ],
  );
  assert.ok(!answer.includes('meet.google.com'), 'the Meet link is on the Call');
  assert.ok(!answer.includes('private-'), "the calendar's address is on the Call");
});

test('an Event with no name leaves the title to the Minutes', async (t) => {
  const start = Date.now() + MINUTE;
  const plugin = await withFeedRead(
    t,
    feed(timed('a@google.com', 'X', start, MEET).replace('SUMMARY:X\r\n', '')),
    { SCRIBE_MINUTES_COMMAND: minutesCommand() },
  );
  const id = (await started(plugin)).id;
  await plugin.call('save_jottings', {
    id,
    jottings: '# Prazo\nentrega sexta',
  });
  await plugin.call('stop_call', { id });

  const call = (await until(plugin, id, (seen) => seen.minutesState === 'made')) as EventCall;

  assert.equal(call.title, 'Prazo da entrega');
  assert.deepEqual(call.event, { name: '', start: iso(start) });
});
