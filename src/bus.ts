/**
 * The Tool Bus, from this end of the pipe.
 *
 * A Plugin Server calls another Plugin's tool by writing one JSON-RPC request
 * on its own stdout and reading the answer by the id it sent (FirstMate
 * ADR-0009). There is no token and no port here: the Host spawned this
 * process, owns both ends, and checks the Grant itself.
 *
 * When scribe stops waiting, nothing is cancelled: the other Plugin Server
 * keeps working and its late answer is dropped on arrival, without a word.
 */
import { reply } from './mcp.ts';

/**
 * How much longer than this end will wait the Host is asked to wait, so that
 * scribe's own timer is the one that fires and says what happened.
 */
const HOST_MARGIN_MS = 5_000;

/** What came back from the Host, as one of three things and never two. */
export type BusResult =
  | { readonly kind: 'answered'; readonly result: unknown }
  | { readonly kind: 'refused'; readonly said: string }
  | { readonly kind: 'timed-out' };

type Answered = {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

/** Whoever here is waiting for the Host, by the id it asked with. */
const owed = new Map<string, (answer: Answered) => void>();
let counter = 0;

/**
 * Hand the Host's answer to whoever asked for it. An answer nobody is owed is
 * the late answer to a call this end gave up on, and is dropped.
 */
export function receive(message: Readonly<Record<string, unknown>>): void {
  const answered = owed.get(String(message['id']));
  if (answered === undefined) return;
  owed.delete(String(message['id']));
  answered(message as Answered);
}

/** Ask the Host to call one tool of another Plugin, under a Grant. */
export function callPlugin(
  plugin: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  waitMs: number,
): Promise<BusResult> {
  return askHost(
    'firstmate/tools/call',
    { plugin, name, arguments: args, timeoutMs: waitMs + HOST_MARGIN_MS },
    waitMs,
  );
}

/**
 * Put one request to the Host on stdout, and read its answer by the id it was
 * sent with: a tool call over the Tool Bus, or a Notice.
 */
export function askHost(
  method: string,
  params: Readonly<Record<string, unknown>>,
  waitMs: number,
): Promise<BusResult> {
  const id = `scribe-${(counter += 1)}`;
  return new Promise<BusResult>((done) => {
    const timer = setTimeout(() => {
      owed.delete(id);
      done({ kind: 'timed-out' });
    }, waitMs);

    owed.set(id, (answer) => {
      clearTimeout(timer);
      if (answer.error !== undefined) done({ kind: 'refused', said: answer.error.message });
      else done({ kind: 'answered', result: answer.result });
    });

    reply({ jsonrpc: '2.0', id, method, params });
  });
}
