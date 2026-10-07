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

/** The form, as a sentence can describe it to the operator. */
export const COMMAND_SHAPE =
  'a JSON array of strings, the program first and then each argument, such as ' +
  COMMAND_FORM;

/** A command from a value read as JSON, or null when it is not an array of strings. */
export function commandOf(value: unknown): Command | null {
  if (!Array.isArray(value)) return null;
  const parts: readonly unknown[] = value;
  if (!parts.every((part): part is string => typeof part === 'string')) return null;
  const [program, ...args] = parts;
  if (program === undefined || program.trim() === '') return null;
  return { program, args };
}

/** A command as the JSON array it is written as: the program, then each argument. */
export function toArray(command: Command): readonly string[] {
  return [command.program, ...command.args];
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
