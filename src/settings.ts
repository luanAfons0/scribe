/**
 * What scribe is set up with: the settings the operator chooses, and the
 * times and limits that stay in the environment.
 *
 * The operator chooses four: the whisper.cpp executable, its model, the
 * Minutes command and the Worklog Plugin. They are set on the Plugin Page and
 * kept in `settings.json` in the Plugin directory, so they work however the
 * Host was started. The variable of the same name still beats the file, and
 * the file beats the default, which is none. A variable that is set but empty
 * is not set: it decides nothing.
 *
 * None of the four ends the Plugin Server, and neither does a settings file
 * that cannot be read (ADR-0004): a Plugin Server that is up keeps its Plugin
 * Page, and the Page is where they are fixed. What is missing or wrong is one
 * sentence, beside the setting on the Page and as the refusal of whatever
 * needs it. Without whisper.cpp or its model no Call records; without the
 * Minutes command a Call still records and only Make Minutes is refused
 * (ADR-0002); without a Worklog Plugin no Entry is sent and nothing is said.
 *
 * The times stay in the environment alone, each with a default that is right
 * for a person, which a test shortens. One that is not a number still ends the
 * Plugin Server at start with a sentence: nobody sets one by accident.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { COMMAND_FORM, commandFrom, commandOf, findProgram, type Command } from './command.ts';
import { badInput, sentenceFor } from './mcp.ts';
import { pathOf, readSettingsFile, writeSettingsFile } from './settings-file.ts';

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
/** How long a download may send nothing before it is given up. */
export const FETCH_IDLE_VARIABLE = 'SCRIBE_FETCH_IDLE_MS';

/** A download that sends nothing for a minute has stalled, not slowed. */
const FETCH_IDLE_MS = 60_000;

/** Worklog answers at once; this much is a Plugin Server that is not there. */
const WORKLOG_WAIT_MS = 30_000;

/** A model on a CPU may take this long before the Minutes command is given up on. */
const MINUTES_TIMEOUT_MS = 15 * 60_000;

/** A page sends audio every 5 s, so a minute of none means it went away. */
const CUT_AFTER_MS = 60_000;

/** The times and limits, which stay in the environment alone. */
export type Settings = {
  /** How long the Minutes command may run before it is ended. */
  readonly minutesTimeoutMs: number;
  /** How long a recording Call may go without audio before it is Cut. */
  readonly cutAfterMs: number;
  /** How long scribe waits for Worklog to answer. */
  readonly worklogWaitMs: number;
  /** How long a download may send nothing before it is given up. */
  readonly fetchIdleMs: number;
};

/** Read the times, or throw a sentence that names the one that is wrong. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    minutesTimeoutMs: milliseconds(
      MINUTES_TIMEOUT_VARIABLE,
      env[MINUTES_TIMEOUT_VARIABLE],
      MINUTES_TIMEOUT_MS,
    ),
    cutAfterMs: milliseconds(CUT_VARIABLE, env[CUT_VARIABLE], CUT_AFTER_MS),
    worklogWaitMs: milliseconds(
      WORKLOG_WAIT_VARIABLE,
      env[WORKLOG_WAIT_VARIABLE],
      WORKLOG_WAIT_MS,
    ),
    fetchIdleMs: milliseconds(FETCH_IDLE_VARIABLE, env[FETCH_IDLE_VARIABLE], FETCH_IDLE_MS),
  };
}

/** The settings the operator chooses, by the name the tools and the file give each. */
export const CHOSEN = ['whisper', 'whisperModel', 'minutesCommand', 'worklogPlugin'] as const;

/** The name of one setting the operator chooses. */
export type Chosen = (typeof CHOSEN)[number];

/** Who decides a setting: the environment, the settings file, or neither. */
export type DecidedBy = 'environment' | 'file' | 'default';

/** One setting, as the settings tools tell it and the Plugin Page shows it. */
export type SettingView = {
  /** What scribe uses now, or null for none. */
  readonly value: string | readonly string[] | null;
  /** Who decided it. */
  readonly from: DecidedBy;
  /** What the settings file holds, whether or not the environment beats it. */
  readonly saved: string | readonly string[] | null;
  /** The variable that beats the file. */
  readonly variable: string;
  /** What is missing or wrong with it, as one sentence, or null when nothing is. */
  readonly problem: string | null;
};

/** Every setting the operator chooses, as the settings tools tell them. */
export type SettingsView = { readonly [name in Chosen]: SettingView };

/** whisper.cpp, ready to run: the executable and the model it reads. */
export type Whisper = { readonly program: string; readonly model: string };

/** The settings the operator chooses, in one running Plugin Server. */
export type Choices = {
  /** whisper.cpp and its model, or a refusal that names the setting that is missing. */
  whisper(): Whisper;
  /** The Minutes command, found, or a refusal that says what is missing or wrong. */
  minutesCommand(): Command;
  /** Whether a Minutes command is set at all, right or wrong. */
  minutesCommandSet(): boolean;
  /** The Registry name of the Worklog Plugin, or null when no Entry is sent. */
  worklogPlugin(): string | null;
  /** Every setting, as the settings tools tell them. */
  view(): SettingsView;
  /** Keep the given settings in the file, or refuse every one with a sentence. */
  update(given: Readonly<Record<string, unknown>>): void;
};

/** What each setting is called on the Page, and the variable that beats it. */
const NAMES: { readonly [name in Chosen]: { readonly label: string; readonly variable: string } } =
  {
    whisper: { label: 'the whisper.cpp executable', variable: WHISPER_VARIABLE },
    whisperModel: { label: 'the whisper.cpp model', variable: MODEL_VARIABLE },
    minutesCommand: { label: 'the Minutes command', variable: MINUTES_VARIABLE },
    worklogPlugin: { label: 'the Worklog Plugin', variable: WORKLOG_VARIABLE },
  };

/** A FirstMate Registry name, as the Host takes it. */
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One setting as the file or the environment gave it, before it is checked against the disk. */
type Given = {
  readonly value: string | readonly string[] | null;
  readonly from: DecidedBy;
  /** Why it could not be read at all: a variable or a file not in its form. */
  readonly unread: string | null;
};

/**
 * The settings the operator chooses, from the environment and the settings
 * file in the Plugin directory. The file is read once, here; this Plugin
 * Server is the one that writes it.
 */
export function openChoices(
  env: NodeJS.ProcessEnv = process.env,
  directory = '.',
): Choices {
  let whole: Record<string, unknown> = {};
  let broken: string | null = null;
  try {
    whole = readSettingsFile(directory);
  } catch (fault) {
    broken = sentenceFor(fault);
  }

  /** What the file holds for a setting, in its form, or why it does not. */
  const saved = (name: Chosen): Omit<Given, 'from'> => {
    if (broken !== null) return { value: null, unread: broken };
    const held = whole[name];
    if (held === undefined || held === null) return { value: null, unread: null };
    try {
      return { value: formOf(name, held), unread: null };
    } catch (fault) {
      return {
        value: null,
        unread: `In ${pathOf(directory)}, ${sentenceFor(fault)}`,
      };
    }
  };

  const given = (name: Chosen): Given => {
    const text = (env[NAMES[name].variable] ?? '').trim();
    if (text !== '') {
      if (name !== 'minutesCommand') return { value: text, from: 'environment', unread: null };
      try {
        const command = commandFrom(text, MINUTES_VARIABLE);
        return { value: [command.program, ...command.args], from: 'environment', unread: null };
      } catch (fault) {
        return { value: null, from: 'environment', unread: sentenceFor(fault) };
      }
    }
    const held = saved(name);
    if (held.unread !== null) return { value: null, from: 'file', unread: held.unread };
    return held.value === null
      ? { value: null, from: 'default', unread: null }
      : { value: held.value, from: 'file', unread: null };
  };

  const problemOf = (name: Chosen): string | null => {
    const setting = given(name);
    try {
      if (name === 'whisper') executable(name, setting);
      else if (name === 'whisperModel') file(name, setting);
      else if (name === 'minutesCommand') foundCommand(setting);
      return null;
    } catch (fault) {
      return sentenceFor(fault);
    }
  };

  return {
    whisper: () => ({
      program: executable('whisper', given('whisper')),
      model: file('whisperModel', given('whisperModel')),
    }),

    minutesCommand: () => foundCommand(given('minutesCommand')),

    minutesCommandSet: () => {
      const setting = given('minutesCommand');
      return setting.value !== null || setting.unread !== null;
    },

    worklogPlugin: () => {
      const setting = given('worklogPlugin');
      return typeof setting.value === 'string' ? setting.value : null;
    },

    view: () => {
      const one = (name: Chosen): SettingView => {
        const setting = given(name);
        return {
          value: setting.value,
          from: setting.from,
          saved: saved(name).value,
          variable: NAMES[name].variable,
          problem: problemOf(name),
        };
      };
      return {
        whisper: one('whisper'),
        whisperModel: one('whisperModel'),
        minutesCommand: one('minutesCommand'),
        worklogPlugin: one('worklogPlugin'),
      };
    },

    update: (changes) => {
      const known: readonly string[] = CHOSEN;
      const unknown = Object.keys(changes).filter((key) => !known.includes(key));
      if (unknown.length > 0) {
        throw badInput(
          `update_settings takes ${CHOSEN.join(', ')}, and was given ${unknown.join(', ')}.`,
        );
      }
      // Every value is checked before the file is touched, so one that is
      // refused leaves the file as it was.
      const next: Record<string, unknown> = broken === null ? { ...whole } : {};
      for (const name of CHOSEN) {
        if (!(name in changes)) continue;
        const value = changes[name];
        try {
          next[name] = value === null ? null : formOf(name, value);
        } catch (fault) {
          throw badInput(`update_settings: ${sentenceFor(fault)}`);
        }
      }
      // A broken file is replaced by what was saved, which is how the Page fixes it.
      writeSettingsFile(next, directory);
      whole = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null));
      broken = null;
    },
  };
}

/**
 * A setting in its form, or a sentence that says the form: an absolute path
 * for whisper.cpp and its model, a program and its arguments for the Minutes
 * command (ADR-0003), a Registry name for the Worklog Plugin. Whether the path
 * leads to a file is not the form: that is a problem, shown beside it.
 */
function formOf(name: Chosen, value: unknown): string | readonly string[] {
  const shown = JSON.stringify(value);
  if (name === 'minutesCommand') {
    const command = commandOf(value, name, shown);
    return [command.program, ...command.args];
  }
  if (name === 'worklogPlugin') {
    if (typeof value === 'string' && PLUGIN_NAME.test(value)) return value;
    throw new Error(
      `${name} is ${shown}; set it to the Registry name of the Worklog Plugin, such as ` +
        '"worklog", or to null for none.',
    );
  }
  if (typeof value === 'string' && value.trim() !== '' && isAbsolute(value.trim())) {
    return value.trim();
  }
  throw new Error(
    `${name} is ${shown}; set it to the absolute path of ${NAMES[name].label}, or to null ` +
      'for none.',
  );
}

/** Where a setting is fixed: where the Host is started, or on the Plugin Page. */
function whereTo(name: Chosen, setting: Given): string {
  return setting.from === 'environment'
    ? `change ${NAMES[name].variable} where the Host is started`
    : 'set it on the Plugin Page';
}

/** How a sentence names a setting: by its variable when the environment decides it. */
function named(name: Chosen, setting: Given): string {
  return setting.from === 'environment'
    ? `${NAMES[name].label} in ${NAMES[name].variable}`
    : NAMES[name].label;
}

/** The path of an existing file a setting names, or a sentence that says no Call can record. */
function file(name: 'whisper' | 'whisperModel', setting: Given): string {
  if (setting.unread !== null) throw badInput(`No Call can record: ${setting.unread}`);
  if (typeof setting.value !== 'string') {
    throw badInput(
      `No Call can record until ${NAMES[name].label} is set, on the Plugin Page or with ` +
        `${NAMES[name].variable} where the Host is started.`,
    );
  }
  const path = setting.value;
  let found;
  try {
    found = statSync(path);
  } catch {
    throw badInput(
      `No Call can record: ${named(name, setting)} is ${path}, and there is no file there; ` +
        `${whereTo(name, setting)}.`,
    );
  }
  if (!found.isFile()) {
    throw badInput(
      `No Call can record: ${named(name, setting)} is ${path}, which is not a file; ` +
        `${whereTo(name, setting)}.`,
    );
  }
  return path;
}

function executable(name: 'whisper', setting: Given): string {
  const path = file(name, setting);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw badInput(
      `No Call can record: ${named(name, setting)} is ${path}, which may not be run; ` +
        `${whereTo(name, setting)}.`,
    );
  }
  return path;
}

/**
 * The Minutes command, with its program as the path it is run by, or a
 * sentence that says why Make Minutes is refused.
 */
function foundCommand(setting: Given): Command {
  if (setting.unread !== null) throw badInput(setting.unread);
  if (!Array.isArray(setting.value)) {
    throw badInput(
      'Make Minutes needs a Minutes command: set it on the Plugin Page, or with ' +
        `${MINUTES_VARIABLE} where the Host is started, to a command that reads a prompt on ` +
        `stdin and prints the Minutes, such as ${COMMAND_FORM}. Recording and the ` +
        'Transcript work without it.',
    );
  }
  const [program, ...args] = setting.value as readonly string[];
  const path = findProgram(program!);
  if (path === null) {
    throw badInput(
      `${named('minutesCommand', setting)} names "${program}", which is not found on the ` +
        `Host's PATH; give its absolute path, and ${whereTo('minutesCommand', setting)}.`,
    );
  }
  return { program: path, args };
}

function milliseconds(variable: string, value: string | undefined, fallback: number): number {
  const given = (value ?? '').trim();
  if (given === '') return fallback;
  const read = Number(given);
  if (!Number.isSafeInteger(read) || read <= 0) {
    throw new Error(`${variable} is ${given}; set it to a whole number of milliseconds.`);
  }
  return read;
}
