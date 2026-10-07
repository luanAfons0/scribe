# scribe

A FirstMate Plugin that records a call in a browser tab, writes down what was
said, and makes the Minutes from what you typed during it. It keeps the text,
never the audio: each chunk of audio is deleted as soon as Whisper has read
it.

Read [`CONTEXT.md`](CONTEXT.md) for the words this project uses — Call,
Jottings, Transcript, Minutes, Cut — and [`docs/adr/`](docs/adr) for why a Call
is recorded in a browser tab and why the Minutes come from a command.

## What it needs

- **Node 24 or newer**, for TypeScript with no build step and for
  `node:sqlite`. The Host runs `mcp.ts` with its own Node, with no shell, on
  Windows and on Linux (FirstMate ADR-0028), so there is nothing to install.
  In a `wsl` Place the Host runs `mcp`, an `sh` wrapper, instead. The
  service's `PATH` there often has only an older Node, so `mcp` looks for one
  in this order: `SCRIBE_NODE`, `node` on `PATH`, then every Node under nvm.
  With none, it says so in one sentence and the Plugin is Stopped.
- **whisper.cpp** and its `small` model, which turn the audio into the
  Transcript on the CPU. On Windows the executable is `whisper-cli.exe`.
- **Chrome or Edge**, for the tab that records the Call. Firefox and Safari
  cannot share a tab's audio.

### Build whisper.cpp

It needs `git`, `cmake` and a C++ compiler (`sudo apt install git cmake
build-essential` on Debian). Build it somewhere outside this repository:

```sh
git clone https://github.com/ggml-org/whisper.cpp.git ~/whisper.cpp
cd ~/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh small
```

That gives the executable `~/whisper.cpp/build/bin/whisper-cli` and the model
`~/whisper.cpp/models/ggml-small.bin` (about 470 MB). `small` keeps up with a
live Call on an 8-core CPU; `medium` and `large-v3-turbo` are too slow for
that.

## Settings

The Plugin Server reads these from its environment, which is the Host's:

| Variable                 | What it is                                              |
| ------------------------ | ------------------------------------------------------- |
| `SCRIBE_WHISPER`         | The absolute path of `whisper-cli`. Required.           |
| `SCRIBE_WHISPER_MODEL`   | The absolute path of the model file. Required.          |
| `SCRIBE_MINUTES_COMMAND` | The command that makes the Minutes, as a JSON array: the program, then its arguments. Optional; see below. |
| `SCRIBE_MINUTES_TIMEOUT_MS` | How long the Minutes command may run before it is ended. Default 900000 (15 minutes). |
| `SCRIBE_NODE`            | The Node 24 that `mcp` runs in a `wsl` Place, when `PATH` has none. |
| `SCRIBE_CUT_AFTER_MS`    | How long a Call may go without audio before it is Cut. Default 60000. |
| `SCRIBE_WORKLOG_PLUGIN`  | The Registry name of the Worklog Plugin a Call's Entry goes to. Optional; see below. |
| `SCRIBE_WORKLOG_WAIT_MS` | How long scribe waits for Worklog to answer. Default 30000. |

With `SCRIBE_WHISPER` or `SCRIBE_WHISPER_MODEL` not set, or not a file, the
Plugin Server exits at start with one sentence that names it, and the Index
Page shows the Plugin Stopped. The sentence is in the journal:
`journalctl --user -u firstmate -f`.

When the Host runs as a systemd service, give it the settings with a drop-in,
which `firstmate service on` leaves alone:

```sh
systemctl --user edit firstmate
```

```ini
[Service]
Environment=SCRIBE_WHISPER=/home/you/whisper.cpp/build/bin/whisper-cli
Environment=SCRIBE_WHISPER_MODEL=/home/you/whisper.cpp/models/ggml-small.bin
```

## Install it

Register the directory where it lives, then restart the Host:

```sh
firstmate add scribe /absolute/path/to/scribe
systemctl --user restart firstmate
```

Then open the Index Page, find `scribe`, and open its Plugin Page.

## Record a Call

1. Open scribe's Plugin Page in Chrome or Edge. In the FirstMate window,
   *open in browser* in the strip does that, already admitted.
2. Press **Start a Call**. Chrome's picker opens: choose the call's tab (a
   Meet tab, say) and tick **Also share tab audio**. The page asks for the mic
   next.
3. A red line shows at the top of the page while the Call records, and the
   Transcript grows on the Call's page as Whisper reads the audio, about every
   30 seconds. Lines from your mic are `Você`; lines from the tab are `Outros`.
4. Press **Stop**, or *Stop sharing* in Chrome's bar. Whisper reads what is
   left.

Keep the recording tab open until you press Stop. Only one Call records at a
time; a second Start is refused with a sentence that names the running one.

v1 assumes headphones. On speakers, the mic hears the other people too, and
their words can show up as `Você` lines as well as `Outros` ones.

scribe keeps no recording. The audio goes to the Plugin Server in chunks of
five seconds and waits in `audio/`, in the Plugin's directory, only until
Whisper has read it — about 30 seconds — and is then deleted. What stays is
the Transcript, the Jottings and the Minutes, in `scribe.db`. Silence is never
given to Whisper, because Whisper makes words up out of silence.

### The Minutes

When you press Stop and Whisper has read the last of the audio, scribe makes
the Minutes at once with the command in `SCRIBE_MINUTES_COMMAND`. It writes a
prompt to the command's stdin — your Jottings, the Transcript, and the rules —
and reads the Minutes from its stdout. The rules ask for:

- your Jottings' headings, in your order, with what the Transcript says under
  each;
- `Decisões` and `Próximos passos` at the end;
- the language of the Call;
- a title on the first line, which replaces the date and time in the list;
- the Topics after the Minutes: what the Call talked about and a short
  summary, at most 20 lines. scribe takes them out of the Minutes and keeps
  them apart, for Worklog. A command that leaves them out still gives
  Minutes.

The Call's page shows the Minutes formatted. **Make Minutes again** runs the
command again, for example after you edit the Jottings, and on a Cut Call it
is how you get Minutes at all.

scribe knows no model and holds no key (ADR-0002). Any command that reads a
prompt on stdin and prints text will do.

`SCRIBE_MINUTES_COMMAND` is a JSON array of strings: the program first, then
each of its arguments, as `["ollama","run","<model>"]`. No shell runs it, on
any system (ADR-0003), so each argument reaches the program exactly as it is
written, spaces and quotes too, and there is no `&&`, no `|` and no `cd`. On
Windows a `.cmd` or `.bat` program, such as the `claude.cmd` npm installs, is
run through `cmd.exe` with nothing in it for `cmd.exe` to read. A program
named with no directory is looked for on the Host's `PATH`, and on Windows
with each extension in `PATHEXT`.

**The command this project uses is Claude Code in print mode:**

```ini
Environment='SCRIBE_MINUTES_COMMAND=["/home/you/.local/bin/claude","-p","--tools","","--setting-sources","","--no-session-persistence","--model","sonnet"]'
```

Why each part is there:

- `-p` reads the prompt on stdin and prints the answer.
- `--tools ""` gives it no tools: it only writes.
- `--setting-sources ""` loads no settings and no `CLAUDE.md`, so your own
  instructions (a rule to answer in English, say) do not change the Minutes.
- `--no-session-persistence` keeps no session of the Call on disk.
- `--model sonnet` wrote clear Portuguese Minutes, with the headings kept and
  a good title, from a 90-second Transcript in under a minute.

It uses the login `claude` already has, so there is no key to set.

> **This sends the Transcript off this machine.** The audio never leaves it,
> but the Jottings and every word of the Transcript go to Anthropic when the
> Minutes are made. For a Call that must stay local, use a local model
> instead, through [Ollama](https://ollama.com):
> `SCRIBE_MINUTES_COMMAND=["/usr/local/bin/ollama","run","<model>"]`. The same holds
> for any other cloud CLI, such as `["codex","exec","-"]`.

The command runs under the Host's service, whose `PATH` has no nvm and no
`~/.local/bin`. Give the command its absolute path: a command installed
through nvm needs one too, such as `/home/you/.nvm/versions/node/v24.15.0/bin/codex`.

With no command set, recording and the Transcript still work. Only Make Minutes
is refused, with a sentence that names `SCRIBE_MINUTES_COMMAND`. So is a
command that is not a JSON array of strings, or whose program is not found. A
command that fails leaves the Minutes failed, with the last line it said on
stderr. A command that runs longer than `SCRIBE_MINUTES_TIMEOUT_MS` is ended
with every process it started, and its Minutes are failed.

### An Entry in Worklog

When the command makes a Call's Minutes, scribe can send its Topics to
[Worklog](https://github.com/luanAfons0/worklog) as one `Done` Entry in the
current Cycle, over the FirstMate Tool Bus. The Entry is titled with the
Call's times, in this machine's time zone, and its title:

```
Reunião 14:00 - 15:10: Prazo da entrega
```

Its body is the Topics. Nothing else leaves scribe: not the Jottings, not the
Transcript, not the Minutes.

Turn it on in two steps. Give scribe a Grant to call Worklog, and name
Worklog in the service's drop-in, then restart the Host:

```sh
firstmate grant scribe worklog
```

```ini
Environment=SCRIBE_WORKLOG_PLUGIN=worklog
```

**Make Minutes again** changes the same Entry rather than adding one. Minutes
edited by hand send nothing. When the Entry cannot be sent — no Grant,
Worklog Stopped, no answer, or Minutes with no Topics — the Minutes stay as
they are, and the Call's page says why. Without `SCRIBE_WORKLOG_PLUGIN`, scribe
sends nothing and says nothing.

### Find a Call again

The Plugin Page lists every Call, newest first, with its title, date, length
and state. Open one to read its Minutes and its Transcript. From there:

- **Rename** gives it a title of your own. Minutes made later keep it.
- **Edit** corrects the Minutes by hand, as Markdown.
- **Delete** removes the Call with its Jottings, Transcript and Minutes, and
  any of its audio that still waits for Whisper. Nothing of it stays in the
  Plugin's directory.

The Transcript cannot be edited: it is the record of the Call.

### Jottings

The Call's page has a Jottings box, during the Call and after it. Every
change is kept at once. A line that starts with `#` is a heading, and the
Minutes keep your headings in your order.

### A Cut Call

When the recording tab closes, the browser quits or the machine sleeps, no
audio comes. After `SCRIBE_CUT_AFTER_MS` of none (a minute), the Call is
**Cut**: it keeps its Transcript so far and shows as Cut in the list. The same
happens when the Plugin Server stops during a Call: the next time it starts,
it marks that Call Cut and gives the audio it left to Whisper. A new Call can
start at once.

## Running it

`node mcp.ts` is the Plugin Server, as the Host runs it: MCP over stdio.
`./mcp` is the same Plugin Server, as the Host runs it in a `wsl` Place.
`npm run check` checks the types and runs every test, which CI does on Linux
and on Windows.
