/**
 * A Call's Topics go to the Worklog Plugin over the Tool Bus, as one `Done`
 * Entry, only when the operator sends them: making the Minutes sends nothing.
 * The test plays the Host: it reads the question the Plugin Server puts to it
 * and answers as Worklog would, or as a Host with no Grant would, or not at
 * all.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getCall, pcm, send, startCall, until, type Call } from './helpers/audio.ts';
import {
  minutesCommand,
  startedAndShaken,
  structureOf,
  type Answer,
  type Started,
} from './helpers/plugin.ts';

const ZONE = 'America/Sao_Paulo';

const SETTINGS = {
  SCRIBE_MINUTES_COMMAND: minutesCommand(),
  SCRIBE_WORKLOG_PLUGIN: 'worklog',
  TZ: ZONE,
};

/** What Worklog's create_entry answers: the Entry, with the id it was given. */
function entry(id: number): { result: unknown } {
  return { result: { content: [{ type: 'text', text: '{}' }], structuredContent: { id } } };
}

/** A Call with Jottings and a line on the mic, stopped. */
async function stoppedCall(plugin: Started): Promise<number> {
  const id = await startCall(plugin);
  await plugin.call('save_jottings', { id, jottings: '# Segredo\nsó meu' });
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  await plugin.call('stop_call', { id });
  return id;
}

/** A stopped Call whose Minutes, and so its Topics, are made. */
async function madeCall(plugin: Started): Promise<number> {
  const id = await stoppedCall(plugin);
  await until(plugin, id, (seen) => seen.minutesState === 'made');
  return id;
}

/** Press Send to Worklog, as the Page does, and hand back what it answered. */
async function sendToWorklog(plugin: Started, id: number): Promise<Answer> {
  return plugin.call('send_to_worklog', { id });
}

/** A moment as the clock in that zone shows it: `14:05`. */
function clock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** Give the Plugin Server a moment to ask anything it was going to. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 300));
}

test('making the Minutes sends nothing to Worklog', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await madeCall(plugin);

  await settle();
  const call = await getCall(plugin, id);

  assert.deepEqual(plugin.questions(), []);
  assert.ok(call.topics !== null, 'the Minutes wrote no Topics');
  assert.equal(call.sentToWorklogAt, null);
  assert.equal(call.entryId, null);
  assert.equal(call.entryError, null);
});

test('Send to Worklog sends one Done Entry with the times, the title and the Topics', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await madeCall(plugin);

  const pressed = structureOf<{ call: Call }>(await sendToWorklog(plugin, id)).call;
  const question = await plugin.nextQuestion();
  plugin.answerAsHost(question.id, entry(7));
  const call = await until(plugin, id, (seen) => seen.sentToWorklogAt !== null);
  const listed = structureOf<{ calls: Call[] }>(await plugin.call('list_calls')).calls;

  assert.equal(pressed.sendingToWorklog, true);
  assert.equal(pressed.sentToWorklogAt, null);
  assert.equal(question.method, 'firstmate/tools/call');
  assert.equal(question.params['plugin'], 'worklog');
  assert.equal(question.params['name'], 'create_entry');
  assert.deepEqual(question.params['arguments'], {
    title: `Reunião ${clock(call.startedAt)} - ${clock(call.endedAt ?? '')}: Prazo da entrega`,
    body: '- Prazo da entrega\n\nCombinamos a entrega para sexta.',
    status: 'Done',
  });
  assert.equal(plugin.questions().length, 1);
  assert.equal(call.entryId, 7);
  assert.equal(call.entryError, null);
  assert.equal(call.sendingToWorklog, false);
  assert.ok(Date.parse(call.sentToWorklogAt ?? '') >= Date.parse(call.endedAt ?? ''));
  assert.equal(listed[0]?.sentToWorklogAt, call.sentToWorklogAt);
});

test('nothing but the title, the times and the Topics leaves scribe', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await madeCall(plugin);

  await sendToWorklog(plugin, id);
  const question = await plugin.nextQuestion();

  const sent = JSON.stringify(question.params);
  assert.ok(!sent.includes('Segredo'), 'the Jottings went to Worklog');
  assert.ok(!sent.includes('tone 3000'), 'the Transcript went to Worklog');
  assert.ok(!sent.includes('Decisões'), 'the Minutes went to Worklog');
});

test('a Call that records is refused with a sentence', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await startCall(plugin);

  const answer = await sendToWorklog(plugin, id);

  assert.ok(answer.error?.message.includes('still recording'), answer.error?.message);
  assert.deepEqual(plugin.questions(), []);
});

test('a Call with no Topics is refused with a sentence', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { ...SETTINGS, SCRIBE_TEST_TOPICS: 'none' },
  });
  const id = await madeCall(plugin);

  const answer = await sendToWorklog(plugin, id);

  assert.ok(answer.error?.message.includes('no Topics'), answer.error?.message);
  assert.deepEqual(plugin.questions(), []);
});

test('with no Worklog Plugin set, a send is refused with a sentence that names the setting', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { ...SETTINGS, SCRIBE_WORKLOG_PLUGIN: '' },
  });
  const id = await madeCall(plugin);

  const answer = await sendToWorklog(plugin, id);

  assert.ok(answer.error?.message.includes('worklogPlugin'), answer.error?.message);
  assert.deepEqual(plugin.questions(), []);
});

test('a second send while one runs is refused, so one Call never makes two Entries', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await madeCall(plugin);

  await sendToWorklog(plugin, id);
  const question = await plugin.nextQuestion();
  const second = await sendToWorklog(plugin, id);
  plugin.answerAsHost(question.id, entry(7));
  await until(plugin, id, (seen) => seen.sentToWorklogAt !== null);

  assert.ok(second.error?.message.includes('already'), second.error?.message);
  assert.equal(plugin.questions().length, 1);
});

test('making the Minutes while the Topics are on their way is refused', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await madeCall(plugin);

  await sendToWorklog(plugin, id);
  const question = await plugin.nextQuestion();
  const remade = await plugin.call('make_minutes', { id });
  plugin.answerAsHost(question.id, entry(7));
  const call = await until(plugin, id, (seen) => seen.sentToWorklogAt !== null);

  assert.ok(remade.error?.message.includes('being sent to Worklog'), remade.error?.message);
  assert.equal(call.minutesState, 'made');
});

test('with no Grant, the Call stays unsent and says which command to run', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await madeCall(plugin);

  await sendToWorklog(plugin, id);
  const question = await plugin.nextQuestion();
  plugin.answerAsHost(question.id, {
    error: {
      code: -32602,
      message: 'The Plugin named scribe holds no Grant to call the Plugin named worklog.',
    },
  });
  const call = await until(plugin, id, (seen) => seen.entryError !== null);

  assert.equal(call.minutesState, 'made');
  assert.equal(call.entryId, null);
  assert.equal(call.sentToWorklogAt, null);
  assert.equal(call.sendingToWorklog, false);
  assert.ok(call.entryError?.includes('firstmate grant scribe worklog'), call.entryError ?? '');
});

test('a Worklog that does not answer in time leaves a sentence, and its late answer is dropped', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { ...SETTINGS, SCRIBE_WORKLOG_WAIT_MS: '200' },
  });
  const id = await madeCall(plugin);

  await sendToWorklog(plugin, id);
  const question = await plugin.nextQuestion();
  const timedOut = await until(plugin, id, (seen) => seen.entryError !== null);
  plugin.answerAsHost(question.id, entry(9));
  await settle();
  const call = await getCall(plugin, id);

  assert.equal(question.params['timeoutMs'], 5200);
  assert.ok(timedOut.entryError?.includes('did not answer in 200 ms'), timedOut.entryError ?? '');
  assert.equal(call.entryId, null, 'a late answer was kept');
  assert.equal(call.sentToWorklogAt, null);
  assert.equal(plugin.output(), '');
});

test('a Cut Call can be sent once its Minutes are made', async (t) => {
  const plugin = await startedAndShaken(t, {
    env: { ...SETTINGS, SCRIBE_CUT_AFTER_MS: '300' },
  });
  const id = await startCall(plugin);
  await send(plugin, id, 'mic', pcm([{ seconds: 1, level: 3000 }]));
  await until(plugin, id, (seen) => seen.state === 'cut' && !seen.transcribing);
  await plugin.call('make_minutes', { id });
  await until(plugin, id, (seen) => seen.minutesState === 'made');

  await sendToWorklog(plugin, id);
  const question = await plugin.nextQuestion();
  plugin.answerAsHost(question.id, entry(3));
  const call = await until(plugin, id, (seen) => seen.sentToWorklogAt !== null);

  assert.equal(question.params['name'], 'create_entry');
  assert.equal(call.entryId, 3);
});

test('a Call with no Minutes yet has no Entry', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await startCall(plugin);

  const call = await getCall(plugin, id);

  assert.equal(call.entryId, null);
  assert.equal(call.entryError, null);
  assert.equal(call.sentToWorklogAt, null);
  assert.equal(call.sendingToWorklog, false);
});

/** A Call whose first Entry Worklog took, as id 7. */
async function sentCall(plugin: Started): Promise<number> {
  const id = await madeCall(plugin);
  await sendToWorklog(plugin, id);
  const first = await plugin.nextQuestion();
  plugin.answerAsHost(first.id, entry(7));
  await until(plugin, id, (seen) => seen.sentToWorklogAt !== null);
  return id;
}

test('a Call sent again changes the same Entry rather than add one', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await sentCall(plugin);
  const before = await getCall(plugin, id);

  await sendToWorklog(plugin, id);
  const question = await plugin.nextQuestion();
  plugin.answerAsHost(question.id, entry(7));
  const call = await until(plugin, id, (seen) => seen.sentToWorklogAt !== before.sentToWorklogAt);

  assert.equal(question.params['name'], 'update_entry');
  const sent = question.params['arguments'] as Record<string, unknown>;
  assert.equal(sent['id'], 7);
  assert.ok(String(sent['title']).endsWith(': Prazo da entrega'), String(sent['title']));
  assert.equal(sent['body'], '- Prazo da entrega\n\nCombinamos a entrega para sexta.');
  assert.equal(sent['status'], undefined, 'the Status is the operator’s to move');
  assert.equal(plugin.questions().length, 2);
  assert.equal(call.entryId, 7);
  assert.equal(call.entryError, null);
});

test('an Entry deleted in Worklog is made again, under its new id', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await sentCall(plugin);

  await sendToWorklog(plugin, id);
  const update = await plugin.nextQuestion();
  plugin.answerAsHost(update.id, { error: { code: -32602, message: 'No Entry has the id 7.' } });
  const create = await plugin.nextQuestion();
  plugin.answerAsHost(create.id, entry(12));
  const call = await until(plugin, id, (seen) => seen.entryId === 12);

  assert.equal(update.params['name'], 'update_entry');
  assert.equal(create.params['name'], 'create_entry');
  assert.equal((create.params['arguments'] as Record<string, unknown>)['status'], 'Done');
  assert.equal(call.entryError, null);
});

test('any other refusal keeps the Entry id and says why', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await sentCall(plugin);
  const before = await getCall(plugin, id);

  await sendToWorklog(plugin, id);
  const update = await plugin.nextQuestion();
  plugin.answerAsHost(update.id, {
    error: { code: -32603, message: 'database is locked' },
  });
  const call = await until(plugin, id, (seen) => seen.entryError !== null);
  await settle();

  assert.equal(plugin.questions().length, 2, 'scribe made a second Entry');
  assert.equal(call.entryId, 7);
  assert.equal(call.sentToWorklogAt, before.sentToWorklogAt);
  assert.ok(call.entryError?.includes('database is locked'), call.entryError ?? '');
});

test('a send that works clears the sentence an earlier one left', async (t) => {
  const plugin = await startedAndShaken(t, { env: SETTINGS });
  const id = await madeCall(plugin);
  await sendToWorklog(plugin, id);
  const first = await plugin.nextQuestion();
  plugin.answerAsHost(first.id, {
    error: { code: -32602, message: 'The Plugin named worklog is Stopped.' },
  });
  await until(plugin, id, (seen) => seen.entryError !== null);

  await sendToWorklog(plugin, id);
  const second = await plugin.nextQuestion();
  plugin.answerAsHost(second.id, entry(4));
  const call = await until(plugin, id, (seen) => seen.sentToWorklogAt !== null);

  assert.equal(second.params['name'], 'create_entry');
  assert.equal(call.entryId, 4);
  assert.equal(call.entryError, null);
});
