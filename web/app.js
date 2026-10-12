/* The scribe Plugin Page: the list of Calls, one Call, and the Call this tab
   records. Everything it shows, it asks the Plugin Server for; the one thing
   it keeps is the capture of the Call it records, which lives only in this
   tab (ADR-0001). The address says what is shown: # for the list, #call/7
   for one Call, #settings for the Settings view, so a reload shows the same
   thing. */
'use strict';

const byId = (id) => document.getElementById(id);
const banner = byId('banner');
const live = byId('live');
const liveText = byId('live-text');
const liveStop = byId('live-stop');
const listView = byId('list-view');
const callView = byId('call-view');
const settingsView = byId('settings-view');
const setupNote = byId('setup-note');
const setupText = byId('setup-text');
const startButton = byId('start');
const callList = byId('calls');
const noCalls = byId('no-calls');
const callTitle = byId('call-title');
const callMeta = byId('call-meta');
const stopButton = byId('stop');
const cutNote = byId('cut-note');
const jottingsBox = byId('call-jottings');
const makeButton = byId('make-minutes');
const minutesState = byId('minutes-state');
const topicsPart = byId('topics-part');
const topicsText = byId('topics');
const worklogState = byId('worklog-state');
const sendButton = byId('send-worklog');
const minutesView = byId('minutes');
const renameButton = byId('rename');
const renameForm = byId('rename-form');
const titleInput = byId('title-input');
const renameCancel = byId('rename-cancel');
const deleteButton = byId('delete');
const editButton = byId('edit-minutes');
const minutesForm = byId('minutes-form');
const minutesEditor = byId('minutes-editor');
const minutesCancel = byId('minutes-cancel');
const transcript = byId('transcript');
const transcribing = byId('transcribing');
const noTranscript = byId('no-transcript');
const moreLines = byId('more-lines');

/** How many of the last Transcript lines show before "See more". */
const LAST_LINES = 10;

/** The Calls whose whole Transcript is shown, since "See more" was pressed. */
const wholeTranscript = new Set();

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
  callList.replaceChildren(
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
      // An untitled Call is named by its date already, so it is not said twice.
      meta.textContent =
        (found.title ? when(found.startedAt) + ' · ' : '') +
        lengthOf(found) + ' · ' + STATE_WORDS[found.state];
      if (found.sentToWorklogAt !== null) {
        const sent = document.createElement('span');
        sent.className = 'sent-mark';
        sent.textContent = 'Sent to Worklog';
        meta.append(' · ', sent);
      }
      link.append(name, meta);
      item.append(link);
      return item;
    }),
  );
  noCalls.hidden = listed.calls.length > 0;
  // Without whisper.cpp no Call can record, so the list says why and where
  // to fix it, rather than wait for Start to be refused.
  const problem = await recordingProblem();
  setupNote.hidden = problem === null;
  setupText.textContent = problem || '';
  if (problem !== null) startButton.disabled = true;
}

/** One Call, drawn whole. Answers whether it is still changing. */
async function showCall(id) {
  const found = (await call('get_call', { id: id })).call;
  callTitle.textContent = nameOf(found);
  callMeta.textContent =
    when(found.startedAt) + ' · ' + lengthOf(found) + ' · ' + STATE_WORDS[found.state];
  callView.dataset.state = found.state;
  stopButton.hidden = found.state !== 'recording';
  deleteButton.hidden = found.state === 'recording';
  callView.dataset.title = found.title || '';
  cutNote.hidden = found.state !== 'cut';
  jottings.show(found.id, found.jottings);

  const whole = wholeTranscript.has(found.id) || found.transcript.length <= LAST_LINES;
  const hidden = whole ? 0 : found.transcript.length - LAST_LINES;
  moreLines.hidden = hidden === 0;
  moreLines.textContent = 'See more (' + hidden + ' earlier line' + (hidden === 1 ? '' : 's') + ')';
  moreLines.dataset.id = String(found.id);
  transcript.replaceChildren(
    ...found.transcript.slice(hidden).map((line) => {
      const item = document.createElement('li');
      item.className = 'line ' + (line.speaker === 'Você' ? 'mine' : 'theirs');
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
  await showTopics(found);
  return (
    found.state === 'recording' ||
    found.transcribing ||
    found.minutesState === 'making' ||
    found.sendingToWorklog
  );
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
  makeButton.hidden = !over || !minutesForm.hidden;
  editButton.hidden = !over || !minutesForm.hidden || found.minutesState === 'making';
  minutesView.hidden = minutesView.hidden || !minutesForm.hidden;
  makeButton.disabled =
    found.transcribing || found.minutesState === 'making' || found.sendingToWorklog;
  makeButton.textContent = found.minutes === null ? 'Make Minutes' : 'Make Minutes again';
}

/** What the foot of the Topics says while nothing has gone to Worklog yet. */
const NOT_SENT = 'Not sent. Only the title, the times and these Topics go to Worklog.';

/**
 * The Topics, read-only, and where they stand with Worklog. They show once
 * the Minutes command wrote them, and nothing goes until the button is
 * pressed.
 */
async function showTopics(found) {
  topicsPart.hidden = found.topics === null || found.state === 'recording';
  if (topicsPart.hidden) return;
  topicsText.textContent = found.topics;
  worklogState.classList.remove('fault', 'changed');
  sendButton.disabled = false;
  sendButton.classList.add('go');
  sendButton.textContent = found.sentToWorklogAt === null ? 'Send to Worklog' : 'Send again';

  if (found.sendingToWorklog) {
    worklogState.textContent = 'Sending the Topics to Worklog…';
    sendButton.disabled = true;
    sendButton.textContent = 'Sending…';
  } else if (!(await worklogPluginSet())) {
    const where = document.createElement('a');
    where.href = '#settings';
    where.textContent = 'Set it in Settings';
    worklogState.replaceChildren('No Worklog Plugin is set. ', where);
    sendButton.disabled = true;
    sendButton.classList.remove('go');
  } else if (found.entryError !== null) {
    worklogState.textContent = found.entryError;
    worklogState.classList.add('fault');
  } else if (found.topicsChangedSinceSent) {
    // Worklog holds the Topics as they were: Send again stays the main act.
    worklogState.textContent =
      'The Topics changed since you sent them at ' + when(found.sentToWorklogAt) + '.';
    worklogState.classList.add('changed');
  } else if (found.sentToWorklogAt !== null) {
    worklogState.textContent =
      'Sent to Worklog ' + when(found.sentToWorklogAt) + ', as one Done Entry.';
    sendButton.classList.remove('go');
  } else {
    worklogState.textContent = NOT_SENT;
  }
}

async function sendToWorklog() {
  sendButton.disabled = true;
  sendButton.textContent = 'Sending…';
  try {
    await call('send_to_worklog', { id: shownId() });
  } catch (fault) {
    say(fault);
  }
  show();
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

/** Whether the Settings view has been drawn since it was opened. */
let settingsShown = false;

/** Draw what the address names, and keep drawing while it changes. */
async function show() {
  clearTimeout(timer);
  const id = shownId();
  const settings = location.hash === '#settings';
  listView.hidden = id !== null || settings;
  callView.hidden = id === null;
  settingsView.hidden = !settings;
  try {
    const running = await showLive();
    let changing = false;
    if (settings) {
      // The Settings view is drawn once when it opens, so a poll never
      // writes over a field being typed in.
      if (!settingsShown) await showSettings();
      settingsShown = true;
    } else if (id === null) {
      await showList();
      changing = running !== null;
    } else {
      changing = await showCall(id);
    }
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

/** Show the title as a field to type in, or as the heading again. */
function renaming(on) {
  renameForm.hidden = !on;
  callTitle.hidden = on;
  renameButton.hidden = on;
  if (on) {
    titleInput.value = callView.dataset.title || callTitle.textContent;
    titleInput.focus();
    titleInput.select();
  }
}

renameButton.addEventListener('click', () => renaming(true));
renameCancel.addEventListener('click', () => renaming(false));
renameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await call('rename_call', { id: shownId(), title: titleInput.value });
    renaming(false);
  } catch (fault) {
    say(fault);
  }
  show();
});

/** Show the Minutes' Markdown in a box to correct by hand, or put it away. */
function editing(on) {
  minutesForm.hidden = !on;
  if (on) {
    minutesEditor.value = minutesView.dataset.source || '';
    minutesEditor.focus();
  }
  show();
}

editButton.addEventListener('click', () => editing(true));
minutesCancel.addEventListener('click', () => editing(false));
minutesForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await call('save_minutes', { id: shownId(), minutes: minutesEditor.value });
    editing(false);
  } catch (fault) {
    say(fault);
  }
});

deleteButton.addEventListener('click', async () => {
  const name = callTitle.textContent;
  const sure = confirm(
    'Delete “' + name + '” for good, with its Jottings, Transcript and Minutes?',
  );
  if (!sure) return;
  try {
    await call('delete_call', { id: shownId() });
    location.hash = '#';
  } catch (fault) {
    say(fault);
  }
});

window.addEventListener('hashchange', () => {
  renaming(false);
  minutesForm.hidden = true;
  settingsShown = false;
});

moreLines.addEventListener('click', () => {
  wholeTranscript.add(Number(moreLines.dataset.id));
  show();
});

startButton.addEventListener('click', start);
makeButton.addEventListener('click', makeMinutes);
sendButton.addEventListener('click', sendToWorklog);
stopButton.addEventListener('click', () => stop(shownId()));
liveStop.addEventListener('click', () => stop(Number(live.dataset.id)));
window.addEventListener('hashchange', show);
show();
