# A Call is recorded in the FirstMate window

Supersedes [ADR-0001](0001-a-call-is-recorded-in-a-browser-tab.md).

scribe's Plugin Page records a Call in the FirstMate App's window. The page
asks for a capture with its sound (`getDisplayMedia`) and for the mic
(`getUserMedia`), and sends the audio to the Plugin Server as it goes. The App
asks the operator once for each device, and keeps the answer for scribe. Then,
at each Start, it asks "What may scribe capture?", with one button for each
screen or window.

ADR-0001 put the recording page in a browser tab, because the old window
unloaded the Plugin Page at each navigation, and that ended the Call. The App
of FirstMate 2.0 is an Electron program. It gives each Plugin Page a view of
its own, which stays loaded until the App quits. The operator can switch to
another Plugin or hide the window, and the Call continues to record. FirstMate
also took "Open in browser" out of its strip, because it is a desktop tool
(FirstMate#211, closed as not planned).

## Consequences

On Windows, the App gives the capture the sound of the whole machine
(loopback), whatever screen or window the operator chooses. So the call can
run in any app: Google Meet in a browser, or the Zoom or Teams desktop app,
which ADR-0001 could not record because it has no tab to share. Any other sound the machine plays goes into the same track,
and Whisper writes it down as part of the call.

On Linux, the App gives a capture with no sound (FirstMate ADR-0026). scribe
refuses such a capture before it asks for the mic: it says why and starts no
Call. It does not fall back to the mic alone, so no Call records on Linux for
now.

Each Start needs one human click in the App's dialog, which is also the
consent. The Call records while the App runs. When the App quits or the
machine sleeps, the audio stops, and the Call is Cut rather than lost.

The track of the call's sound keeps the name `tab`: in `append_audio`, in
`scribe.db` and in the code. The name is part of a tool's input and of the
schema, and a new name is not worth a change to either.

## The Popup still never records

The amendment to ADR-0001 still applies. The Popup shows the Jottings of the
Call that records, and Stop, and it never records. It unloads its page each
time it hides (FirstMate ADR-0013), and it hides as soon as you click back
into the call. With no Call recording, it says so, and says to start one on
scribe's page in the FirstMate window. It offers no link there: a Plugin Page
in the Popup that goes to its own Host only hides the Popup.

## Considered Options

- **Bring "Open in browser" back to the App's strip** (FirstMate#211).
  Rejected: FirstMate is a desktop tool, and a browser tab can share only the
  sound of a call that also runs in a browser.
- **A Windows helper with WASAPI loopback.** ADR-0001 rejected it because it
  records all of the machine's sound, not the call's. The App's loopback does
  the same, and scribe now accepts that: it is what lets scribe record a call
  in the Zoom or Teams app, with no helper of scribe's own.
