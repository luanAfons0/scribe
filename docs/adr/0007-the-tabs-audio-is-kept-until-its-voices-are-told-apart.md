---
status: proposed
---

# The tab's audio is kept until its voices are told apart

scribe told people apart by track alone: `Você` for the mic, `Outros` for
the tab. To tell the people in the tab apart, a diarizer (sherpa-onnx) must
read the whole Call at once: run on one window at a time, the "Pessoa 1" of
one window is not the "Pessoa 1" of the next.

So the tab's audio of a Call is kept in `audio/` until the Call stops and the
diarizer has read it, and is then deleted. **This reverses the rule that a
chunk is deleted as soon as Whisper has read it**, for the tab's track. The
mic's track is never diarized, and is still deleted at once.

## Considered Options

- **One window at a time.** Rejected: the labels change from window to
  window, which is no use to the Minutes.
- **A voiceprint per window, grouped by scribe.** It keeps numbers, not
  audio, but needs code of scribe's own over a library sherpa-onnx ships no
  program for. Kept for later, if keeping the audio proves wrong.

## Consequences

The audio still never leaves the machine, and is never kept past the Call.
Without the diarizer set, nothing changes: each chunk is deleted once Whisper
has read it, and the tab's lines stay `Outros`.

A Call that is Cut leaves its tab's audio behind. The next start deletes it
without telling its voices apart, as it makes no Minutes on its own: the
Call's tab lines stay `Outros`.

Voices are named per Call. scribe keeps no voiceprint between Calls: it would
be biometric data of people who never agreed to it.

Status is proposed until a spike measures the diarizer on a real Call in
Portuguese.
