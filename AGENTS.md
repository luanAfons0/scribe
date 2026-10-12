# scribe

scribe is a FirstMate Plugin. It records a Call that runs in a browser tab,
turns its audio into a Transcript with whisper.cpp, and makes the Minutes from
the Jottings and the Transcript with a command the operator chooses. It is a
Plugin Server with one SQLite file behind it, and a Plugin Page.

Read [`CONTEXT.md`](CONTEXT.md) first. It defines every word this repo uses —
Call, Jottings, Transcript, Minutes, Topics, Cut — and the synonyms to avoid. It
borrows FirstMate's words (Host, Plugin, Plugin Page, Plugin Server,
Stopped) unchanged, from
[FirstMate's `CONTEXT.md`](https://github.com/luanAfons0/FirstMate/blob/main/CONTEXT.md).
Use those words in code, in comments, in tests, in issues and in commit
messages.

Read the ADR that covers the area you are about to change:
[`docs/adr/`](docs/adr), and FirstMate's own where the Host is involved
(0003, 0005, 0008, 0013). If your change contradicts one, say so out loud
instead of overriding it quietly.

## Commands

Run every command from the repository root.

| Command                              | What it does                                  |
| ------------------------------------ | --------------------------------------------- |
| `node --test`                        | Every test. This is the whole suite.          |
| `node --test tests/settings.test.ts` | One test file, while you work on it.          |
| `npm install && npx tsc --noEmit`    | Check the types. `npm run typecheck` is the same. |
| `npm run check`                      | The types, then every test. CI runs it.       |
| `node mcp.ts`                        | The Plugin Server, as the Host runs it.       |
| `./mcp`                              | The same, as the Host runs it in a `wsl` Place. |

The settings and the environment variables are in the README's "Set it up".
Tests set every variable through `tests/helpers/plugin.ts`, and the settings
file through `update_settings`.

`npm run check` must pass before you call work done.

## Tech stack

- **Node 24**, which runs TypeScript with no build step and ships
  `node:sqlite`. No bundler, no transpiler, no watcher.
- **TypeScript 5.8**, `strict`, `noUncheckedIndexedAccess`,
  `erasableSyntaxOnly`. `typescript` is a dev dependency, used only to check
  the types.
- **No runtime dependency.** MCP over stdio is the Plugin's own JSON-RPC
  (`src/mcp.ts`); the data is `node:sqlite`.
- **whisper.cpp** is an executable scribe runs and does not ship. The
  operator fetches a build and a model from the Plugin Page, each checked
  against a SHA-256 pinned in `src/downloads.json`, or builds it and sets its
  path there. Without it scribe runs and refuses to record (ADR-0004,
  ADR-0005). A build is unpacked by scribe's own reader over `node:zlib`.
- **Windows and Linux**, both, as the FirstMate App runs on both (FirstMate
  ADR-0028). No source file runs a shell: whisper.cpp and the Minutes command
  are a program and its arguments (ADR-0003). CI runs every test on both.
- **The Page** is plain HTML, CSS and JavaScript in `web/`, served by the Host
  byte for byte (FirstMate ADR-0008). No framework, no web font, no CDN.

## Project structure

```
mcp.ts         the entry point the Host runs with its own Node, on every system.
mcp            the sh wrapper for a wsl Place: find a Node 24, run src/main.ts.
src/           the Plugin Server. Every file is one job.
  main.ts      start-up: read the settings, open scribe.db, serve the tools.
  settings.ts  the settings the operator chooses, from the environment and
               settings.json, each with its problem; and the times, from the
               environment alone (ADR-0004).
  settings-file.ts settings.json in the Plugin directory: read it, and write
               it whole through a rename.
  downloads.ts what can be fetched: read downloads.json, or the list
               SCRIBE_DOWNLOADS names (ADR-0005).
  downloads.json each whisper.cpp build and model, with its URL, size and
               pinned SHA-256, as data.
  fetcher.ts   fetch a build or a model when the Page asks, check it, keep it
               under downloads/, and set it.
  unpack.ts    a zip or a tar.gz, unpacked inside one directory, by scribe's
               own reader over node:zlib.
  command.ts   a command's form, a JSON array of program and arguments, read
               in one place; and its program, found on the PATH.
  run.ts       run a program with no shell, on Windows and Linux, and end its
               whole tree when it runs past its time (ADR-0003).
  store.ts     scribe.db: open it, move it up to the current schema version.
  calls.ts     a Call: its rows, its state, and what the tools answer of it.
  audio.ts     chunk files in audio/, joined into windows cut at silence.
  recorder.ts  the Call that records: its tracks, its chunks, and its Cut.
  transcriber.ts the windows, given to whisper.cpp one at a time, and the
               Transcript lines it heard.
  minutes.ts   the prompt, the Minutes command, and the title it proposes.
  minutes-maker.ts when the Minutes are made: after Stop, and on request.
  worklog-entry.ts the Call's Entry in Worklog, sent only by send_to_worklog,
               when the operator presses Send to Worklog: its title, its
               Topics, and why it was not sent, when it was not.
  ical.ts      the iCal text, read by scribe's own reader: unfolded lines,
               properties, and times through Intl (ADR-0006).
  events.ts    which entries of the feed are Events, and when each happens.
  calendar.ts  the calendar's secret address, read now and every few
               minutes; the Events, held in memory; the last read's result.
  bus.ts       the Tool Bus, from this end of the pipe: ask the Host to call
               another Plugin's tool, and read its answer by id.
  tools.ts     the tools this Plugin ships, for the Page.
  mcp.ts       the one connection to the Host: MCP over stdio.
web/           the Plugin Page, as the Host serves it.
  index.html   the Plugin Page, drawn by app.js.
  rpc.js       call(): one tool call over POST rpc.
  app.js       the list of Calls, one Call, and Start and Stop.
  settings.js  the Settings view: the settings, who decides each, and
               what is missing.
  calendar.js  the calendar's secret address in Settings: masked once saved,
               and what its last read gave.
  downloads.js the offers to fetch whisper.cpp and a model, and how far each
               download got.
  jottings.js  keepJottings(): the box that keeps every change at once, and
               takes the text the Popup saved.
  jot.html     the Popup a Shortcut opens: the Jottings of the Call that
               records, and Stop. It never records (ADR-0001).
  jot.js       draws jot.html. jot.css is its look, on top of app.css.
  shortcut.js  the Settings view's firstmate bind command line, and Copy.
  markdown.js  the small Markdown renderer for the Minutes, as Worklog's.
  capture.js   startCapture(): the tab and the mic, sent in chunks (ADR-0001).
  pcm-tap.js   the AudioWorklet that cuts a track into 16-bit PCM chunks.
  app.css      the one stylesheet.
tests/         one file per behaviour, plus helpers/ and fixtures/.
  fixtures/    whisper and minutes, fixture executables, each with its Windows
               form beside it (whisper.cmd, minutes.cmd), and model.bin;
               whisper-build.zip and .tar.gz, the fixture whisper packed as a
               build; escape.zip and .tar.gz, builds that reach outside.
docs/adr/      the decisions that are expensive to reverse.
docs/agents/   how an agent works in this repo. See "Agent skills" below.
```

`scribe.db`, `settings.json`, `audio/` and `downloads/` are this machine's,
not the project's. Git ignores all four.

## Code style

- A file starts with a header comment: what this file is, then why it is that
  way. Every exported name carries a one-line `/** … */`.
- Comments say **why**, in the project's words, and name the ADR when a
  decision is behind the code (`(ADR-0001)`, `(FirstMate ADR-0008)`).
- Plain functions and object literals. No classes, no default exports, no
  inheritance, no framework.
- `readonly` on every field of an exported type. Data in, data out.
- Node built-ins carry the `node:` prefix. Local imports carry the `.ts`
  extension, because Node runs the TypeScript directly.
- Single quotes, semicolons, two-space indent, lines under 100 columns. There
  is no formatter config; match the file you are in.
- Errors are sentences a person can act on, naming the tool and the field.
  A caller's mistake is `badInput(…)`, refused as bad arguments. Fail loudly
  and early; say nothing when nothing is wrong.

## Testing

`node --test`. There are two seams, and no test imports a module of `src/`.

- **The Plugin Server**: `tests/helpers/plugin.ts` starts the real `mcp.ts`
  with the running Node and no shell, as the Host does, against a temporary
  Plugin directory, and speaks to it exactly as the Host does. A test asks
  for the `sh` wrapper `mcp` with `wrapper: true`. A test sees what the Host sees: JSON-RPC lines on stdout,
  diagnostics on stderr, the exit code, and the files in the directory.
- **whisper.cpp and the Minutes command are fixture executables** in
  `tests/fixtures/`, reached through `SCRIBE_WHISPER` and
  `SCRIBE_MINUTES_COMMAND`, or through `update_settings`. Add a fixture rather than a mock, with its
  Windows form, a `.cmd` that hands it to `node`; `fixture(name)` picks the
  one this system runs.
- **Downloads come from a local server**, `tests/helpers/server.ts`, never
  the network. It writes the list of downloads scribe reads through
  `SCRIBE_DOWNLOADS`, with the SHA-256 of the fixture archives.
- The suite runs on Linux and on Windows. A test that only makes sense on one
  skips on the other and says why, as `wrapper.test.ts` does.
- **The Page as bytes**: `tests/page.test.ts` reads `web/` off disk, because
  no test drives a browser. Recording needs a human click in Chrome's picker,
  so it is checked by hand.
- A test name is a sentence about behaviour:
  `'with no whisper.cpp set, recording is refused with a sentence that names the setting'`.

## Git workflow

- Branch `main`. The remote is GitHub: `luanAfons0/scribe`, so use `gh`.
- A commit subject is one imperative sentence in the project's own words, with
  no prefix, no scope and no ticket number: `Record a Call with a live
  Transcript`.
- One commit is one whole, working change: code, tests and docs together.
- Never add attribution, co-author or "generated by" lines.

## Boundaries

✅ **Always**

- Read `CONTEXT.md` and the ADRs of the area first, and use their words.
- Keep tests black-box, through the two seams.
- Update `README.md` when you change a tool, its input or output, or an
  environment variable.
- Leave `npm run check` green.

⚠️ **Ask first**

- Any `git add`, `git commit`, `git push`, or anything that opens a PR.
- Adding a dependency of any kind.
- Changing the name, input or output of a tool: they are the contract with
  the Page.
- A schema change to `scribe.db`. It is a new step at the end of `STEPS` in
  `src/store.ts`, never an edit to a step that shipped.
- Anything that reverses an ADR.
- Anything that writes inside `~/.firstmate`, or restarts the Host.

🚫 **Never**

- Keep audio longer than it takes Whisper to read it.
- Send the audio, the Jottings or the Transcript anywhere but the Minutes
  command the operator set. scribe knows no model and holds no key (ADR-0002).
  Worklog gets a Call's title, its times and its Topics, and nothing else,
  and only on Send to Worklog.
- Edit a Transcript. It is the record of the Call.
- Record in the FirstMate window or the Popup (ADR-0001).
- Tell the other people on the call anything, or join or post to a call.
- Load anything from a CDN, or name an absolute path in the Page.
- Print or commit a real `scribe.db`, FirstMate's token or `runtime.json`.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `luanAfons0/scribe`, driven by the `gh` CLI.
See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical triage roles, each label string equal to its name. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](docs/agents/domain.md).
