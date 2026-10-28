/**
 * The Plugin Release: what `npm run release` writes into `release/`, and that
 * it runs as the Host runs it (FirstMate ADR-0033).
 *
 * The build is run for real. The Release Files are copied into a temporary
 * Plugin directory, so that they are all the Plugin Server has, and `mcp.js` is
 * started there by the running Node with no shell, as the Host does.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { cp, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeDirectory, startPluginServer } from './helpers/plugin.ts';

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const RELEASE = join(REPOSITORY, 'release');

before(() => {
  execFileSync(process.execPath, [join(REPOSITORY, 'scripts', 'release.ts')], {
    cwd: REPOSITORY,
    stdio: 'pipe',
  });
});

test('release/ holds mcp.js, web/ and mcp, and no source', async () => {
  const names = (await readdir(RELEASE)).sort();
  assert.deepEqual(names, ['downloads.json', 'mcp', 'mcp.js', 'web']);
});

test('release/ holds no mcp.ts, no src/, and none of the Plugin\'s data', async () => {
  const names = await readdir(RELEASE);
  for (const kept of ['mcp.ts', 'src', 'scribe.db', 'settings.json', 'audio']) {
    assert.ok(!names.includes(kept), `release/ holds ${kept}`);
  }
});

test('mcp.js answers initialize and tools/list like mcp.ts', async (t) => {
  const directory = await makeDirectory(t);
  await cp(RELEASE, directory, { recursive: true });
  const built = await startPluginServer(t, { directory, entry: join(directory, 'mcp.js') });
  const source = await startPluginServer(t, { entry: join(REPOSITORY, 'mcp.ts') });

  const shaken = await built.handshake();
  assert.equal(shaken.error, undefined, built.output());
  await source.handshake();

  const tools = await built.ask('tools/list');
  assert.equal(tools.error, undefined, built.output());
  assert.deepEqual(tools.result, (await source.ask('tools/list')).result);
});

test(
  'the mcp wrapper of the release runs mcp.js',
  { skip: process.platform === 'win32' ? 'the sh wrapper `mcp` is for a wsl Place' : false },
  async (t) => {
    const directory = await makeDirectory(t);
    await cp(RELEASE, directory, { recursive: true });
    const plugin = await startPluginServer(t, {
      directory,
      entry: join(directory, 'mcp'),
      wrapper: true,
      env: { SCRIBE_NODE: process.execPath },
    });
    const answer = await plugin.handshake();
    assert.equal(answer.error, undefined, plugin.output());
  },
);
