/**
 * What scribe reads from its environment: where whisper.cpp and its model are,
 * and which command makes the Minutes.
 *
 * The Host starts the Plugin Server with the environment it was started with,
 * so these are set where the Host is started: the systemd unit, or the shell.
 * Whisper is what the Plugin is for, so a missing executable or model is one
 * sentence and an exit at start, and the Plugin shows Stopped. The Minutes
 * command is not: with none set, a Call still records and its Transcript is
 * still made, and only Make Minutes is refused (ADR-0002). Worklog is not
 * either: with no Worklog Plugin named, no Entry is sent and nothing is said.
 */
import { accessSync, constants, statSync } from 'node:fs';

/** The environment variable that names the whisper.cpp executable. */
export const WHISPER_VARIABLE = 'SCRIBE_WHISPER';
/** The environment variable that names the whisper.cpp model file. */
export const MODEL_VARIABLE = 'SCRIBE_WHISPER_MODEL';
/** The environment variable that names the command that makes the Minutes. */
export const MINUTES_VARIABLE = 'SCRIBE_MINUTES_COMMAND';
/** How long the Minutes command may run before it is ended. */
export const MINUTES_TIMEOUT_VARIABLE = 'SCRIBE_MINUTES_TIMEOUT_MS';
/** How long a recording Call may go without audio before it is Cut. */
export const CUT_VARIABLE = 'SCRIBE_CUT_AFTER_MS';
/** The environment variable that names the Worklog Plugin a Call's Entry goes to. */
export const WORKLOG_VARIABLE = 'SCRIBE_WORKLOG_PLUGIN';
/** How long scribe waits for Worklog to answer. */
export const WORKLOG_WAIT_VARIABLE = 'SCRIBE_WORKLOG_WAIT_MS';

/** Worklog answers at once; this much is a Plugin Server that is not there. */
const WORKLOG_WAIT_MS = 30_000;

/** A model on a CPU may take this long before the Minutes command is given up on. */
const MINUTES_TIMEOUT_MS = 15 * 60_000;

/** A page sends audio every 5 s, so a minute of none means it went away. */
const CUT_AFTER_MS = 60_000;

export type Settings = {
  /** The absolute path of the whisper.cpp executable. */
  readonly whisper: string;
  /** The absolute path of the whisper.cpp model file. */
  readonly model: string;
  /**
   * The command that makes the Minutes, as the JSON text it was set to, or null
   * when none is set. It is read when Minutes are made, so a wrong one refuses
   * Make Minutes and never stops a Call from recording (ADR-0002).
   */
  readonly minutesCommand: string | null;
  /** How long the Minutes command may run before it is ended. */
  readonly minutesTimeoutMs: number;
  /** How long a recording Call may go without audio before it is Cut. */
  readonly cutAfterMs: number;
  /** The Registry name of the Worklog Plugin, or null when no Entry is sent. */
  readonly worklogPlugin: string | null;
  /** How long scribe waits for Worklog to answer. */
  readonly worklogWaitMs: number;
};

/** Read the settings, or throw a sentence that names the one that is wrong. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    whisper: executable(WHISPER_VARIABLE, env[WHISPER_VARIABLE], 'the whisper.cpp executable'),
    model: file(MODEL_VARIABLE, env[MODEL_VARIABLE], 'the whisper.cpp model file'),
    minutesCommand: nonEmpty(env[MINUTES_VARIABLE]),
    minutesTimeoutMs: milliseconds(
      MINUTES_TIMEOUT_VARIABLE,
      env[MINUTES_TIMEOUT_VARIABLE],
      MINUTES_TIMEOUT_MS,
    ),
    cutAfterMs: milliseconds(CUT_VARIABLE, env[CUT_VARIABLE], CUT_AFTER_MS),
    worklogPlugin: nonEmpty(env[WORKLOG_VARIABLE]),
    worklogWaitMs: milliseconds(
      WORKLOG_WAIT_VARIABLE,
      env[WORKLOG_WAIT_VARIABLE],
      WORKLOG_WAIT_MS,
    ),
  };
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function file(variable: string, value: string | undefined, what: string): string {
  const path = nonEmpty(value);
  if (path === null) {
    throw new Error(
      `${variable} is not set. Set it to ${what}, where the Host is started; ` +
        'the README says how to get one.',
    );
  }
  let found;
  try {
    found = statSync(path);
  } catch {
    throw new Error(`${variable} names ${path}, and there is no file there. Set it to ${what}.`);
  }
  if (!found.isFile()) {
    throw new Error(`${variable} names ${path}, which is not a file. Set it to ${what}.`);
  }
  return path;
}

function executable(variable: string, value: string | undefined, what: string): string {
  const path = file(variable, value, what);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${variable} names ${path}, which may not be run. Set it to ${what}.`);
  }
  return path;
}

function milliseconds(variable: string, value: string | undefined, fallback: number): number {
  const given = nonEmpty(value);
  if (given === null) return fallback;
  const read = Number(given);
  if (!Number.isSafeInteger(read) || read <= 0) {
    throw new Error(`${variable} is ${given}; set it to a whole number of milliseconds.`);
  }
  return read;
}
