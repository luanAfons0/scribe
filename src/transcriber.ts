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
import { execFile } from 'node:child_process';
import { forget, type Window } from './audio.ts';
import { sentenceFor } from './mcp.ts';
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
    hear(settings, window).then(
      (lines) => keep(store, window, lines),
      (fault) => {
        process.stderr.write(
          `scribe: whisper.cpp could not read a window of Call ${window.callId}: ` +
            `${sentenceFor(fault)}\n`,
        );
      },
    ).finally(() => {
      forget(window.path);
      const left = (owed.get(window.callId) ?? 1) - 1;
      if (left > 0) owed.set(window.callId, left);
      else {
        owed.delete(window.callId);
        idle(window.callId);
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
    '-f', window.path,
  ];
  return new Promise((done, fail) => {
    execFile(
      settings.whisper,
      args,
      { timeout: WHISPER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (fault, stdout, stderr) => {
        if (fault !== null) {
          const said = stderr.trim().split('\n').pop() ?? '';
          fail(new Error(said === '' ? fault.message : said));
          return;
        }
        done(parse(stdout));
      },
    );
  });
}

function parse(stdout: string): readonly Heard[] {
  const heard: Heard[] = [];
  for (const line of stdout.split('\n')) {
    const found = LINE.exec(line.trim());
    if (found === null) continue;
    const text = (found[9] ?? '').trim();
    if (text === '') continue;
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
