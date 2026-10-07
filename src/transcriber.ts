/**
 * The Transcript as it is made: the windows of every Call, given to
 * whisper.cpp one at a time, and the lines it heard kept in `scribe.db`.
 *
 * One window at a time, because whisper.cpp takes every core it is given, and
 * `small` with 8 threads reads 30 s of audio in about 8 s on this machine, so
 * one queue keeps up with both tracks of a live Call. The settings are the
 * ones measured: Portuguese, greedy decoding. A window's file is deleted as
 * soon as Whisper has read it, whether it heard anything or not.
 */
import { forget, spokenBetween, type Window } from './audio.ts';
import { sentenceFor } from './mcp.ts';
import { run } from './run.ts';
import type { Settings } from './settings.ts';
import { within, type Store } from './store.ts';

/** How many threads whisper.cpp is given: what was measured to keep up. */
const THREADS = 8;

/** A window may take this long before whisper.cpp is given up on. */
const WHISPER_TIMEOUT_MS = 10 * 60_000;

/** The Transcript in the making, over one Store. */
export type Transcriber = {
  /** Give one window to Whisper, after every window given before it. */
  give(window: Window): void;
  /** Whether a Call still has windows that Whisper has not read. */
  busyWith(callId: number): boolean;
};

/** One line whisper-cli prints: `[00:00:01.000 --> 00:00:04.500]   text`. */
const LINE = /^\[(\d+):(\d\d):(\d\d)\.(\d{3}) --> (\d+):(\d\d):(\d\d)\.(\d{3})\]\s*(.*)$/;

/**
 * The Transcriber. `idle` is told each time a Call has no window left, which
 * is when what comes after the Transcript may start.
 */
export function transcriberFor(
  store: Store,
  settings: Settings,
  idle: (callId: number) => void,
): Transcriber {
  const queue: Window[] = [];
  const owed = new Map<number, number>();
  let running = false;

  const next = (): void => {
    const window = queue.shift();
    if (window === undefined) {
      running = false;
      return;
    }
    running = true;
    // A Call deleted while its windows waited has no audio left to read, and
    // one deleted while Whisper read it took the file away: neither is news.
    const gone = (): boolean =>
      store.prepare('SELECT 1 FROM calls WHERE id = ?').get(window.callId) === undefined;
    // A fault here — Whisper's, or keeping what it heard — loses one window
    // and says so in the journal. It never takes the Plugin Server down, and
    // the windows after it are still read.
    (gone() ? Promise.resolve([]) : hear(settings, window))
      .then((lines) => keep(store, window, lines.filter((line) => heardOn(window, line))))
      .catch((fault: unknown) => {
        if (gone()) return;
        process.stderr.write(
          `scribe: a window of Call ${window.callId} was not transcribed: ` +
            `${sentenceFor(fault)}\n`,
        );
      })
      .finally(() => {
        forget(window.path);
        const left = (owed.get(window.callId) ?? 1) - 1;
        if (left > 0) owed.set(window.callId, left);
        else {
          owed.delete(window.callId);
          try {
            idle(window.callId);
          } catch (fault) {
            process.stderr.write(
              `scribe: Call ${window.callId} was heard, and what comes next failed: ` +
                `${sentenceFor(fault)}\n`,
            );
          }
        }
        next();
      });
  };

  return {
    give(window) {
      owed.set(window.callId, (owed.get(window.callId) ?? 0) + 1);
      queue.push(window);
      if (!running) next();
    },
    busyWith: (callId) => owed.has(callId),
  };
}

type Heard = { readonly startMs: number; readonly endMs: number; readonly text: string };

/** What whisper.cpp heard in one window, each line timed within it. */
function hear(settings: Settings, window: Window): Promise<readonly Heard[]> {
  const args = [
    '-m', settings.model,
    '-l', 'pt',
    '-t', String(THREADS),
    '-bs', '1',
    '-bo', '1',
    '-np',
    // Tokens such as [MÚSICA] are not words anyone said.
    '-sns',
    '-f', window.path,
  ];
  return run({ program: settings.whisper, args }, { timeoutMs: WHISPER_TIMEOUT_MS }).then(
    (ran) => {
      if (ran.timedOut) {
        throw new Error(`whisper.cpp ran longer than ${WHISPER_TIMEOUT_MS / 60_000} minutes.`);
      }
      if (ran.code !== 0) {
        const said = ran.stderr.trim().split('\n').pop() ?? '';
        throw new Error(said === '' ? `whisper.cpp exited with ${ran.code}.` : said);
      }
      return parse(ran.stdout);
    },
  );
}

function parse(stdout: string): readonly Heard[] {
  const heard: Heard[] = [];
  for (const line of stdout.split('\n')) {
    const found = LINE.exec(line.trim());
    if (found === null) continue;
    const text = (found[9] ?? '').trim();
    // A line that is only a sound, [MÚSICA DE FUNDO] or (risos), is not
    // something anyone said, and the Transcript is what was said.
    if (text === '' || /^[[(][^\])]*[\])]$/.test(text)) continue;
    const n = found.slice(1, 9).map(Number);
    heard.push({
      startMs: ((n[0]! * 60 + n[1]!) * 60 + n[2]!) * 1000 + n[3]!,
      endMs: ((n[4]! * 60 + n[5]!) * 60 + n[6]!) * 1000 + n[7]!,
      text,
    });
  }
  return heard;
}

/** Keep what was heard as Transcript lines, unless the Call is gone. */
/**
 * Whether a line Whisper wrote has speech under it. Only the mic is checked:
 * it carries the room between your words, and Whisper reads the room as
 * words. A line on the tab is the call itself.
 */
function heardOn(window: Window, line: Heard): boolean {
  return window.track !== 'mic' || spokenBetween(window, line.startMs, line.endMs);
}

function keep(store: Store, window: Window, heard: readonly Heard[]): void {
  within(store, () => {
    const call = store.prepare('SELECT id FROM calls WHERE id = ?').get(window.callId);
    if (call === undefined) return;
    const insert = store.prepare(
      'INSERT INTO lines (call_id, track, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
    );
    for (const line of heard) {
      insert.run(
        window.callId,
        window.track,
        window.startMs + line.startMs,
        window.startMs + line.endMs,
        line.text,
      );
    }
  });
}
