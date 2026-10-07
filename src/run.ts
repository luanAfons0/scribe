/**
 * Run a program with its arguments and no shell, on Windows and on Linux, and
 * end it with every process it started when it runs past its time (ADR-0003).
 *
 * whisper.cpp and the Minutes command both go through here. A program is
 * started directly, so an argument reaches it as it was written. The one
 * exception is a `.cmd` or `.bat` file on Windows, which only `cmd.exe` can
 * run: it gets a command line in which every character `cmd.exe` would read
 * as its own is escaped, so there is nothing left for it to interpret.
 *
 * A program that runs past its time is ended with its whole tree, because the
 * Minutes command is often a wrapper — a `.cmd` that starts `node`, a script
 * that starts a model — and ending only the wrapper would leave the model
 * running and holding the pipe open. On Linux the program leads a process
 * group of its own, and the group is killed; on Windows, `taskkill /T /F`.
 * When the Plugin Server ends, every program it started that still runs is
 * ended the same way, so none outlives it.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { extname, join } from 'node:path';
import type { Command } from './command.ts';

/** How a program ran: its exit code, what it printed, and whether its time ran out. */
export type Ran = {
  /** The exit code, or null when it was ended by a signal. */
  readonly code: number | null;
  /** Everything it wrote on stdout. */
  readonly stdout: string;
  /** Everything it wrote on stderr. */
  readonly stderr: string;
  /** Whether it ran past its time and was ended, with every process it started. */
  readonly timedOut: boolean;
};

/** What a program is given to run: its stdin, and how long it may take. */
export type RunOptions = {
  /** Written to its stdin, which is then closed. Without it, stdin is closed at once. */
  readonly input?: string;
  /** How long it may run before it is ended, with every process it started. */
  readonly timeoutMs: number;
};

const WINDOWS = process.platform === 'win32';

/**
 * Every program this Plugin Server started that still runs. None may outlive
 * the Plugin Server: a model or a whisper.cpp left behind holds a CPU, and a
 * file the next start needs, with nobody to answer.
 */
const running = new Set<ChildProcessWithoutNullStreams>();

/** Run a command whose program is a path, and hand back how it ran. */
export function run(command: Command, options: RunOptions): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = start(command);
    running.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      endTree(child);
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    // A program that never reads its stdin closes it early; that is its affair.
    child.stdin.on('error', () => {});
    child.on('error', (fault) => {
      running.delete(child);
      clearTimeout(timer);
      fail(fault);
    });
    child.on('close', (code) => {
      running.delete(child);
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(options.input ?? '');
  });
}

/**
 * End every program this Plugin Server started, each with its whole tree. It
 * runs as the Plugin Server ends, so it does all it does before it returns.
 */
export function endEveryTree(): void {
  for (const child of running) endTree(child);
  running.clear();
}

/**
 * Why a run failed, as one sentence that starts with what ran, or null when
 * it ran to the end and exited with 0. What it said last on stderr is kept,
 * because that is where a program says what went wrong.
 */
export function failureOf(ran: Ran, what: string, timeoutMs: number): string | null {
  if (ran.timedOut) {
    return (
      `${what} ran longer than ${duration(timeoutMs)} and was stopped, with every process ` +
      'it started.'
    );
  }
  if (ran.code === 0) return null;
  const ended = ran.code === null ? 'was ended by a signal' : `exited with ${ran.code}`;
  const said = ran.stderr.trim().split('\n').pop()?.trim() ?? '';
  return said === '' ? `${what} ${ended}.` : `${what} ${ended}: ${said}`;
}

/** A time a person reads: whole minutes when it is, seconds otherwise. */
function duration(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms / 1000} s`;
}

function start(command: Command): ChildProcessWithoutNullStreams {
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
  if (!WINDOWS) {
    // A process group of its own, so that its whole tree can be ended at once.
    return spawn(command.program, command.args, { stdio, detached: true });
  }
  if (!/^\.(cmd|bat)$/i.test(extname(command.program))) {
    return spawn(command.program, command.args, { stdio, windowsHide: true });
  }
  // `/d` skips AutoRun, `/s` takes the outer quotes off and nothing else, and
  // the line is passed verbatim, because it is quoted here for cmd.exe.
  const line = [plain(command.program), ...command.args.map(forCmd)].join(' ');
  return spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    stdio,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}
/** Every character `cmd.exe` reads as its own, which a caret makes plain. */
const CMD_SPECIAL = /([()\][%!^"`<>&|;, *?])/g;

/** The program's path, with every special character made plain once. */
function plain(path: string): string {
  return path.replace(CMD_SPECIAL, '^$1');
}

/**
 * One argument, quoted the way a program's C runtime reads it back, then with
 * every character special to `cmd.exe` escaped by a caret. The carets are
 * doubled because `cmd.exe` reads the line twice when it runs a batch file.
 */
function forCmd(argument: string): string {
  const quoted = `"${argument
    // Backslashes before a quote are doubled, and the quote escaped.
    .replace(/(\\*)"/g, '$1$1\\"')
    // Backslashes at the end are doubled, because a quote follows them.
    .replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_SPECIAL, '^$1').replace(CMD_SPECIAL, '^$1');
}

/**
 * End a program and every process it started: its process group on Linux, its
 * tree on Windows. A group or a tree that cannot be ended is said on stderr;
 * the program alone is not killed in its place, because that would leave what
 * it started running with nobody to say so.
 */
function endTree(child: ChildProcessWithoutNullStreams): void {
  // The program may have ended while what it started still runs, so the group
  // or the tree is ended whatever the program's own state.
  if (child.pid === undefined) return;
  const failed = WINDOWS ? endWindowsTree(child.pid) : endGroup(child.pid);
  if (failed === null) return;
  process.stderr.write(`scribe: what a program started could not all be ended: ${failed}\n`);
}

/**
 * End the process group a program leads on Linux. A negative id names the
 * group. Null when it was ended, or a sentence that says why not.
 */
function endGroup(pid: number): string | null {
  try {
    process.kill(-pid, 'SIGKILL');
    return null;
  } catch (fault) {
    // ESRCH alone means every process of the group has ended already.
    if ((fault as NodeJS.ErrnoException).code === 'ESRCH') return null;
    return `the group ${pid} could not be killed (${(fault as Error).message}).`;
  }
}

/**
 * End a program's tree on Windows with `taskkill /T /F`, and wait for it, so
 * that it is done when the Plugin Server ends. Null when it was ended, or a
 * sentence when `taskkill.exe` could not start or exited with anything but 0.
 */
function endWindowsTree(pid: number): string | null {
  const ended = spawnSync(taskkill(), ['/pid', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (ended.error !== undefined) return `${taskkill()} could not start (${ended.error.message}).`;
  if (ended.status === 0) return null;
  return `${taskkill()} exited with ${ended.status ?? 'a signal'}.`;
}

/**
 * `taskkill.exe` by its absolute path in the Windows directory, so that a short
 * PATH, or a program of the same name earlier on it, does not stand in for it.
 */
function taskkill(): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}
