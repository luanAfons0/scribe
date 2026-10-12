/* The Jottings box. Every change is sent to the Plugin Server a moment after
   the typing pauses, one save after another in order, and at once when the
   box or the window loses focus, so a page that closes loses nothing. It
   defines one global: keepJottings(box, onFault) → { mark, show, save }.

   The Call's page and the Popup each have a box for the same Jottings, and
   only one has focus at a time. So a box takes the Plugin Server's text
   whenever it holds no change of its own, even while it has focus: that is
   how an edit made in the Popup shows on the Call's page. A read asked for before a
   save ended may hold the text from before that save, so it is dropped. */
'use strict';

(function () {
  const PAUSE_MS = 300;

  function keepJottings(box, onFault) {
    let id = null;
    let sent = box.value;
    let timer = null;
    let chain = Promise.resolve();
    // Saves begun and saves ended. A read is fresh when it was asked for
    // with none on its way, and none began since.
    let begun = 0;
    let ended = 0;

    /** Send what the box holds, if it changed, for the Call it belongs to. */
    function save() {
      clearTimeout(timer);
      timer = null;
      const text = box.value;
      const owner = id;
      if (owner === null || text === sent) return chain;
      sent = text;
      begun += 1;
      chain = chain
        .then(() => call('save_jottings', { id: owner, jottings: text }))
        .then(() => onFault(null), onFault)
        .then(() => {
          ended += 1;
        });
      return chain;
    }

    box.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(save, PAUSE_MS);
    });
    box.addEventListener('blur', save);
    window.addEventListener('blur', save);
    window.addEventListener('pagehide', save);

    return {
      /** Take this just before get_call, and give it to show() with the answer. */
      mark() {
        return begun === ended ? begun : -1;
      },
      /**
       * Show this Call's Jottings, as the Plugin Server has them. For the Call
       * already shown, a box that holds a change of its own keeps it, and a
       * read older than a save is dropped.
       */
      show(callId, text, mark) {
        if (callId !== id) {
          save();
          id = callId;
        } else if (timer !== null || box.value !== sent || mark !== begun || begun !== ended) {
          return;
        }
        // The same text again leaves the caret where it is.
        if (box.value !== text) box.value = text;
        sent = text;
      },
      save: save,
    };
  }

  globalThis.keepJottings = keepJottings;
})();
