/* The scribe Plugin Page: the list of Calls, one Call, and the Call this tab
   records. Everything it shows, it asks the Plugin Server for; the one thing
   it keeps is the capture of the Call it records, which lives only in this
   tab (ADR-0001). The address says what is shown: # for the list, #call/7
   for one Call, so a reload shows the same thing. */
'use strict';

const byId = (id) => document.getElementById(id);
const banner = byId('banner');
const live = byId('live');
const liveText = byId('live-text');
const liveStop = byId('live-stop');
const listView = byId('list-view');
const callView = byId('call-view');
const startButton = byId('start');
const calls = byId('calls');
const noCalls = byId('no-calls');
const callTitle = byId('call-title');
const callMeta = byId('call-meta');
const stopButton = byId('stop');
const cutNote = byId('cut-note');
const jottingsBox = byId('call-jottings');
const makeButton = byId('make-minutes');
const minutesState = byId('minutes-state');
const minutesView = byId('minutes');
const transcript = byId('transcript');
const transcribing = byId('transcribing');
const noTranscript = byId('no-transcript');

/** How often the page asks again while something is still changing. */
const POLL_MS = 2000;

/** The Call this tab records, while it records one. */
let capture = null;

/** The Jottings box, which follows the Call shown. */
const jottings = keepJottings(jottingsBox, say);

/** Say what went wrong at the top of the page, or clear it with null. */
function say(fault) {
  banner.hidden = fault === null;
  banner.textContent = fault === null ? '' : fault.message || String(fault);
}

/** A moment as this person reads it: their own date and time. */
function when(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A length of time as a clock reads it: 4:05, or 1:02:07. */
function clock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}

/** How long a Call has run, or ran. */
function lengthOf(found) {
  const end = found.endedAt ? Date.parse(found.endedAt) : Date.now();
  return clock(end - Date.parse(found.startedAt));
}

/** A Call's name: its title, or the moment it started until it has one. */
function nameOf(found) {
  return found.title || when(found.startedAt);
}

const STATE_WORDS = { recording: 'Recording', ended: 'Ended', cut: 'Cut' };

/** The Call id the address names, or null for the list. */
function shownId() {
  const found = /^#call\/(\d+)$/.exec(location.hash);
  return found ? Number(found[1]) : null;
}

async function showList() {
  const listed = await call('list_calls');
  calls.replaceChildren(
    ...listed.calls.map((found) => {
      const item = document.createElement('li');
      item.className = 'call ' + found.state;
      const link = document.createElement('a');
      link.href = '#call/' + found.id;
      const name = document.createElement('span');
      name.className = 'call-name';
      name.textContent = nameOf(found);
      const meta = document.createElement('span');
      meta.className = 'call-meta';
      meta.textContent =
        when(found.startedAt) + ' · ' + lengthOf(found) + ' · ' + STATE_WORDS[found.state];
      link.append(name, meta);
      item.append(link);
      return item;
    }),
  );
  noCalls.hidden = listed.calls.length > 0;
}

/** One Call, drawn whole. Answers whether it is still changing. */
async function showCall(id) {
  const found = (await call('get_call', { id: id })).call;
  callTitle.textContent = nameOf(found);
  callMeta.textContent =
    when(found.startedAt) + ' · ' + lengthOf(found) + ' · ' + STATE_WORDS[found.state];
  callView.dataset.state = found.state;
  stopButton.hidden = found.state !== 'recording';
  cutNote.hidden = found.state !== 'cut';
  jottings.show(found.id, found.jottings);

  transcript.replaceChildren(
    ...found.transcript.map((line) => {
      const item = document.createElement('li');
      item.className = 'line ' + (line.speaker === 'Eu' ? 'mine' : 'theirs');
      const at = document.createElement('span');
      at.className = 'at';
      at.textContent = clock(line.startMs);
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = line.speaker;
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = line.text;
      item.append(at, who, text);
      return item;
    }),
  );
  transcribing.hidden = !found.transcribing;
  noTranscript.hidden = found.transcript.length > 0 || found.transcribing;
  showMinutes(found);
  return found.state === 'recording' || found.transcribing || found.minutesState === 'making';
}

/** What a Call's Minutes say, or where they stand. */
const MINUTES_WORDS = {
  none: 'No Minutes yet.',
  making: 'Making the Minutes…',
};

function showMinutes(found) {
  const over = found.state !== 'recording';
  minutesView.hidden = found.minutes === null;
  if (found.minutes !== null && minutesView.dataset.source !== found.minutes) {
    minutesView.innerHTML = renderMarkdown(found.minutes);
    minutesView.dataset.source = found.minutes;
  }
  const state =
    found.minutesState === 'failed'
      ? 'The Minutes could not be made: ' + found.minutesError
      : found.state === 'recording'
        ? 'The Minutes are made when the Call stops.'
        : found.transcribing && found.minutesState === 'none'
          ? 'The Minutes are made once Whisper has read all the audio.'
          : MINUTES_WORDS[found.minutesState] || '';
  minutesState.textContent = state;
  minutesState.hidden = state === '' || (found.minutesState === 'none' && found.minutes !== null);
  minutesState.classList.toggle('fault', found.minutesState === 'failed');
  makeButton.hidden = !over;
  makeButton.disabled = found.transcribing || found.minutesState === 'making';
  makeButton.textContent = found.minutes === null ? 'Make Minutes' : 'Make Minutes again';
}

async function makeMinutes() {
  makeButton.disabled = true;
  try {
    await call('make_minutes', { id: shownId() });
  } catch (fault) {
    say(fault);
  }
  show();
}

/** The red line, from the Call that records now, if one does. */
async function showLive() {
  const running = (await call('get_call')).call;
  live.hidden = running === null;
  startButton.disabled = running !== null || capture !== null;
  if (running !== null) {
    liveText.textContent =
      'Recording ' + nameOf(running) + ' · ' + lengthOf(running) +
      (capture !== null && capture.id === running.id ? '' : ' (in another tab)');
    live.dataset.id = String(running.id);
  }
  return running;
}

let timer = null;

/** Draw what the address names, and keep drawing while it changes. */
async function show() {
  clearTimeout(timer);
  const id = shownId();
  listView.hidden = id !== null;
  callView.hidden = id === null;
  try {
    const running = await showLive();
    const changing = id === null ? (await showList(), running !== null) : await showCall(id);
    say(null);
    if (changing || running !== null) timer = setTimeout(show, POLL_MS);
  } catch (fault) {
    say(fault);
    timer = setTimeout(show, POLL_MS * 2);
  }
}

async function start() {
  startButton.disabled = true;
  try {
    capture = await startCapture({
      onTrouble: say,
      onEnd: (fault) => {
        capture = null;
        say(fault);
        show();
      },
    });
    location.hash = '#call/' + capture.id;
  } catch (fault) {
    // Closing the picker is a choice, not a fault.
    if (fault.name !== 'NotAllowedError') say(fault);
  }
  show();
}

/** Stop the Call that records: through this tab's capture, when it has it. */
async function stop(id) {
  try {
    if (capture !== null && capture.id === id) await capture.stop();
    else await call('stop_call', { id: id });
  } catch (fault) {
    say(fault);
  }
  show();
}

startButton.addEventListener('click', start);
makeButton.addEventListener('click', makeMinutes);
stopButton.addEventListener('click', () => stop(shownId()));
liveStop.addEventListener('click', () => stop(Number(live.dataset.id)));
window.addEventListener('hashchange', show);
show();
