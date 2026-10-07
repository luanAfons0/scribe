/**
 * A command the operator chooses: a program and its arguments, written as a
 * JSON array of strings, program first — `["ollama", "run", "llama3"]`.
 *
 * It is a list and not a command line because no shell runs it, on any
 * system (ADR-0003). A list says where each argument begins and ends, so an
 * argument with spaces or quotes needs no quoting rules of a shell that is
 * not there. research reads `RESEARCH_DIGEST_COMMAND` in the same form, so an
 * operator writes both the same way.
 *
 * This file is the one place the form is read. The environment gives it as
 * text; a settings file may hold the array itself, and both come here.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/** A program and the arguments it is given, in order. */
export type Command = {
  /** The program: a path, or a name looked for on the PATH. */
  readonly program: string;
  /** The arguments, each passed as it is, with nothing to interpret. */
  readonly args: readonly string[];
};

/** The form, as an example a sentence can show the operator. */
export const COMMAND_FORM = '["ollama","run","<model>"]';

/** A command read from its JSON text, or a sentence that names the setting and the form. */
export function commandFrom(text: string, setting: string): Command {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(formSentence(setting, text));
  }
  return commandOf(value, setting, text);
}

/** A command from a value already read as JSON, or a sentence that says the form. */
export function commandOf(value: unknown, setting: string, shown = JSON.stringify(value)): Command {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((part): part is string => typeof part === 'string') ||
    value[0]!.trim() === ''
  ) {
    throw new Error(formSentence(setting, shown));
  }
  const [program, ...args] = value as string[];
  return { program: program!, args };
}

function formSentence(setting: string, shown: string): string {
  return (
    `${setting} is ${shown}; write it as a JSON array of strings, the program first and ` +
    `then each argument, such as ${COMMAND_FORM}.`
  );
}

/**
 * The path of the program a command names, or null when there is none to
 * run. A name with no directory is looked for on the PATH. On Windows a name
 * also matches with each extension in PATHEXT, the way a terminal finds
 * `claude` as `claude.cmd`, and that is the path a command is run by.
 */
export function findProgram(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const windows = platform === 'win32';
  const named =
    isAbsolute(program) || program.includes('/') || (windows && program.includes('\\'));
  const directories = named
    ? ['']
    : (variable(env, 'PATH', windows) ?? '')
        .split(delimiter)
        .filter((directory) => directory !== '');
  for (const directory of directories) {
    const base = directory === '' ? program : join(directory, program);
    for (const candidate of windows ? windowsForms(base, env) : [base]) {
      if (runnable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The names Windows would run for this one: as it is, when its extension
 * runs, then with each. The extensions are lower case, as files carry them,
 * so that a directory that tells case apart finds them too.
 */
function windowsForms(base: string, env: NodeJS.ProcessEnv): readonly string[] {
  const extensions = (variable(env, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension !== '')
    .map((extension) => extension.toLowerCase());
  const own = extname(base).toLowerCase();
  const asIs = own !== '' && extensions.includes(own);
  return [...(asIs ? [base] : []), ...extensions.map((extension) => base + extension)];
}

/** An environment variable, by its name in any case on Windows, where `Path` is `PATH`. */
function variable(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name];
  const key = Object.keys(env).find((given) => given.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function runnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
