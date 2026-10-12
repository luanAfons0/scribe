/**
 * A Notice a minute before each Event, sent through the Host as a
 * `firstmate/notice` request on stdout. The test plays the Host: it serves a
 * feed from the local server, saves its address as the operator does, reads
 * every request scribe puts to the Host, and answers each Notice as the Host
 * answers it.
 *
 * The lead comes from `SCRIBE_NOTICE_LEAD_MS`, so a test waits seconds and not
 * a minute.
 */
import { strict as assert } from 'node:assert';
import test, { type TestContext } from 'node:test';
import {
  startedAndShaken,
  structureOf,
  type HostQuestion,
  type Started,
} from './helpers/plugin.ts';
import { FEED, HOUR, MEET, MINUTE, feed, timed, withFeed } from './helpers/calendar.ts';

/** The method a Notice is sent with. */
const NOTICE = 'firstmate/notice';

/** The second sentence of every Notice's body, as the approved design words it. */
const RECORD_IT = 'To record it, start a Call in scribe.';

/** A moment cut to the whole second, as the feed carries it. */
function whole(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/** A time of day as the Notice says it: 14:05, in this machine's time zone. */
function hhmm(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** The Notices scribe has put to the Host so far. */
function notices(plugin: Started): HostQuestion[] {
  return plugin.questions().filter((question) => question.method === NOTICE);
}

/** The next Notice scribe puts to the Host, answered as the Host takes it. */
async function nextNotice(plugin: Started): Promise<{ notice: HostQuestion; at: number }> {
  const notice = await plugin.nextQuestion();
  const at = Date.now();
  assert.equal(notice.method, NOTICE);
  plugin.answerAsHost(notice.id, { result: {} });
  return { notice, at };
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

test('an Event gets one Notice, the lead before it starts', async (t) => {
  const lead = 2_000;
  const start = whole(Date.now() + 4_000);
  const { plugin } = await withFeed(
    t,
    { [FEED]: feed(timed('a@google.com', 'Sprint review', start, MEET)) },
    {
      SCRIBE_NOTICE_LEAD_MS: String(lead),
    },
  );

  const { notice, at } = await nextNotice(plugin);

  assert.deepEqual(notice.params, {
    title: 'Sprint review in 1 min',
    body: `Starts at ${hhmm(start)} on Google Meet. ${RECORD_IT}`,
    path: '#upcoming',
  });
  assert.ok(at >= start - lead - 100, `the Notice came ${start - at} ms before the Event`);
  assert.ok(at < start, `the Notice came ${at - start} ms after the Event started`);
});

test('two Events at the same time give two Notices, at least 5 s apart', async (t) => {
  const start = whole(Date.now() + 5 * MINUTE);
  const { plugin } = await withFeed(
    t,
    {
      [FEED]: feed(
        timed('a@google.com', 'Sprint review', start, MEET),
        timed('b@google.com', 'Retro', start, MEET),
      ),
    },
    { SCRIBE_NOTICE_LEAD_MS: String(10 * MINUTE) },
  );

  const first = await nextNotice(plugin);
  const second = await nextNotice(plugin);

  assert.deepEqual([first.notice.params['title'], second.notice.params['title']].sort(), [
    'Retro in 5 min',
    'Sprint review in 5 min',
  ]);
  assert.ok(second.at - first.at >= 5_000, `${second.at - first.at} ms apart`);
});

test('an Event given a Notice gets no second one after the calendar is read again', async (t) => {
  const start = whole(Date.now() + 5 * MINUTE);
  const { plugin } = await withFeed(
    t,
    { [FEED]: feed(timed('a@google.com', 'Sprint review', start, MEET)) },
    {
      SCRIBE_NOTICE_LEAD_MS: String(10 * MINUTE),
      SCRIBE_CALENDAR_READ_MS: '100',
    },
  );

  await nextNotice(plugin);
  const read = structureOf<{
    settings: { calendarUrl: { read: { at: string } } };
  }>(await plugin.call('get_settings')).settings.calendarUrl.read.at;
  await wait(1_500);
  const readAgain = structureOf<{
    settings: { calendarUrl: { read: { at: string } } };
  }>(await plugin.call('get_settings')).settings.calendarUrl.read.at;

  assert.ok(readAgain > read, 'the calendar was not read again');
  assert.equal(notices(plugin).length, 1);
});

test('a calendar that cannot be read sends no Notice', async (t) => {
  const { plugin } = await withFeed(
    t,
    { [FEED]: 500 },
    { SCRIBE_NOTICE_LEAD_MS: String(10 * MINUTE) },
  );

  for (;;) {
    const { read } = structureOf<{
      settings: { calendarUrl: { read: { problem: string | null } | null } };
    }>(await plugin.call('get_settings')).settings.calendarUrl;
    if (read !== null) {
      assert.notEqual(read.problem, null);
      break;
    }
    await wait(25);
  }
  await wait(1_500);

  assert.deepEqual(notices(plugin), []);
});
