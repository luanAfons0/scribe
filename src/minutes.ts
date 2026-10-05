/**
 * The Minutes of a Call: a prompt made of its Jottings and its Transcript,
 * given to the command in `SCRIBE_MINUTES_COMMAND` on stdin, and the Minutes
 * read from its stdout (ADR-0002).
 *
 * scribe knows no model. The command is run by `sh`, so it may carry its own
 * arguments — `ollama run <model>` — and anything that reads a prompt and
 * prints text will do. The first line of the answer is a proposed title;
 * the rest is the Minutes, as Markdown, and then the Topics in a `<topics>`
 * block, which is taken out so that the Minutes keep their shape. A model
 * that thinks out loud in a `<think>` block, or wraps its answer in a code
 * fence, is forgiven both; one that writes no Topics still gives Minutes.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CallView } from './calls.ts';
import { badInput } from './mcp.ts';
import { MINUTES_VARIABLE } from './settings.ts';

/** A model on a CPU may take this long before the command is given up on. */
const MINUTES_TIMEOUT_MS = 15 * 60_000;

/**
 * Words `sh` runs itself. A command that starts with one — `cd /var/tmp && …`
 * — has no program to look for on the PATH, so it is left to `sh` to run.
 */
const SHELL_WORDS: ReadonlySet<string> = new Set(['cd', 'exec', 'export', 'env', 'command', '.']);

/** The most lines of Topics kept: few enough to read on a Worklog card. */
const MOST_TOPICS_LINES = 20;

/** What the command answered: a title and Topics, when it wrote them, and the Minutes. */
export type Made = {
  readonly title: string | null;
  readonly minutes: string;
  readonly topics: string | null;
};

/** The rules every set of Minutes is made by. */
const RULES = `You write the Minutes of a call, from the operator's Jottings and the \
call's Transcript.

Rules:
1. Write in the language spoken in the Transcript, which is usually Brazilian Portuguese.
2. Keep every heading of the Jottings (a line that starts with #), with its words and in \
its order, as a Markdown heading "## ...". Under each, keep the operator's own lines and \
add what the Transcript says about it, as short bullet points.
3. When the Jottings have no headings, choose a few short headings yourself.
4. End with exactly these two sections, in this order: "## Decisões" and \
"## Próximos passos". Under "Próximos passos", say who does what and by when, as far as \
the Transcript says. Write "- Nenhuma." under a section with nothing in it.
5. "Você" is the operator; "Outros" is everyone else on the call. Do not make up names the \
Transcript does not say.
6. Write nothing the Jottings or the Transcript do not support.
7. The first line of your answer is "TITLE: " and a short title for the call, in its \
language. Then an empty line, then the Minutes in Markdown, then the Topics as rule 8 \
says. Nothing else: no preamble, no code fence.
8. After the Minutes, write the Topics between a line "<topics>" and a line "</topics>": \
at most ${MOST_TOPICS_LINES} lines, in the language of the call. First the topics the call \
talked about, as short bullet points; then a summary of one to three sentences. The Topics \
are not part of the Minutes: they go to the operator's worklog.`;

/** The prompt for one Call: the rules, its Jottings, then its Transcript. */
export function promptFor(call: CallView): string {
  const transcript = call.transcript
    .map((line) => `[${stamp(line.startMs)}] ${line.speaker}: ${line.text}`)
    .join('\n');
  return (
    `${RULES}\n\n<jottings>\n${call.jottings.trim()}\n</jottings>\n\n` +
    `<transcript>\n${transcript}\n</transcript>\n`
  );
}

function stamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The command, when it is set and can be found; otherwise a sentence that
 * names `SCRIBE_MINUTES_COMMAND` and says what to set it to.
 */
export function checkCommand(command: string | null, path = process.env['PATH'] ?? ''): string {
  if (command === null) {
    throw badInput(
      `make_minutes needs ${MINUTES_VARIABLE}: set it, where the Host is started, to a ` +
        'command that reads a prompt on stdin and prints the Minutes, such as ' +
        '"ollama run <model>". The README says more. Recording and the Transcript work ' +
        'without it.',
    );
  }
  const program = command.split(/\s+/)[0] ?? '';
  if (SHELL_WORDS.has(program)) return command;
  const candidates = program.includes('/')
    ? [program]
    : path.split(delimiter).filter((dir) => dir !== '').map((dir) => join(dir, program));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return command;
    } catch {
      // Not this one; try the next directory.
    }
  }
  throw badInput(
    `${MINUTES_VARIABLE} names "${program}", which is not found on the Host's PATH. ` +
      'Give its absolute path: a command installed through nvm is not on the PATH of the ' +
      'Host service.',
  );
}

/** Run the command on this prompt, and read the Minutes it prints. */
export function makeMinutes(command: string, prompt: string): Promise<Made> {
  return new Promise((done, fail) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), MINUTES_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdin.on('error', () => {});
    child.on('error', (fault) => {
      clearTimeout(timer);
      fail(fault);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') {
        const minutes = MINUTES_TIMEOUT_MS / 60_000;
        fail(new Error(`The Minutes command ran for ${minutes} minutes and was stopped.`));
        return;
      }
      if (code !== 0) {
        const said = stderr.trim().split('\n').pop() ?? '';
        const why = said === '' ? '.' : `: ${said}`;
        fail(new Error(`The Minutes command exited with ${code}${why}`));
        return;
      }
      const made = readAnswer(stdout);
      if (made.minutes === '') {
        fail(new Error('The Minutes command printed no Minutes.'));
        return;
      }
      done(made);
    });
    child.stdin.end(prompt);
  });
}

/** The title, the Minutes and the Topics out of what the command printed. */
function readAnswer(stdout: string): Made {
  let text = stdout.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // The Topics come out first, wherever the model put them: inside a code
  // fence or outside it, the Minutes must never carry them.
  const block = /<topics>([\s\S]*?)<\/topics>/i.exec(text);
  const topics = block === null ? null : topicsOf(block[1] ?? '');
  if (block !== null) {
    text = (text.slice(0, block.index) + text.slice(block.index + block[0].length)).trim();
  }
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fence !== null) text = (fence[1] ?? '').trim();
  const lines = text.split('\n');
  const titled = /^\**\s*(?:TITLE|T[IÍ]TULO)\s*:\s*\**\s*(.+?)\s*\**$/i.exec(lines[0] ?? '');
  if (titled === null) return { title: null, minutes: text, topics };
  const title = (titled[1] ?? '').replace(/^["“]|["”]$/g, '').trim();
  return {
    title: title === '' ? null : title,
    minutes: lines.slice(1).join('\n').trim(),
    topics,
  };
}

/** The Topics as kept: trimmed, cut at the most lines, or null when empty. */
function topicsOf(block: string): string | null {
  const lines = block.trim().split('\n').slice(0, MOST_TOPICS_LINES);
  const topics = lines.join('\n').trim();
  return topics === '' ? null : topics;
}
