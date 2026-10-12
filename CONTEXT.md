# scribe

scribe is a FirstMate Plugin. It records a call from the FirstMate window,
writes down what was said, and makes the Minutes of it from what you typed
during the call. It keeps the text and never the audio: each chunk of audio
is deleted as soon as Whisper has read it.

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
Everything Whisper heard in a Call, line by line, each line labelled with its
Speaker. Nobody edits its words: it is the record of the Call.
_Avoid_: captions, subtitles, log

**Minutes**:
Your Jottings, made better with the Transcript, in the language of the Call.
They keep your headings and their order, and end with `Decisões` and
`Próximos passos`.
_Avoid_: summary, enhanced notes, recap

**Topics**:
The few lines Worklog gets from a Call: the topics it talked about, then a
summary of one to three sentences, at most 20 lines, in the language of the
Call. The Minutes command writes them in the same answer as the Minutes, and
they are never part of the Minutes.
_Avoid_: summary, recap, digest

**Cut**:
A Call that ended because its recording page or its Plugin Server went away,
not because you pressed Stop. It keeps its Jottings and its Transcript so far,
and Minutes can still be made from it.
_Avoid_: crashed, failed, aborted

**Event**:
One entry of the operator's Google Calendar that has a Google Meet link and
starts at a set time. scribe reads it, and gives a Notice a minute before it
starts. It is not a Call: a Call exists only from Start.
_Avoid_: meeting (Worklog's word), appointment, scheduled call

**Speaker**:
Who a Transcript line is from: `Você` (your mic), one person told apart in the
call's sound (`Pessoa 1`, `Pessoa 2`… until you name them), or `Outros` when the
people in the call's sound were not told apart. Names belong to one Call.
_Avoid_: voice, participant, attendee

## Relationships

- A Call has one set of Jottings, one Transcript, at most one Minutes and at
  most one set of Topics. The Topics change only when the command makes the
  Minutes again, never when the Minutes are edited by hand.
- A Transcript line comes from one track: the mic (`Você`) or the call's
  sound, which the code names `tab` (ADR-0008). Lines from the call's sound
  are `Outros` while the Call records, and get a Speaker each once
  the Call stops and its voices are told apart (ADR-0007).
- Two Speakers given the same name are one person.
- The Minutes are made from the Jottings and the Transcript by a command you
  choose. scribe knows no model (ADR-0002).
- An Event may become a Call, when you press Start from five minutes before it
  until it ends; of two such Events, the one that started last. The Call takes
  the Event's name as a title you gave.
- The Topics go to Worklog only when you press Send to Worklog, never on their
  own. Sending again changes the same Entry.
- A Call has a title once the Minutes propose one or you give one. Until then,
  the moment it started stands in for it.

## Flagged ambiguities

- "Notes" is what Granola calls both what you type and what it makes. Here
  they are two words: **Jottings** are yours, **Minutes** are made.
- "Meeting" is Worklog's word for the recurring team meeting. A Call may be
  one, but scribe does not know or care.
