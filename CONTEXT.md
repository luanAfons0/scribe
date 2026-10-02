# scribe

scribe is a FirstMate Plugin. It records a call that runs in a browser tab,
writes down what was said, and makes the Minutes of it from what you typed
during the call. The audio and the text stay on this machine.

It is a Plugin like any other, so it borrows FirstMate's words unchanged —
Host, Plugin, Plugin Page, Plugin Server, Stopped. They are
defined once, in
[FirstMate's `CONTEXT.md`](https://github.com/luanAfons0/FirstMate/blob/main/CONTEXT.md),
and this file never redefines one.

## Language

**Call**:
One recording, from Start to Stop. It is `recording`, `ended` or `cut`, and
only one Call records at a time.
_Avoid_: meeting (Worklog's word), session, recording

**Jottings**:
What you type during a Call: plain text, where a line that starts with `#` is
a heading.
_Avoid_: notes (Worklog's Note), draft

**Transcript**:
Everything Whisper heard in a Call, line by line, each line labelled `Eu`
(your mic) or `Outros` (the call's audio, from the shared tab). Nobody edits
it: it is the record of the Call.
_Avoid_: captions, subtitles, log

**Minutes**:
Your Jottings, made better with the Transcript, in the language of the Call.
They keep your headings and their order, and end with `Decisões` and
`Próximos passos`.
_Avoid_: summary, enhanced notes, recap

**Cut**:
A Call that ended because its recording page or its Plugin Server went away,
not because you pressed Stop. It keeps its Jottings and its Transcript so far,
and Minutes can still be made from it.
_Avoid_: crashed, failed, aborted

## Relationships

- A Call has one set of Jottings, one Transcript and at most one Minutes.
- A Transcript line comes from one track: the mic (`Eu`) or the tab (`Outros`).
  scribe tells people apart by track and nothing else.
- The Minutes are made from the Jottings and the Transcript by a command you
  choose. scribe knows no model (ADR-0002).
- A Call has a title once the Minutes propose one or you give one. Until then,
  the moment it started stands in for it.

## Flagged ambiguities

- "Notes" is what Granola calls both what you type and what it makes. Here
  they are two words: **Jottings** are yours, **Minutes** are made.
- "Meeting" is Worklog's word for the recurring team meeting. A Call may be
  one, but scribe does not know or care.
