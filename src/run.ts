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
 */
import { spawn, type ChildProcess } from 'node:child_process';
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

export type RunOptions = {
  /** Written to its stdin, which is then closed. Without it, stdin is closed at once. */
  readonly input?: string;
  /** How long it may run before it is ended, with every process it started. */
  readonly timeoutMs: number;
};

const WINDOWS = process.platform === 'win32';

/** Run a command whose program is a path, and hand back how it ran. */
export function run(command: Command, options: RunOptions): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = start(command);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      endTree(child);
    }, options.timeoutMs);
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    // A program that never reads its stdin closes it early; that is its affair.
    child.stdin!.on('error', () => {});
    child.on('error', (fault) => {
      clearTimeout(timer);
      fail(fault);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
    child.stdin!.end(options.input ?? '');
  });
}

function start(command: Command): ChildProcess {
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

/** End a program and every process it started. */
function endTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (WINDOWS) {
    const system = process.env['SystemRoot'] ?? 'C:\\Windows';
    spawn(join(system, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group is gone already.
  }
}
