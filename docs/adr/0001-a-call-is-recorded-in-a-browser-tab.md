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

The Popup is for the Jottings and for Stop, and holds no state of its own: it
reads everything from the Plugin Server each time it opens.
