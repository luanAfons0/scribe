/**
 * What scribe is set up with: the settings the operator chooses, and the
 * times and limits that stay in the environment.
 *
 * The operator chooses five: the whisper.cpp executable, its model, the
 * Minutes command, the Worklog Plugin and the calendar's secret iCal address.
 * They are set on the Plugin Page and
 * kept in `settings.json` in the Plugin directory, so they work however the
 * Host was started. The variable of the same name still beats the file, and
 * the file beats the default, which is none. A variable that is set but empty
 * is not set: it decides nothing. One that is not in its form decides nothing
 * either, and the settings tools say it is ignored (ADR-0004).
 *
 * None of the five ends the Plugin Server, and neither does a settings file
 * that cannot be read (ADR-0004): a Plugin Server that is up keeps its Plugin
 * Page, and the Page is where they are fixed. What is missing or wrong is one
 * sentence, beside the setting on the Page and as the refusal of whatever
 * needs it. Without whisper.cpp or its model no Call records; without the
 * Minutes command a Call still records and only Make Minutes is refused
 * (ADR-0002); without a Worklog Plugin no Entry is sent and nothing is said;
 * without the calendar's address there is no Event, and nothing is said.
 *
 * The calendar's address is a secret: whoever holds it reads the whole
 * calendar (ADR-0006). The settings tools say only whether it is set, and no
 * sentence here carries it, not even one that says it is not in its form.
 *
 * The times stay in the environment alone, each with a default that is right
 * for a person, which a test shortens. One that is not a number still ends the
 * Plugin Server at start with a sentence: nobody sets one by accident.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  COMMAND_FORM,
  COMMAND_SHAPE,
  commandOf,
  findProgram,
  toArray,
  type Command,
} from './command.ts';
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
/** The environment variable that holds the calendar's secret iCal address. */
export const CALENDAR_VARIABLE = 'SCRIBE_CALENDAR_URL';
/** How often scribe reads the calendar again. */
export const CALENDAR_READ_VARIABLE = 'SCRIBE_CALENDAR_READ_MS';
/** How long before an Event its Notice goes. */
export const NOTICE_LEAD_VARIABLE = 'SCRIBE_NOTICE_LEAD_MS';

/** An Event added today gets its Notice if the calendar is read this often. */
const CALENDAR_READ_MS = 5 * 60_000;

/** A minute is enough to open the call, and not so long that it is forgotten. */
const NOTICE_LEAD_MS = 60_000;

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
  /** How often scribe reads the calendar again. */
  readonly calendarReadMs: number;
  /** How long before an Event its Notice goes. */
  readonly noticeLeadMs: number;
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
    calendarReadMs: milliseconds(
      CALENDAR_READ_VARIABLE,
      env[CALENDAR_READ_VARIABLE],
      CALENDAR_READ_MS,
    ),
    noticeLeadMs: milliseconds(NOTICE_LEAD_VARIABLE, env[NOTICE_LEAD_VARIABLE], NOTICE_LEAD_MS),
  };
}

/** The settings the operator chooses, by the name the tools and the file give each. */
export const CHOSEN = [
  'whisper',
  'whisperModel',
  'minutesCommand',
  'worklogPlugin',
  'calendarUrl',
] as const;

/** The name of one setting the operator chooses. */
export type Chosen = (typeof CHOSEN)[number];

/** The settings whose value the settings tools may show: all but the secret one. */
type Shown = Exclude<Chosen, 'calendarUrl'>;

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
  /** Why its variable is set and ignored, and to remove it, as one sentence, or null. */
  readonly ignored: string | null;
};

/**
 * The calendar's secret address, as the settings tools tell it: whether it is
 * set, and never what it is (ADR-0006).
 */
export type SecretView = Omit<SettingView, 'value' | 'saved'> & {
  /** Whether scribe has an address to read. */
  readonly set: boolean;
  /** Whether the settings file holds one, whether or not the environment beats it. */
  readonly saved: boolean;
};

/** Every setting the operator chooses, as the settings tools tell them. */
export type SettingsView = { readonly [name in Shown]: SettingView } & {
  readonly calendarUrl: SecretView;
};

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
  /** The calendar's secret iCal address, or null when there is no Event. Never shown. */
  calendarUrl(): string | null;
  /** Every setting, as the settings tools tell them. */
  view(): SettingsView;
  /** Keep the given settings in the file, or refuse every one with a sentence. */
  update(given: Readonly<Record<string, unknown>>): void;
};

/** A setting's value in its form: a path or a name, or a command as its JSON array. */
type Value = string | readonly string[];

/** One setting as the file or the environment gave it, before it is checked against the disk. */
type Given = {
  readonly value: Value | null;
  readonly from: DecidedBy;
  /** Why the file's value could not be read at all: a file or a value not in its form. */
  readonly unread: string | null;
};

/** One setting the operator chooses, as data: everything the code below reads of it. */
type Spec = {
  /** The variable that beats the file. */
  readonly variable: string;
  /** What a sentence calls it. */
  readonly label: string;
  /** Its form, as a sentence says it after "set it to". */
  readonly shape: string;
  /** Whether its variable holds JSON, as the Minutes command does, or plain text. */
  readonly json: boolean;
  /** Whether its value is a secret, which no sentence may carry. */
  readonly secret: boolean;
  /** The value in its form, or null when it is not in it. */
  readonly form: (value: unknown) => Value | null;
  /** What it needs to be used, read each time, which throws the sentence when it is not met. */
  readonly check: ((spec: Spec, setting: Given) => unknown) | null;
};

/** A FirstMate Registry name, as the Host takes it. */
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The four settings, as data. The form is all `update_settings` checks
 * (ADR-0004): an absolute path for whisper.cpp and its model, a program and its
 * arguments for the Minutes command (ADR-0003), a Registry name for the
 * Worklog Plugin. Whether a path leads to a file is the check, read each time
 * and shown beside the setting as its problem.
 */
const SPECS: { readonly [name in Chosen]: Spec } = {
  whisper: {
    variable: WHISPER_VARIABLE,
    label: 'the whisper.cpp executable',
    shape: 'the absolute path of the whisper.cpp executable',
    json: false,
    secret: false,
    form: absolutePath,
    check: executable,
  },
  whisperModel: {
    variable: MODEL_VARIABLE,
    label: 'the whisper.cpp model',
    shape: 'the absolute path of the whisper.cpp model',
    json: false,
    secret: false,
    form: absolutePath,
    check: existingFile,
  },
  minutesCommand: {
    variable: MINUTES_VARIABLE,
    label: 'the Minutes command',
    shape: COMMAND_SHAPE,
    json: true,
    secret: false,
    form: (value) => {
      const command = commandOf(value);
      return command === null ? null : toArray(command);
    },
    check: foundCommand,
  },
  worklogPlugin: {
    variable: WORKLOG_VARIABLE,
    label: 'the Worklog Plugin',
    shape: 'the Registry name of the Worklog Plugin, such as "worklog"',
    json: false,
    secret: false,
    form: (value) => (typeof value === 'string' && PLUGIN_NAME.test(value) ? value : null),
    check: null,
  },
  calendarUrl: {
    variable: CALENDAR_VARIABLE,
    label: "the calendar's secret address",
    shape: 'the "Secret address in iCal format" Google Calendar gives, which starts with https://',
    json: false,
    secret: true,
    form: webAddress,
    check: null,
  },
};

/** One thing for each setting, made by name. */
function each<T>(make: (name: Chosen) => T): { readonly [name in Chosen]: T } {
  return {
    whisper: make('whisper'),
    whisperModel: make('whisperModel'),
    minutesCommand: make('minutesCommand'),
    worklogPlugin: make('worklogPlugin'),
    calendarUrl: make('calendarUrl'),
  };
}

/** What a variable gives a setting: its value, or why it is ignored. */
type FromVariable = { readonly value: Value | null; readonly ignored: string | null };

/**
 * A setting's variable, read once. One that is set and not in its form, such
 * as the shell line a 1.x systemd drop-in still sets, does not decide: the
 * file decides, then the default, and the sentence says to remove it
 * (ADR-0004).
 */
function fromVariable(spec: Spec, env: NodeJS.ProcessEnv): FromVariable {
  const text = (env[spec.variable] ?? '').trim();
  if (text === '') return { value: null, ignored: null };
  const value = spec.form(spec.json ? jsonOrText(text) : text);
  if (value !== null) return { value, ignored: null };
  const is = spec.secret ? `${spec.variable} is set` : `${spec.variable} is ${text}`;
  return {
    value: null,
    ignored:
      `${is}, which is not ${spec.shape}, so scribe ignores it; ` +
      'remove it from where the Host is started, such as the systemd drop-in of scribe 1.x, ' +
      `and set ${spec.label} on the Plugin Page.`,
  };
}

/** Text read as JSON, or the text itself when it is not JSON. */
function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The sentence that says a value is not in its setting's form. */
function notInForm(spec: Spec, named: string, value: unknown): string {
  const is = spec.secret ? `${named} is not in its form` : `${named} is ${JSON.stringify(value)}`;
  return `${is}; set it to ${spec.shape}, or to null for none.`;
}

/**
 * The settings the operator chooses, from the environment and the settings
 * file in the Plugin directory. Both are read once, here; this Plugin Server
 * is the one that writes the file.
 */
export function openChoices(
  env: NodeJS.ProcessEnv = process.env,
  directory = '.',
): Choices {
  const environment = each((name) => fromVariable(SPECS[name], env));
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
    const value = SPECS[name].form(held);
    if (value !== null) return { value, unread: null };
    const unread = `In ${pathOf(directory)}, ${notInForm(SPECS[name], name, held)}`;
    return { value: null, unread };
  };

  const given = (name: Chosen): Given => {
    const variable = environment[name].value;
    if (variable !== null) return { value: variable, from: 'environment', unread: null };
    const held = saved(name);
    if (held.unread !== null) return { value: null, from: 'file', unread: held.unread };
    return { ...held, from: held.value === null ? 'default' : 'file' };
  };

  const problemOf = (name: Chosen): string | null => {
    const spec = SPECS[name];
    try {
      spec.check?.(spec, given(name));
      return null;
    } catch (fault) {
      return sentenceFor(fault);
    }
  };

  return {
    whisper: () => ({
      program: executable(SPECS.whisper, given('whisper')),
      model: existingFile(SPECS.whisperModel, given('whisperModel')),
    }),

    minutesCommand: () => foundCommand(SPECS.minutesCommand, given('minutesCommand')),

    minutesCommandSet: () => {
      const setting = given('minutesCommand');
      return setting.value !== null || setting.unread !== null;
    },

    worklogPlugin: () => {
      const setting = given('worklogPlugin');
      return typeof setting.value === 'string' ? setting.value : null;
    },

    calendarUrl: () => {
      const setting = given('calendarUrl');
      return typeof setting.value === 'string' ? setting.value : null;
    },

    view: () => {
      const all = each((name) => {
        const setting = given(name);
        return {
          value: setting.value,
          from: setting.from,
          saved: saved(name).value,
          variable: SPECS[name].variable,
          problem: problemOf(name),
          ignored: environment[name].ignored,
        };
      });
      const { value, saved: held, ...calendar } = all.calendarUrl;
      return {
        ...all,
        calendarUrl: { ...calendar, set: value !== null, saved: held !== null },
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
        const spec = SPECS[name];
        const formed = value === null ? null : spec.form(value);
        if (value !== null && formed === null) {
          throw badInput(`update_settings: ${notInForm(spec, name, value)}`);
        }
        next[name] = formed;
      }
      // A broken file is replaced by what was saved, which is how the Page fixes it.
      writeSettingsFile(next, directory);
      whole = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null));
      broken = null;
    },
  };
}

/** An absolute path, trimmed, or null when the value is not one. */
function absolutePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  return path !== '' && isAbsolute(path) ? path : null;
}

/** An http or https address, trimmed, or null when the value is not one. */
function webAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  try {
    const url = new URL(address);
    return url.protocol === 'https:' || url.protocol === 'http:' ? address : null;
  } catch {
    return null;
  }
}

/** Where a setting is fixed: where the Host is started, or on the Plugin Page. */
function whereTo(spec: Spec, setting: Given): string {
  return setting.from === 'environment'
    ? `change ${spec.variable} where the Host is started`
    : 'set it on the Plugin Page';
}

/** How a sentence names a setting: by its variable when the environment decides it. */
function named(spec: Spec, setting: Given): string {
  return setting.from === 'environment' ? `${spec.label} in ${spec.variable}` : spec.label;
}

/** The path of an existing file a setting names, or a sentence that says no Call can record. */
function existingFile(spec: Spec, setting: Given): string {
  if (setting.unread !== null) throw badInput(`No Call can record: ${setting.unread}`);
  if (typeof setting.value !== 'string') {
    throw badInput(
      `No Call can record until ${spec.label} is set, on the Plugin Page or with ` +
        `${spec.variable} where the Host is started.`,
    );
  }
  const path = setting.value;
  let found;
  try {
    found = statSync(path);
  } catch {
    throw badInput(
      `No Call can record: ${named(spec, setting)} is ${path}, and there is no file there; ` +
        `${whereTo(spec, setting)}.`,
    );
  }
  if (!found.isFile()) {
    throw badInput(
      `No Call can record: ${named(spec, setting)} is ${path}, which is not a file; ` +
        `${whereTo(spec, setting)}.`,
    );
  }
  return path;
}

/** The path of an existing file a setting names, which may be run. */
function executable(spec: Spec, setting: Given): string {
  const path = existingFile(spec, setting);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw badInput(
      `No Call can record: ${named(spec, setting)} is ${path}, which may not be run; ` +
        `${whereTo(spec, setting)}.`,
    );
  }
  return path;
}

/**
 * The Minutes command, with its program as the path it is run by, or a
 * sentence that says why Make Minutes is refused.
 */
function foundCommand(spec: Spec, setting: Given): Command {
  if (setting.unread !== null) throw badInput(setting.unread);
  const command = commandOf(setting.value);
  if (command === null) {
    throw badInput(
      'Make Minutes needs a Minutes command: set it on the Plugin Page, or with ' +
        `${spec.variable} where the Host is started, to a command that reads a prompt on ` +
        `stdin and prints the Minutes, such as ${COMMAND_FORM}. Recording and the ` +
        'Transcript work without it.',
    );
  }
  const path = findProgram(command.program);
  if (path === null) {
    throw badInput(
      `${named(spec, setting)} names "${command.program}", which is not found on the ` +
        `Host's PATH; give its absolute path, and ${whereTo(spec, setting)}.`,
    );
  }
  return { program: path, args: command.args };
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
