# scribe is set up on its Plugin Page, and runs without whisper.cpp

scribe used to read whisper.cpp, its model, the Minutes command and the
Worklog Plugin from its environment alone, which is the Host's. A missing
whisper.cpp or model was one sentence and an exit at start: the Plugin showed
Stopped, and the reason was in the journal.

That fit a Host started by a systemd unit, where the operator writes the
environment by hand. The FirstMate App starts the Host on Windows and on
Linux (FirstMate ADR-0028), and it has no unit to write a drop-in for. An
operator there could not set scribe up at all, and a scribe with no whisper.cpp
was a Plugin with no Plugin Page to say so.

So the four settings an operator chooses move into `settings.json`, in
scribe's own Plugin directory beside `scribe.db` (FirstMate ADR-0005), and the
Plugin Page reads and changes them through two tools, `get_settings` and
`update_settings`. The variable of the same name still beats the file, and the
file beats the default, which is none. research keeps its Digest command the
same way, in a file of the same name, through tools of the same names.

And a missing whisper.cpp no longer ends the Plugin Server. **This reverses
the rule that scribe exits at start without whisper.cpp or its model.** The
Plugin Server starts, answers the handshake, and keeps its Plugin Page, which
is where the setting is fixed. What is missing is one sentence that names the
setting: beside it on the Page, on the list of Calls, and as the refusal of
`start_call`. A Call never starts without whisper.cpp, because its audio would
wait for a Whisper that is not there.

A settings file that is not JSON does not end the Plugin Server either. The
sentence that says so is shown beside every setting the file would decide,
and saving from the Page writes a new file in its place.

A variable that is set and not in its form does not decide. It is ignored, so
the settings file decides, then the default, and `get_settings` and the
Settings view show one sentence beside the setting, in `ignored`, that says the
variable was ignored and to remove it from where the Host is started. The
variable a 1.x systemd drop-in still sets, `SCRIBE_MINUTES_COMMAND` as a shell
line, is the case this is for: the operator sets the command on the Page and
needs nothing else. research ignores `RESEARCH_DIGEST_COMMAND` the same way.

## Consequences

The Index Page shows scribe running even when it cannot record. The Plugin
Page is where an operator learns why, not the journal.

A bad value is refused by `update_settings` with one sentence, and the file is
left as it was. Only the form is checked there: an absolute path for
whisper.cpp and its model, a program and its arguments for the Minutes command
(ADR-0003), a Registry name for the Worklog Plugin. Whether a path leads to a
file, or a program is on the `PATH`, is read each time it is used, and shown as
a problem beside the setting, so a setting can be saved before whisper.cpp is
built.

whisper.cpp and the Minutes command are read each time they are used, so a
change on the Page takes effect from the next window and the next Minutes,
with no restart.

The times stay in the environment alone: `SCRIBE_CUT_AFTER_MS`,
`SCRIBE_WORKLOG_WAIT_MS` and `SCRIBE_MINUTES_TIMEOUT_MS`. One that is not a
whole number still ends the Plugin Server at start, and so does a `scribe.db`
it cannot open: nobody sets either from the Page.
