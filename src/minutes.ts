/**
 * The Minutes of a Call: a prompt made of its Jottings and its Transcript,
 * given to the Minutes command the operator chose on stdin, and the Minutes
 * read from its stdout (ADR-0002).
 *
 * scribe knows no model. The command is a program and its arguments, run with
 * no shell (ADR-0003) — `["ollama", "run", "<model>"]` — and anything that
 * reads a prompt and prints text will do. The first line of the answer is a proposed title;
 * the rest is the Minutes, as Markdown, and then the Topics in a `<topics>`
 * block, which is taken out so that the Minutes keep their shape. A model
 * that thinks out loud in a `<think>` block, or wraps its answer in a code
 * fence, is forgiven both; one that writes no Topics still gives Minutes.
 */
import type { CallView } from './calls.ts';
import type { Command } from './command.ts';
import { run } from './run.ts';

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

/** Run the command on this prompt, and read the Minutes it prints. */
export async function makeMinutes(
  command: Command,
  prompt: string,
  timeoutMs: number,
): Promise<Made> {
  const ran = await run(command, { input: prompt, timeoutMs });
  if (ran.timedOut) {
    throw new Error(
      `The Minutes command ran longer than ${duration(timeoutMs)} and was stopped, with ` +
        'every process it started.',
    );
  }
  if (ran.code !== 0) {
    const said = ran.stderr.trim().split('\n').pop() ?? '';
    const why = said === '' ? '.' : `: ${said}`;
    throw new Error(`The Minutes command exited with ${ran.code}${why}`);
  }
  const made = readAnswer(ran.stdout);
  if (made.minutes === '') throw new Error('The Minutes command printed no Minutes.');
  return made;
}

/** A time a person reads: whole minutes when it is, seconds otherwise. */
function duration(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms / 1000} s`;
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
