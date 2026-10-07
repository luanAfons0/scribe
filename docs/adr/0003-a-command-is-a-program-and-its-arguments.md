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
its process group on Linux, through `process.kill` with the group's negative
id, and its tree on Windows, through `taskkill /T /F` by its absolute path.
The Minutes command is often a wrapper that starts the real work, and ending
the wrapper alone would leave a model running and the pipe held open. So the
wrapper alone is never killed in place of its tree: a group or a tree that
cannot be ended is said on stderr.

No whisper.cpp and no Minutes command outlives the Plugin Server. When the
Host closes stdin, or a signal ends the Plugin Server, every program it
started that still runs is ended the same way, with its whole tree, before it
exits.

This is a small module of scribe's own (`src/run.ts`). It takes no
dependency.

## Consequences

A command line of the old form, `ollama run llama3`, is no longer read, and
scribe runs nothing the operator did not mean. Such a value of
`SCRIBE_MINUTES_COMMAND` does not decide: scribe ignores it, so the settings
file decides, and then the default (ADR-0004). The Settings view shows one
sentence beside the Minutes command that says the variable is ignored and to
remove it from where the Host is started. A 1.x operator who upgrades sets the
command on the Plugin Page, and removes the old line from the systemd drop-in.
Recording and the Transcript work as before (ADR-0002).

A command can no longer use what a shell gives: `&&`, `|`, `cd`, `$VAR`. One
that needs them is a script of the operator's, named as the program.

The `sh` wrapper `mcp` stays, for a `wsl` Place, and is the one file of
scribe that `sh` runs.
