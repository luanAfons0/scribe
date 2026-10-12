/* The Event that starts next, on the Calls list.

   From five minutes before an Event until it ends, a banner shows it, with
   Open the Meet and Start a Call. Further away, one line says the next Event.
   The Notice a minute before an Event opens #upcoming, which scrolls to the
   banner. A calendar that cannot be read shows nothing here: the Settings
   view says why, and never a Notice.

   app.js calls drawUpcoming() when it draws the list, and wires the banner's
   Start a Call to its own start(). */
'use strict';

/** How long before an Event its banner shows. */
const SOON_MS = 5 * 60_000;

/** Whether the banner was scrolled to since the address last became #upcoming. */
let upcomingScrolled = false;

window.addEventListener('hashchange', () => {
  upcomingScrolled = false;
});

/** A time of day as a clock reads it: 14:05. */
function timeOfDay(iso) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** Whether a moment falls on another day than today. */
function notToday(iso) {
  return new Date(iso).toDateString() !== new Date().toDateString();
}

/**
 * Draw the banner or the one line, out of what list_events answers. Answers
 * whether an Event is coming, so the list is drawn again as it comes closer.
 */
async function drawUpcoming() {
  const banner = document.getElementById('upcoming');
  const line = document.getElementById('next-event');
  const startPlain = document.getElementById('start');
  const { events } = await call('list_events');
  const now = Date.now();
  // Of two Events at once, the one that starts last is the one a Call started
  // now is for, so the banner shows that one.
  const soon = events
    .filter((event) => Date.parse(event.start) - SOON_MS <= now && Date.parse(event.end) > now)
    .reduce(
      (latest, event) =>
        latest === undefined || Date.parse(event.start) > Date.parse(latest.start) ? event : latest,
      undefined,
    );
  const later = events.find((event) => Date.parse(event.start) - SOON_MS > now);

  banner.hidden = soon === undefined;
  // The banner's Start a Call is the one Start: the list's own steps back.
  startPlain.hidden = soon !== undefined;
  if (soon !== undefined) {
    const left = Date.parse(soon.start) - now;
    document.getElementById('upcoming-at').textContent = timeOfDay(soon.start);
    document.getElementById('upcoming-in').textContent =
      left > 0 ? 'in ' + Math.max(1, Math.ceil(left / 60_000)) + ' min' : 'now';
    document.getElementById('upcoming-name').textContent = soon.name || 'An Event';
    document.getElementById('upcoming-span').textContent =
      'Google Meet, ' + timeOfDay(soon.start) + ' to ' + timeOfDay(soon.end) + '. ';
    document.getElementById('upcoming-meet').href = soon.meet;
    document.getElementById('upcoming-start').disabled = startPlain.disabled;
  }

  line.hidden = soon !== undefined || later === undefined;
  if (soon === undefined && later !== undefined) {
    const name = document.createElement('strong');
    name.textContent = later.name || 'An Event';
    line.replaceChildren(
      'Next Event: ',
      name,
      (notToday(later.start) ? ' tomorrow' : '') + ' at ' + timeOfDay(later.start),
      ', on Google Meet.',
    );
  }

  if (location.hash === '#upcoming' && !banner.hidden && !upcomingScrolled) {
    upcomingScrolled = true;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    banner.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  }
  return events.length > 0;
}
