# A Call is recorded in a browser tab

A Call is recorded by scribe's Plugin Page open in a Chromium browser tab.
The page asks for the call's tab with its audio (`getDisplayMedia`) and for
the mic (`getUserMedia`), and sends the audio to the Plugin Server as it
goes. FirstMate's window has an "Open in browser" button that opens the page
there, already admitted.

Three other places were tried and rejected:

- **The FirstMate window.** Capture works in WebView2, even while the window
  is hidden, but any navigation of the content view unloads the Plugin Page:
  a click on a Notice, the Index Page, another Plugin. That ends the Call.
- **The Popup.** It unloads its page each time it hides (FirstMate ADR-0013),
  and it hides as soon as you click back into the call.
- **A Windows helper with WASAPI loopback.** It would record all of the
  machine's audio, not the call's, and it works only on Windows.

## Consequences

The call must run in a browser tab: a call in the Zoom or Teams app has no tab
to share. Chromium shares tab audio on Windows, macOS and Linux; Firefox and
Safari do not, so they are not supported. The picker needs one human click
each time, which is also the consent.

The tab must stay open for the whole Call. When it closes, the audio stops,
and the Call is Cut rather than lost.

The Jottings and Stop are on the Call's page, in the same tab. A first
version also had them in a Popup, and the operator took it out as more than
was needed.

## Amended: the Popup comes back

The Jottings and Stop are also in the Popup again, opened by a Shortcut the
operator binds to `jot.html`. The operator took the first one out as more than
was needed, and asked for it back to write during a call without leaving it.
The Popup still never records: it shows the Jottings of the Call a tab
records, and with none, it says so and says to start one in scribe's tab. It
offers no link there: a Plugin Page in the Popup that goes to its own Host only
hides the Popup, and FirstMate gives it no way to a browser.
It unloads each time it hides, which loses nothing, because every change to
the Jottings is kept at once.
