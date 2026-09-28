/* The Popup: the Call that records now, how long it has run, its Jottings and
   Stop. Nothing here is kept in the page; each time the Shortcut opens it, it
   asks the Plugin Server again. The recording itself is in a browser tab, and
   Stop here ends it there too: the tab is told the next time it sends. */
'use strict';

const byId = (id) => document.getElementById(id);
const banner = byId('banner');
const live = byId('live');
const liveText = byId('live-text');
const stopButton = byId('stop');
const noCall = byId('no-call');
const stopped = byId('stopped');
const label = byId('jottings-label');
const box = byId('jottings');

function say(fault) {
  banner.hidden = fault === null;
  banner.textContent = fault === null ? '' : fault.message || String(fault);
}

function clock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}

let running = null;
let ticker = null;
const kept = keepJottings(box, say);

function tick() {
  liveText.textContent = 'Recording · ' + clock(Date.now() - Date.parse(running.startedAt));
}

async function open() {
  try {
    running = (await call('get_call')).call;
    say(null);
  } catch (fault) {
    say(fault);
    return;
  }
  noCall.hidden = running !== null;
  live.hidden = running === null;
  label.hidden = box.hidden = running === null;
  if (running === null) return;
  kept.show(running.id, running.jottings);
  tick();
  ticker = setInterval(tick, 1000);
  // The caret goes to the end, so the next line types where the last stopped.
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

stopButton.addEventListener('click', async () => {
  if (running === null) return;
  stopButton.disabled = true;
  try {
    await kept.save();
    await call('stop_call', { id: running.id });
    clearInterval(ticker);
    live.hidden = true;
    stopped.hidden = false;
  } catch (fault) {
    say(fault);
    stopButton.disabled = false;
  }
});

open();
