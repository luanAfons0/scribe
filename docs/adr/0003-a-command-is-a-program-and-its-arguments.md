# A command is a program and its arguments, run with no shell

scribe runs two programs the operator chooses: whisper.cpp, named by
`SCRIBE_WHISPER`, and the Minutes command, named by `SCRIBE_MINUTES_COMMAND`
(ADR-0002). Both run with no shell, on Windows and on Linux, because the
FirstMate App runs on both and a Linux shell is not there on Windows
(FirstMate ADR-0028).

So the Minutes command is no longer a command line that `/bin/sh -c` reads.
It is a program and a list of arguments, written as a JSON array of strings,
the program first:

```
["/home/you/.local/bin/claude", "-p", "--model", "sonnet"]
```

A JSON array is the form because it says where each argument begins and ends
with no quoting rules of a shell that is not there, every operator can read
and write it, and a settings file can hold the same array as it is. research
writes `RESEARCH_DIGEST_COMMAND` in the same form, so an operator writes both
commands one way. `src/command.ts` is the one place the form is read: the
environment gives it as text, and a settings file may give the array itself.

A program named with no directory is looked for on the `PATH`, and on Windows
with each extension in `PATHEXT`, so `claude` is found as `claude.cmd`.
Windows runs a `.cmd` or `.bat` file only through `cmd.exe`, so such a program
gets a `cmd.exe` line in which every character `cmd.exe` would read as its own
is escaped: an argument still reaches the program as it was written.

A program that runs past its time is ended with every process it started:
its process group on Linux, `taskkill /T /F` on Windows. The Minutes command
is often a wrapper that starts the real work, and ending the wrapper alone
would leave a model running and the pipe held open.

This is a small module of scribe's own (`src/run.ts`). It takes no
dependency.

## Consequences

A command line of the old form, `ollama run llama3`, is no longer read. It is
refused when the Minutes are made, with a sentence that names
`SCRIBE_MINUTES_COMMAND` and shows the form, and recording and the Transcript
work as before (ADR-0002).

A command can no longer use what a shell gives: `&&`, `|`, `cd`, `$VAR`. One
that needs them is a script of the operator's, named as the program.

The `sh` wrapper `mcp` stays, for a `wsl` Place, and is the one file of
scribe that `sh` runs.
