/* The scribe Plugin Page: the list of Calls. Everything it shows, it asks the
   Plugin Server for; it keeps nothing of its own. */
'use strict';

const byId = (id) => document.getElementById(id);
const banner = byId('banner');
const calls = byId('calls');
const noCalls = byId('no-calls');

/** Say what went wrong at the top of the page, or clear it with null. */
function say(fault) {
  banner.hidden = fault === null;
  banner.textContent = fault === null ? '' : fault.message || String(fault);
}

/** A moment as this person reads it: their own date and time. */
function when(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A Call's name: its title, or the moment it started until it has one. */
function nameOf(call) {
  return call.title || when(call.startedAt);
}

async function showList() {
  const listed = await call('list_calls');
  calls.replaceChildren(
    ...listed.calls.map((found) => {
      const item = document.createElement('li');
      item.className = 'call ' + found.state;
      item.textContent = nameOf(found);
      return item;
    }),
  );
  noCalls.hidden = listed.calls.length > 0;
}

showList().then(() => say(null), say);
