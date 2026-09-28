# scribe

A FirstMate Plugin that records a call in a browser tab, writes down what was
said, and makes the Minutes from what you typed during it. The audio and the
text stay on this machine.

Read [`CONTEXT.md`](CONTEXT.md) for the words this project uses — Call,
Jottings, Transcript, Minutes, Cut — and [`docs/adr/`](docs/adr) for why a Call
is recorded in a browser tab and why the Minutes come from a command.

## What it needs

- **Node 24 or newer**, for TypeScript with no build step and for
  `node:sqlite`. The Host's service `PATH` often has only an older Node, so
  `mcp` looks for one in this order: `SCRIBE_NODE`, `node` on `PATH`, then
  every Node under nvm. With none, it says so in one sentence and the Plugin
  is Stopped.
- **whisper.cpp** and its `small` model, which turn the audio into the
  Transcript on the CPU.
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
| `SCRIBE_MINUTES_COMMAND` | The command that makes the Minutes. Optional; see below. |
| `SCRIBE_NODE`            | The Node 24 that `mcp` runs, when `PATH` has none.       |
| `SCRIBE_CUT_AFTER_MS`    | How long a Call may go without audio before it is Cut. Default 60000. |

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
   30 seconds. Lines from your mic are `Eu`; lines from the tab are `Outros`.
4. Press **Stop**, or *Stop sharing* in Chrome's bar. Whisper reads what is
   left.

Keep the recording tab open until you press Stop. Only one Call records at a
time; a second Start is refused with a sentence that names the running one.

v1 assumes headphones. On speakers, the mic hears the other people too, and
their words can show up as `Eu` lines as well as `Outros` ones.

The audio goes to the Plugin Server in chunks of five seconds and waits in
`audio/`, in the Plugin's directory, only until Whisper has read it. Silence
is never given to Whisper, because Whisper makes words up out of silence.

### The Minutes

When you press Stop and Whisper has read the last of the audio, scribe makes
the Minutes at once with the command in `SCRIBE_MINUTES_COMMAND`. It writes a
prompt to the command's stdin — your Jottings, the Transcript, and the rules —
and reads the Minutes from its stdout. The rules ask for:

- your Jottings' headings, in your order, with what the Transcript says under
  each;
- `Decisões` and `Próximos passos` at the end;
- the language of the Call;
- a title on the first line, which replaces the date and time in the list.

The Call's page shows the Minutes formatted. **Make Minutes again** runs the
command again, for example after you edit the Jottings, and on a Cut Call it
is how you get Minutes at all.

scribe knows no model and holds no key (ADR-0002). Any command that reads a
prompt on stdin and prints text will do. **Use a local model**, through
[Ollama](https://ollama.com):

```ini
Environment=SCRIBE_MINUTES_COMMAND=/usr/local/bin/ollama run <model>
```

The recommended model is still to be chosen on a real Call (scribe#7).

> **A cloud CLI sends the Transcript off this machine.** `claude -p` or
> `codex exec -` work as the command, but every word of the Call then goes to
> that service. The local path is the documented one.

The command runs under the Host's service, whose `PATH` has no nvm. A command
installed through nvm (`claude`, `codex`) needs its absolute path, such as
`/home/you/.nvm/versions/node/v24.15.0/bin/claude -p`.

With no command set, recording and the Transcript still work. Only Make Minutes
is refused, with a sentence that names `SCRIBE_MINUTES_COMMAND`. A command that
fails leaves the Minutes failed, with the last line it said on stderr.

### Jottings in the Popup

Bind a FirstMate Shortcut to scribe's Popup page once, and restart the Host:

```sh
firstmate bind Ctrl+Alt+J scribe popup.html
systemctl --user restart firstmate
```

During a Call, press the Shortcut. The Popup shows the red line, how long the
Call has run, and its Jottings. Type a line; it is kept at once. Click back
into the call: the Popup hides and nothing stops. Open it again and every line
is there. A line that starts with `#` is a heading. **Stop** in the Popup ends
the Call the tab records.

The Call's page in the tab has the same Jottings box, before and after Stop.

### A Cut Call

When the recording tab closes, the browser quits or the machine sleeps, no
audio comes. After `SCRIBE_CUT_AFTER_MS` of none (a minute), the Call is
**Cut**: it keeps its Transcript so far and shows as Cut in the list. The same
happens when the Plugin Server stops during a Call: the next time it starts,
it marks that Call Cut and gives the audio it left to Whisper. A new Call can
start at once.

## Running it

`./mcp` is the Plugin Server, as the Host runs it: MCP over stdio.
`npm run check` checks the types and runs every test.
