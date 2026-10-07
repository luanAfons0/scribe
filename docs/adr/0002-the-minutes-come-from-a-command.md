# The Minutes come from a command

scribe makes the Minutes by running the command in `SCRIBE_MINUTES_COMMAND`.
It writes the prompt — the Jottings, the Transcript and the rules — to the
command's stdin, and reads the Minutes from its stdout. scribe knows no model,
holds no key and has no default command. The command is a program and its
arguments, run with no shell (ADR-0003).

Any tool that reads a prompt and prints text will do: a local model through
`ollama run`, or a cloud CLI. The operator chose Claude Code in print mode
(`claude -p`), and the README says so, with a warning that it sends the
Jottings and the Transcript off this machine and the local command to use
instead. The audio is never sent: it is deleted once Whisper has read it.

## Consequences

With no command set, or one that is not found, a Call still records and its
Transcript is still made. Only Make Minutes is refused, with a sentence that
names `SCRIBE_MINUTES_COMMAND`.

The choice of model is the operator's and can change without a change to
scribe. When FirstMate has Sampling, scribe may ask the Host for a model
instead; this decision does not wait for it.

A command installed through nvm is not on the Host's service PATH, so it needs
its absolute path.

## Amended

The operator now sets the Minutes command in Settings on the Plugin Page, and
scribe keeps it in `settings.json` in its own directory (ADR-0004).
`SCRIBE_MINUTES_COMMAND` still beats the file, and the file beats the default,
which is still no command. Make Minutes with none says to set one in Settings.
