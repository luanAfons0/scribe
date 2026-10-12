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
import type { Made } from './minutes.ts';
import { now, type Store } from './store.ts';

/** Where a Call stands. */
export type CallState = 'recording' | 'ended' | 'cut';

/** Who said a Transcript line, as far as scribe can tell: by track alone. */
export type Speaker = 'Você' | 'Outros';

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
  /** When the Topics last went to Worklog, or null while they never did. */
  readonly sentToWorklogAt: string | null;
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
  /** The Topics the command wrote with the Minutes, for Worklog. */
  readonly topics: string | null;
  /** The id Worklog gave this Call's Entry, once one was sent. */
  readonly entryId: number | null;
  /** Why the last Entry could not be sent to Worklog, when it could not. */
  readonly entryError: string | null;
  /** Whether the Topics are on their way to Worklog now. */
  readonly sendingToWorklog: boolean;
  /**
   * Whether the Minutes wrote other Topics after the last good send, so
   * Worklog holds an old version of them.
   */
  readonly topicsChangedSinceSent: boolean;
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
  readonly topics: string | null;
  readonly entry_id: number | null;
  readonly entry_error: string | null;
  readonly entry_sent_at: string | null;
  readonly topics_written_at: string | null;
};

const SPEAKERS: Readonly<Record<Track, Speaker>> = { mic: 'Você', tab: 'Outros' };

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
export function viewOf(
  store: Store,
  id: number,
  transcribing: boolean,
  sendingToWorklog = false,
): CallView {
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
    topics: row.topics,
    entryId: row.entry_id,
    entryError: row.entry_error,
    sendingToWorklog,
    topicsChangedSinceSent: changedSinceSent(row),
  };
}

/** Mark a Call's Minutes as being made, or as failed with the reason why. */
export function setMinutesState(
  store: Store,
  id: number,
  state: 'none' | 'making' | 'failed',
  error: string | null = null,
): void {
  store
    .prepare('UPDATE calls SET minutes_state = ?, minutes_error = ? WHERE id = ?')
    .run(state, error, id);
}

/**
 * Keep the Minutes a command made, with its Topics, and its title unless the
 * operator gave the Call one of their own. The time the Topics were written
 * moves only when they are not the ones there were, so Minutes made again
 * with the same Topics do not count as a change since they were sent.
 */
export function keepMinutes(store: Store, id: number, made: Made): void {
  store
    .prepare(
      "UPDATE calls SET minutes = ?, topics = ?, minutes_state = 'made', minutes_error = NULL, " +
        'topics_written_at = CASE WHEN topics IS ? THEN topics_written_at ELSE ? END, ' +
        'title = CASE WHEN title_given = 1 OR ? IS NULL THEN title ELSE ? END WHERE id = ?',
    )
    .run(made.minutes, made.topics, made.topics, now(), made.title, made.title, id);
}

/**
 * Keep the id of the Entry Worklog made for a Call and when it took the
 * Topics, and forget any old error.
 */
export function keepEntry(store: Store, id: number, entryId: number): void {
  store
    .prepare('UPDATE calls SET entry_id = ?, entry_sent_at = ?, entry_error = NULL WHERE id = ?')
    .run(entryId, now(), id);
}

/** Say why a Call's Entry could not be sent to Worklog. */
export function setEntryError(store: Store, id: number, error: string): void {
  store.prepare('UPDATE calls SET entry_error = ? WHERE id = ?').run(error, id);
}

/** Minutes left `making` by a Plugin Server that went away: they never came. */
export function forgetUnfinishedMinutes(store: Store): void {
  store
    .prepare(
      "UPDATE calls SET minutes_state = 'failed', minutes_error = ? WHERE minutes_state = 'making'",
    )
    .run('The Plugin Server stopped while the Minutes were made. Make them again.');
}

/** The longest title kept: one line a list can show. */
const MOST_TITLE = 200;

/** The longest Minutes kept, by hand or by a command. */
const MOST_MINUTES = 200_000;

/** Give a Call a title of the operator's own, which no proposal replaces. */
export function renameCall(store: Store, id: number, title: string): CallSummary {
  rowOf(store, id);
  const row = store
    .prepare('UPDATE calls SET title = ?, title_given = 1 WHERE id = ? RETURNING *')
    .get(title, id) as CallRow;
  return summaryOf(row);
}

/** Keep Minutes written or corrected by hand, in place of what was there. */
export function saveMinutes(store: Store, id: number, minutes: string): void {
  const row = rowOf(store, id);
  if (row.minutes_state === 'making') {
    throw badInput(`The Minutes of Call ${id} are being made. Save yours when that is done.`);
  }
  store
    .prepare(
      "UPDATE calls SET minutes = ?, minutes_state = 'made', minutes_error = NULL WHERE id = ?",
    )
    .run(minutes, id);
}

/** Delete a Call with its Jottings, its Transcript and its Minutes. */
export function deleteCall(store: Store, id: number): { readonly id: number } {
  const row = rowOf(store, id);
  if (row.state === 'recording') {
    throw badInput(`Call ${id} is still recording. Stop it before you delete it.`);
  }
  store.prepare('DELETE FROM calls WHERE id = ?').run(id);
  return { id };
}

/** A title as given, or a sentence that says what a title is. */
export function checkTitle(given: unknown): string {
  const title = typeof given === 'string' ? given.trim() : '';
  if (title === '' || title.includes('\n') || title.length > MOST_TITLE) {
    throw badInput(
      `rename_call needs "title" as one line of text, at most ${MOST_TITLE} characters.`,
    );
  }
  return title;
}

/** Minutes as given, or a sentence that says what they are. */
export function checkMinutes(given: unknown): string {
  if (typeof given !== 'string' || given.length > MOST_MINUTES) {
    throw badInput(
      `save_minutes needs "minutes" as Markdown text, at most ${MOST_MINUTES} characters.`,
    );
  }
  return given;
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

/**
 * Whether the Topics were written after they last went to Worklog. A send
 * keeps the Topics it was started with, and the Minutes cannot be made while
 * a send runs, so no Topics are written between the start of a send and the
 * time it keeps.
 */
function changedSinceSent(row: CallRow): boolean {
  if (row.entry_sent_at === null || row.topics_written_at === null) return false;
  return row.topics_written_at > row.entry_sent_at;
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
    sentToWorklogAt: row.entry_sent_at,
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
