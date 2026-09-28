# scribe

scribe is a FirstMate Plugin. It records a Call that runs in a browser tab,
turns its audio into a Transcript with whisper.cpp, and makes the Minutes from
the Jottings and the Transcript with a command the operator chooses. It is a
Plugin Server with one SQLite file behind it, and a Plugin Page.

Read [`CONTEXT.md`](CONTEXT.md) first. It defines every word this repo uses —
Call, Jottings, Transcript, Minutes, Cut — and the synonyms to avoid. It
borrows FirstMate's words (Host, Plugin, Plugin Page, Plugin Server, Popup,
Shortcut, Stopped) unchanged, from
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
| `./mcp`                              | The Plugin Server, as the Host runs it.       |

The environment variables are in the README's Settings table. Tests set every
one of them through `tests/helpers/plugin.ts`.

`npm run check` must pass before you call work done.

## Tech stack

- **Node 24**, which runs TypeScript with no build step and ships
  `node:sqlite`. No bundler, no transpiler, no watcher.
- **TypeScript 5.8**, `strict`, `noUncheckedIndexedAccess`,
  `erasableSyntaxOnly`. `typescript` is a dev dependency, used only to check
  the types.
- **No runtime dependency.** MCP over stdio is the Plugin's own JSON-RPC
  (`src/mcp.ts`); the data is `node:sqlite`.
- **whisper.cpp** is an executable the operator builds, named by
  `SCRIBE_WHISPER`. scribe runs it; it does not ship it.
- **The Page** is plain HTML, CSS and JavaScript in `web/`, served by the Host
  byte for byte (FirstMate ADR-0008). No framework, no web font, no CDN.

## Project structure

```
mcp            the executable the Host runs: find a Node 24, run src/main.ts.
src/           the Plugin Server. Every file is one job.
  main.ts      start-up: read the settings, open scribe.db, serve the tools.
  settings.ts  the environment: whisper.cpp, its model, the Minutes command.
  store.ts     scribe.db: open it, move it up to the current schema version.
  calls.ts     a Call: its rows, its state, and what the tools answer of it.
  tools.ts     the tools this Plugin ships, for the Page and the Popup.
  mcp.ts       the one connection to the Host: MCP over stdio.
web/           the Plugin Page, as the Host serves it.
  index.html   the Plugin Page, drawn by app.js.
  rpc.js       call(): one tool call over POST rpc.
  app.css      the one stylesheet.
tests/         one file per behaviour, plus helpers/ and fixtures/.
  fixtures/    whisper, a fixture whisper.cpp, and the files it needs.
docs/adr/      the decisions that are expensive to reverse.
docs/agents/   how an agent works in this repo. See "Agent skills" below.
```

`scribe.db` and `audio/` are this machine's Calls, not the project's. Git
ignores both.

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

- **The Plugin Server**: `tests/helpers/plugin.ts` spawns the real `mcp`
  against a temporary Plugin directory and speaks to it exactly as the Host
  does. A test sees what the Host sees: JSON-RPC lines on stdout,
  diagnostics on stderr, the exit code, and the files in the directory.
- **whisper.cpp and the Minutes command are fixture executables** in
  `tests/fixtures/`, reached through `SCRIBE_WHISPER` and
  `SCRIBE_MINUTES_COMMAND`. Add a fixture rather than a mock.
- **The Page as bytes**: `tests/page.test.ts` reads `web/` off disk, because
  no test drives a browser. Recording needs a human click in Chrome's picker,
  so it is checked by hand.
- A test name is a sentence about behaviour:
  `'with SCRIBE_WHISPER not set, it exits with a sentence that names it'`.

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
  the Page and the Popup.
- A schema change to `scribe.db`. It is a new step at the end of `STEPS` in
  `src/store.ts`, never an edit to a step that shipped.
- Anything that reverses an ADR.
- Anything that writes inside `~/.firstmate`, or restarts the Host.

🚫 **Never**

- Keep audio longer than it takes Whisper to read it.
- Send the audio, the Jottings or the Transcript anywhere but the Minutes
  command the operator set. scribe knows no model and holds no key (ADR-0002).
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
