/**
 * The `mcp` wrapper finds a Node 24 where the Host's service PATH has none.
 *
 * The Host runs under systemd with a PATH that holds only the distribution's
 * Node, which is too old to run TypeScript or to have node:sqlite. These tests
 * give the wrapper exactly that PATH and a home directory with no nvm in it,
 * so the only Node 24 it can find is the one a test names.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { makeDirectory, startPluginServer } from './helpers/plugin.ts';

/** `mcp` is `sh`, which Windows has no use for: the Host runs `mcp.ts` there. */
const NO_SH = {
  skip: process.platform === 'win32' ? 'the sh wrapper `mcp` is for a wsl Place' : false,
};

/** The PATH a systemd user service gets: no nvm, no login shell. */
const SERVICE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

test('the wrapper runs the Node that SCRIBE_NODE names when PATH has none new enough', NO_SH, async (t) => {
  const home = await makeDirectory(t);
  const plugin = await startPluginServer(t, {
    wrapper: true,
    env: { PATH: SERVICE_PATH, HOME: home, SCRIBE_NODE: process.execPath },
  });

  const answer = await plugin.handshake();

  assert.equal(answer.error, undefined, plugin.output());
});

test('with no Node 24 anywhere, the wrapper says so in one sentence that names SCRIBE_NODE', NO_SH, async (t) => {
  const home = await makeDirectory(t);
  const plugin = await startPluginServer(t, {
    wrapper: true,
    env: { PATH: SERVICE_PATH, HOME: home, SCRIBE_NODE: '' },
  });

  const ending = await plugin.ended();

  assert.notEqual(ending.code, 0);
  const said = plugin.output().trim();
  assert.ok(said.includes('SCRIBE_NODE'), `stderr said: ${said}`);
  assert.ok(said.startsWith('scribe: '), `stderr said: ${said}`);
  assert.equal(said.split('\n').length, 1, `stderr said more than one line: ${said}`);
  assert.equal(plugin.lines().length, 0, 'something reached stdout');
});
