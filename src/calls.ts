/**
 * A Call: one recording, from Start to Stop, with its Jottings, its
 * Transcript and its Minutes.
 *
 * A Call is `recording`, `ended` (someone pressed Stop) or `cut` (its page or
 * its Plugin Server went away first). Only one Call records at a time, which
 * the Store holds as a unique index, so two Calls never mix.
 */
import type { Track } from './audio.ts';
import { badInput } from './mcp.ts';
import { now, type Store } from './store.ts';

/** Where a Call stands. */
export type CallState = 'recording' | 'ended' | 'cut';

/** Who said a Transcript line, as far as scribe can tell: by track alone. */
export type Speaker = 'Eu' | 'Outros';

/** Where the Minutes of a Call stand. */
export type MinutesState = 'none' | 'making' | 'made' | 'failed';

/** One Call as the list shows it: no Jottings, Transcript or Minutes. */
export type CallSummary = {
  readonly id: number;
  /** The title, or null until one is proposed or given: the page shows the date. */
  readonly title: string | null;
  readonly state: CallState;
  readonly startedAt: string;
  readonly endedAt: string | null;
};

/** One line of a Transcript, timed from the start of its Call. */
export type TranscriptLine = {
  readonly speaker: Speaker;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
};

/** One Call, whole, as get_call answers it. */
export type CallView = CallSummary & {
  readonly jottings: string;
  readonly transcript: readonly TranscriptLine[];
  /** Whether Whisper still has audio of this Call to read. */
  readonly transcribing: boolean;
  readonly minutes: string | null;
  readonly minutesState: MinutesState;
  /** Why the Minutes could not be made, when they could not. */
  readonly minutesError: string | null;
};

type CallRow = {
  readonly id: number;
  readonly title: string | null;
  readonly state: CallState;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly jottings: string;
  readonly minutes: string | null;
  readonly minutes_state: MinutesState;
  readonly minutes_error: string | null;
};

const SPEAKERS: Readonly<Record<Track, Speaker>> = { mic: 'Eu', tab: 'Outros' };

/** Every Call, newest first. */
export function listCalls(store: Store): readonly CallSummary[] {
  const rows = store
    .prepare('SELECT * FROM calls ORDER BY started_at DESC, id DESC')
    .all() as CallRow[];
  return rows.map(summaryOf);
}

/** The Call that is recording now, if one is. */
export function recordingCall(store: Store): CallSummary | null {
  const row = store.prepare("SELECT * FROM calls WHERE state = 'recording'").get() as
    | CallRow
    | undefined;
  return row === undefined ? null : summaryOf(row);
}

/** Start a Call, or refuse with a sentence that names the one that records. */
export function startCall(store: Store): CallSummary {
  const running = recordingCall(store);
  if (running !== null) {
    throw badInput(
      `${nameOf(running)} is still recording. Stop it before you start another Call.`,
    );
  }
  const row = store
    .prepare("INSERT INTO calls (state, started_at) VALUES ('recording', ?) RETURNING *")
    .get(now()) as CallRow;
  return summaryOf(row);
}

/** End a Call that records: `ended` by Stop, or `cut` when it went away. */
export function endCall(store: Store, id: number, state: 'ended' | 'cut'): CallSummary {
  const row = store
    .prepare(
      "UPDATE calls SET state = ?, ended_at = ? WHERE id = ? AND state = 'recording' RETURNING *",
    )
    .get(state, now(), id) as CallRow | undefined;
  if (row === undefined) throw badInput(`Call ${id} is not recording.`);
  return summaryOf(row);
}

/** One Call, whole, or a sentence that says there is no such Call. */
export function viewOf(store: Store, id: number, transcribing: boolean): CallView {
  const row = rowOf(store, id);
  const lines = store
    .prepare(
      'SELECT track, start_ms, end_ms, text FROM lines WHERE call_id = ? ' +
        "ORDER BY start_ms, CASE track WHEN 'tab' THEN 0 ELSE 1 END, id",
    )
    .all(id) as { track: Track; start_ms: number; end_ms: number; text: string }[];
  return {
    ...summaryOf(row),
    jottings: row.jottings,
    transcript: lines.map((line) => ({
      speaker: SPEAKERS[line.track],
      startMs: line.start_ms,
      endMs: line.end_ms,
      text: line.text,
    })),
    transcribing,
    minutes: row.minutes,
    minutesState: row.minutes_state,
    minutesError: row.minutes_error,
  };
}

/** The longest Jottings kept: far more than anyone types in a Call. */
const MOST_JOTTINGS = 200_000;

/** Keep a Call's Jottings, whole, in place of what was there. */
export function saveJottings(
  store: Store,
  id: number,
  jottings: string,
): { readonly id: number; readonly jottings: string } {
  rowOf(store, id);
  store.prepare('UPDATE calls SET jottings = ? WHERE id = ?').run(jottings, id);
  return { id, jottings };
}

/** Jottings as given, or a sentence that says what they are. */
export function checkJottings(given: unknown): string {
  if (typeof given !== 'string') {
    throw badInput('save_jottings needs "jottings" as a string: the whole text, every time.');
  }
  if (given.length > MOST_JOTTINGS) {
    throw badInput(`save_jottings takes at most ${MOST_JOTTINGS} characters of Jottings.`);
  }
  return given;
}

/** One Call's row, or a sentence that says there is no such Call. */
function rowOf(store: Store, id: number): CallRow {
  const row = store.prepare('SELECT * FROM calls WHERE id = ?').get(id) as CallRow | undefined;
  if (row === undefined) throw badInput(`There is no Call ${id}. list_calls names every Call.`);
  return row;
}

/** A Call as a sentence names it: its title, or its number and when it started. */
function nameOf(call: CallSummary): string {
  return call.title === null
    ? `Call ${call.id}, started at ${call.startedAt},`
    : `Call ${call.id} ("${call.title}")`;
}

function summaryOf(row: CallRow): CallSummary {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** A Call's id as given, or a sentence that says what an id is. */
export function checkCallId(tool: string, given: unknown): number {
  if (typeof given === 'number' && Number.isSafeInteger(given) && given > 0) return given;
  throw badInput(
    `${tool} takes "id" as the number list_calls gives each Call, and was given ` +
      `${JSON.stringify(given)}.`,
  );
}
