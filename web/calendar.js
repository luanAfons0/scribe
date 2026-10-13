/* The calendar's secret iCal address, in the Settings view (ADR-0006).

   The address is a secret: whoever holds it reads the whole calendar. The
   Plugin Server never gives it back, so once it is saved this view shows it
   masked, with Replace and Remove, and never the address itself. A new one
   is typed into the field, sent once with Save, and the field is emptied.

   Under it, what the last read gave: how many Events the calendar holds and
   the next one, or the sentence of the fault; and, when the calendar's name
   gives no owner, that declined Events show too.

   settings.js calls drawCalendar() when it draws the settings, and
   calendarGiven() when it saves them. */
'use strict';

/** The calendar's address as get_settings told it last. */
let calendarShown = null;

/** Whether the operator asked to type a new address over the saved one. */
let calendarReplacing = false;

/** Draw the calendar's setting, as get_settings tells it. */
function drawCalendar(calendar) {
  calendarShown = calendar;
  if (!calendar.saved) calendarReplacing = false;
  const saved = calendar.saved && !calendarReplacing;
  document.getElementById('calendar-saved').hidden = !saved;
  document.getElementById('calendar-empty').hidden = saved;
  const from = document.getElementById('calendarUrl-from');
  from.hidden = calendar.from !== 'environment';
  from.textContent =
    calendar.variable + ' decides this where the Host is started. ' +
    'What is saved here is used once it is not set.';
  const ignored = document.getElementById('calendarUrl-ignored');
  ignored.hidden = calendar.ignored === null;
  ignored.textContent = calendar.ignored || '';
  drawCalendarRead(calendar).catch(() => {
    // list_events failed: the read line keeps what it said, and the next draw tries again.
  });
}

/** What the last read gave: the count and the next Event, or the fault. */
async function drawCalendarRead(calendar) {
  const said = document.getElementById('calendar-read');
  const problem = document.getElementById('calendar-problem');
  const read = calendar.read;
  problem.hidden = read === null || read.problem === null;
  problem.textContent = read === null || read.problem === null ? '' : read.problem;
  if (!calendar.set) {
    said.hidden = true;
    return;
  }
  said.hidden = false;
  if (read === null) {
    said.textContent = 'Not read yet.';
    return;
  }
  const when = 'Read ' + agoOf(read.at) + '.';
  if (read.count === null) {
    said.textContent = when;
    return;
  }
  // A calendar with no owner to read gives declined Events too: one sentence says so.
  const declined = read.declined === null ? '' : ' ' + read.declined;
  const events = (await call('list_events')).events;
  const next = events.find((event) => Date.parse(event.start) > Date.now()) || events[0];
  said.textContent =
    when + ' ' + read.count + (read.count === 1 ? ' Event. ' : ' Events. ') +
    (next === undefined
      ? 'No Event in the next day.'
      : 'Next Event: ' + next.name + ', ' + dayAndTime(next.start) + '.') +
    declined;
}

/** How long ago an instant was, as the read line says it. */
function agoOf(at) {
  const minutes = Math.floor((Date.now() - Date.parse(at)) / 60000);
  return minutes < 1 ? 'just now' : minutes + ' min ago';
}

/** "today at 14:00" or "tomorrow at 09:30", in this machine's time. */
function dayAndTime(at) {
  const date = new Date(at);
  const day = date.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow';
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return day + ' at ' + time;
}

/**
 * What Save sends for the calendar: a new address when one was typed, and
 * nothing otherwise, so a saved address is kept. Remove is what clears it.
 */
function calendarGiven() {
  const field = document.getElementById('set-calendarUrl');
  const typed = field.value.trim();
  if (typed === '') return {};
  // The field is emptied at once: the address is not left on the page.
  field.value = '';
  calendarReplacing = false;
  return { calendarUrl: typed };
}

/** Draw the calendar again until its first read since `after` is in, for a minute at most. */
async function followCalendarRead(after) {
  for (let tries = 0; tries < 60; tries += 1) {
    await new Promise((done) => setTimeout(done, 1000));
    const calendar = (await call('get_settings')).settings.calendarUrl;
    drawCalendar(calendar);
    if (!calendar.set || (calendar.read !== null && calendar.read.at > after)) return;
  }
}

document.getElementById('calendar-replace').addEventListener('click', () => {
  calendarReplacing = true;
  if (calendarShown !== null) drawCalendar(calendarShown);
  document.getElementById('set-calendarUrl').focus();
});

document.getElementById('calendar-remove').addEventListener('click', async () => {
  const problem = document.getElementById('calendar-problem');
  try {
    drawCalendar((await call('update_settings', { calendarUrl: null })).settings.calendarUrl);
  } catch (fault) {
    problem.textContent = fault.message || String(fault);
    problem.hidden = false;
  }
});
