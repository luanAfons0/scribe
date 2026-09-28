/**
 * A Call: one recording, from Start to Stop, with its Jottings, its
 * Transcript and its Minutes.
 *
 * A Call is `recording`, `ended` (someone pressed Stop) or `cut` (its page or
 * its Plugin Server went away first). Only one Call records at a time, which
 * the Store holds as a unique index, so two Calls never mix.
 */
import type { Store } from './store.ts';

/** Where a Call stands. */
export type CallState = 'recording' | 'ended' | 'cut';

/** One Call as the list shows it: no Jottings, Transcript or Minutes. */
export type CallSummary = {
  readonly id: number;
  /** The title, or null until one is proposed or given: the page shows the date. */
  readonly title: string | null;
  readonly state: CallState;
  readonly startedAt: string;
  readonly endedAt: string | null;
};

type CallRow = {
  readonly id: number;
  readonly title: string | null;
  readonly state: CallState;
  readonly started_at: string;
  readonly ended_at: string | null;
};

/** Every Call, newest first. */
export function listCalls(store: Store): readonly CallSummary[] {
  const rows = store
    .prepare('SELECT id, title, state, started_at, ended_at FROM calls ORDER BY started_at DESC, id DESC')
    .all() as CallRow[];
  return rows.map(summaryOf);
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
