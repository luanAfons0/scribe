/**
 * The Plugin Server starts, answers the Host, and says what it can do.
 *
 * Everything here goes through the one seam: the real `mcp` executable against
 * a temporary Plugin directory, spoken to as the Host speaks to it.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  PROTOCOL_VERSION,
  startedAndShaken,
  startPluginServer,
  structureOf,
} from './helpers/plugin.ts';

/** Every tool scribe ships. The names are the contract with the Page. */
const TOOLS = ['append_audio', 'get_call', 'list_calls', 'start_call', 'stop_call'];

test('the Plugin Server answers the handshake', async (t) => {
  const plugin = await startPluginServer(t);

  const answer = await plugin.handshake();

  const result = answer.result as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(answer.error, undefined, plugin.output());
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(result.serverInfo.name, 'scribe');
});

test('it names every tool it ships, each with a schema for its arguments', async (t) => {
  const plugin = await startedAndShaken(t);

  const answer = await plugin.ask('tools/list');

  const { tools } = answer.result as {
    tools: { name: string; description: string; inputSchema: { type: string } }[];
  };
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOLS].sort());
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name} says nothing about itself`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('a new Plugin has no Calls', async (t) => {
  const plugin = await startedAndShaken(t);

  const listed = structureOf<{ calls: unknown[] }>(await plugin.call('list_calls'));

  assert.deepEqual(listed.calls, []);
});

test('nothing but JSON-RPC goes to stdout', async (t) => {
  const plugin = await startedAndShaken(t);
  await plugin.ask('tools/list');
  await plugin.call('list_calls');
  await plugin.call('no_such_tool', {});
  await plugin.ask('no/such/method');

  for (const line of plugin.lines()) {
    const message = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(message.jsonrpc, '2.0', `this line on stdout is not JSON-RPC: ${line}`);
  }
});

test('a line on stdin that is not JSON is one sentence on stderr, and the pipe survives it', async (t) => {
  const plugin = await startedAndShaken(t);
  const said = plugin.lines().length;

  plugin.raw('this is not JSON');
  const answer = await plugin.ask('tools/list');
  // stderr and stdout are two pipes, so the sentence may land a moment after
  // the answer that was written later.
  for (let waited = 0; !plugin.output().includes('was not JSON') && waited < 2000; waited += 20) {
    await new Promise((done) => setTimeout(done, 20));
  }

  assert.ok(plugin.output().includes('was not JSON'), `stderr said: ${plugin.output()}`);
  assert.ok(plugin.output().startsWith('scribe: '), `stderr said: ${plugin.output()}`);
  assert.equal(plugin.lines().length, said + 1, 'the bad line was answered on stdout');
  assert.equal(answer.error, undefined);
});

test('a method it does not have is refused with a sentence naming it', async (t) => {
  const plugin = await startedAndShaken(t);

  const answer = await plugin.ask('tools/nonsense');

  assert.equal(answer.error?.code, -32601);
  assert.ok(answer.error?.message.includes('tools/nonsense'), answer.error?.message);
});

test('a tool it does not have is refused with a sentence naming it', async (t) => {
  const plugin = await startedAndShaken(t);

  const answer = await plugin.call('polish_boots');

  assert.equal(answer.error?.code, -32602);
  assert.ok(answer.error?.message.includes('polish_boots'), answer.error?.message);
});

test('closing stdin is how the Host stops it, and it goes quietly', async (t) => {
  const plugin = await startedAndShaken(t);
  await plugin.call('list_calls');

  plugin.stop();

  const ending = await plugin.ended();
  assert.equal(ending.code, 0);
  assert.equal(plugin.output(), '');
});
