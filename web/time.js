/* A moment and a length of time, as the Plugin Page and the Popup say them.
   Both pages load this file before their own script, so the two say a time
   the same way. */
'use strict';

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
