/* The Popup: the Jottings of the Call that records, and Stop, in the small
   window FirstMate opens over the call (jot.html). It asks the Plugin Server
   for the Call that records, keeps every change to its Jottings at once, as
   the Call's page does, and never records (ADR-0008).

   FirstMate unloads the Popup each time it hides, so each Shortcut press
   loads this page fresh and reads the Jottings again. While it shows, it
   asks again every few seconds, so a Call stopped on the Call's page, or Cut, turns
   into the empty state. */
'use strict';

const byId = (id) => document.getElementById(id);
const liveHead = byId('jot-live');
const titleText = byId('jot-title');
const timeText = byId('jot-time');
const stopButton = byId('jot-stop');
const jotBody = byId('jot-body');
const jotBox = byId('jot-jottings');
const emptyState = byId('jot-empty');
const said = byId('jot-said');

/** What the foot says while a Call records and nothing is wrong. */
const KEPT = 'Every change is kept at once.';

/** How often the Popup asks again whether the Call still records. */
const ASK_AGAIN_MS = 2000;

/** The Call that records, as last read, or null when none does. */
let recording = null;

/** Whether the box has had focus once, since the Popup loaded. */
let focused = false;

let again = null;

/** Say what went wrong in the foot, or what the foot says, with null. */
function say(fault) {
  said.classList.toggle('fault', fault !== null);
  if (fault !== null) said.textContent = fault.message || String(fault);
  else said.textContent = recording === null ? 'scribe' : KEPT;
}

const jottings = keepJottings(jotBox, say);

/** How long the Call that records has run. */
function tick() {
  if (recording === null) return;
  timeText.textContent = clock(Date.now() - Date.parse(recording.startedAt));
}

/** Draw the Call that records, or the empty state, and ask again soon. */
async function draw() {
  clearTimeout(again);
  try {
    const mark = jottings.mark();
    const running = (await call('get_call')).call;
    // A Call that stopped keeps what its box still held.
    if (running === null && recording !== null) jottings.save();
    recording = running;
    liveHead.hidden = running === null;
    jotBody.hidden = running === null;
    emptyState.hidden = running !== null;
    if (running !== null) {
      titleText.textContent = running.title || when(running.startedAt);
      jottings.show(running.id, running.jottings, mark);
      tick();
      if (!focused) {
        // The operator pressed the Shortcut to write: the caret waits at the end.
        focused = true;
        jotBox.focus();
        jotBox.setSelectionRange(jotBox.value.length, jotBox.value.length);
        jotBox.scrollTop = jotBox.scrollHeight;
      }
    }
    say(null);
  } catch (fault) {
    say(fault);
  }
  again = setTimeout(draw, ASK_AGAIN_MS);
}

stopButton.addEventListener('click', async () => {
  if (recording === null) return;
  stopButton.disabled = true;
  try {
    await jottings.save();
    await call('stop_call', { id: recording.id });
  } catch (fault) {
    say(fault);
  }
  stopButton.disabled = false;
  draw();
});

setInterval(tick, 1000);
draw();
