/**
 * The one test seam for the Plugin Server: the real `mcp`, spawned against a
 * temporary Plugin directory, spoken to exactly as the Host speaks to it.
 *
 * Nothing here imports a module of the Plugin. What a test may see is what the
 * Host may see: the JSON-RPC lines on stdout, the diagnostics on stderr, the
 * exit code, and the files the Plugin writes into its own directory. That is
 * what lets the whole inside of this Plugin be rewritten without touching a
 * test.
 *
 * The Host starts a Plugin Server in the Plugin's own directory, so a test
 * gives it a temporary one. The code still comes from this repository; only
 * the directory the Plugin keeps `scribe.db` in is temporary.
 *
 * whisper.cpp and the Minutes command are fixture executables in
 * `tests/fixtures/`, reached through the same settings the Host would pass.
 * Every Plugin Server a test starts gets the fixture whisper and model unless
 * the test says otherwise, and no Minutes command unless it names one.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

const TESTS = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = dirname(TESTS);

/** Where the fixture executables and files live. */
export const FIXTURES = join(TESTS, 'fixtures');

/** The settings a Plugin Server gets unless a test gives its own. */
const SETTINGS: Readonly<Record<string, string>> = {
  SCRIBE_WHISPER: join(FIXTURES, 'whisper'),
  SCRIBE_WHISPER_MODEL: join(FIXTURES, 'model.bin'),
  SCRIBE_MINUTES_COMMAND: '',
};

/** The `mcp` executable the Host would run. Tests run the same file. */
export const EXECUTABLE = join(REPOSITORY, 'mcp');

/** The protocol version the Host sends in its handshake. */
export const PROTOCOL_VERSION = '2025-06-18';

/** How long a test waits for one answer before it gives up. */
const ANSWER_TIMEOUT_MS = 10_000;

/** One answer to one JSON-RPC request: exactly one of these two is there. */
export type Answer = {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

export type StartOptions = {
  /** Added to the Plugin Server's environment, over the fixture settings. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The Plugin directory to start in. Without one, a fresh temporary one. A
   * test that restarts the Plugin Server passes the directory of the first.
   */
  readonly directory?: string;
};

export type Ending = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type Started = {
  /** The Plugin directory the Plugin Server runs in. */
  readonly directory: string;
  /** Send the handshake the Host sends, and hand back its answer. */
  handshake(): Promise<Answer>;
  /** One JSON-RPC request, answered by the id it was sent with. */
  ask(method: string, params?: unknown): Promise<Answer>;
  /** One `tools/call`, the way the Host forwards a Page's call. */
  call(name: string, args?: Readonly<Record<string, unknown>>): Promise<Answer>;
  /** One JSON-RPC notification, which is never answered. */
  notify(method: string, params?: unknown): void;
  /** One line written byte for byte, for a line that is not JSON at all. */
  raw(line: string): void;
  /** Every line the Plugin Server has written on stdout, as it wrote it. */
  lines(): readonly string[];
  /** Everything the Plugin Server has written on stderr. */
  output(): string;
  /** What the Plugin Server exited as, once it has. */
  ended(within?: number): Promise<Ending>;
  /** Close stdin, which is how the Host asks a Plugin Server to stop. */
  stop(): void;
  /** Kill the Plugin Server outright, as a crash would. */
  kill(): void;
};

/** A temporary Plugin directory for one test, removed when the test ends. */
export async function makeDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scribe-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Start the real Plugin Server against a Plugin directory. It is stopped when
 * the test ends, whatever the test did.
 */
export async function startPluginServer(
  t: TestContext,
  options: StartOptions = {},
): Promise<Started> {
  const directory = options.directory ?? (await makeDirectory(t));

  const child = spawn(EXECUTABLE, [], {
    cwd: directory,
    env: { ...process.env, ...SETTINGS, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  let output = '';
  let pending = '';
  let counter = 0;
  /** Whoever here is waiting for the Plugin Server, by the id it was asked with. */
  const owed = new Map<string, (answer: Answer) => void>();

  let ending: Ending | null = null;
  const ended = new Promise<Ending>((done) => {
    child.once('error', (fault) => (output += `the Plugin Server could not be run: ${fault.message}\n`));
    child.once('exit', (code, signal) => {
      ending = { code, signal };
      // Nobody is going to answer now. Fail the waiting tests rather than
      // leave them hanging until the whole suite times out.
      for (const [id, answered] of owed) {
        answered({ error: { code: 0, message: `the Plugin Server exited before answering ${id}` } });
      }
      owed.clear();
      done(ending);
    });
  });

  const send = (message: unknown): void => {
    child.stdin!.write(`${JSON.stringify(message)}\n`);
  };

  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim() === '') continue;
      lines.push(line);
      receive(line);
    }
  });

  function receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not JSON. A test reads it off `lines()` and says so itself.
      return;
    }
    const answered = owed.get(String(message['id']));
    if (answered === undefined) return;
    owed.delete(String(message['id']));
    answered(message as Answer);
  }

  t.after(async () => {
    child.stdin!.end();
    child.kill('SIGTERM');
    if (ending === null) await ended;
  });

  function askFor(method: string, params?: unknown): Promise<Answer> {
    const id = `test-${(counter += 1)}`;
    return new Promise<Answer>((answered, fail) => {
      const timer = setTimeout(() => {
        owed.delete(id);
        fail(new Error(`the Plugin Server did not answer ${method} in ${ANSWER_TIMEOUT_MS} ms.\n${output}`));
      }, ANSWER_TIMEOUT_MS);
      owed.set(id, (answer) => {
        clearTimeout(timer);
        answered(answer);
      });
      send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  return {
    directory,
    handshake: async () => {
      const answer = await askFor('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { firstmate: { toolBus: {} } } },
        clientInfo: { name: 'firstmate', version: '1.0.0' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return answer;
    },
    ask: askFor,
    call: (name, args = {}) => askFor('tools/call', { name, arguments: args }),
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    raw: (line) => child.stdin!.write(`${line}\n`),
    lines: () => lines,
    output: () => output,
    ended: (within = ANSWER_TIMEOUT_MS) =>
      Promise.race([
        ended,
        new Promise<never>((_, fail) =>
          setTimeout(
            () => fail(new Error(`the Plugin Server was still up after ${within} ms.\n${output}`)),
            within,
          ).unref(),
        ),
      ]),
    stop: () => child.stdin!.end(),
    kill: () => child.kill('SIGKILL'),
  };
}

/** A Plugin Server that has answered the handshake, ready for tool calls. */
export async function startedAndShaken(
  t: TestContext,
  options: StartOptions = {},
): Promise<Started> {
  const plugin = await startPluginServer(t, options);
  const answer = await plugin.handshake();
  if (answer.error !== undefined) {
    throw new Error(`the handshake was refused: ${answer.error.message}\n${plugin.output()}`);
  }
  return plugin;
}

/** The structured half of an MCP result, which is what the Page draws. */
export function structureOf<T = unknown>(answer: Answer): T {
  if (answer.error !== undefined) {
    throw new Error(`the tool was refused: ${answer.error.message}`);
  }
  const result = answer.result as { structuredContent?: unknown } | undefined;
  return result?.structuredContent as T;
}

/** The text of an MCP result, which is what a terminal and a Run keep. */
export function textOf(answer: Answer): string {
  const result = answer.result as { content?: { type: string; text: string }[] } | undefined;
  return (result?.content ?? []).map((part) => part.text).join('');
}
