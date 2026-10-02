/* The Jottings box. Every change is sent to the Plugin Server a moment after
   the typing pauses, one save after another in order, and at once when the
   box or the window loses focus, so a tab that closes loses nothing. It
   defines one global: keepJottings(box, onFault) → { show, save }. */
'use strict';

(function () {
  const PAUSE_MS = 300;

  function keepJottings(box, onFault) {
    let id = null;
    let sent = box.value;
    let timer = null;
    let chain = Promise.resolve();

    /** Send what the box holds, if it changed, for the Call it belongs to. */
    function save() {
      clearTimeout(timer);
      timer = null;
      const text = box.value;
      const owner = id;
      if (owner === null || text === sent) return chain;
      sent = text;
      chain = chain
        .then(() => call('save_jottings', { id: owner, jottings: text }))
        .then(() => onFault(null), onFault);
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
      /**
       * Show this Call's Jottings, as the Plugin Server has them. For the Call
       * already shown, a box being typed in keeps its own, newer text.
       */
      show(callId, text) {
        if (callId !== id) {
          save();
          id = callId;
        } else if (document.activeElement === box || timer !== null || box.value !== sent) {
          return;
        }
        box.value = text;
        sent = text;
      },
      save: save,
    };
  }

  globalThis.keepJottings = keepJottings;
})();
