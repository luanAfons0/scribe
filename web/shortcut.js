/* The Popup Shortcut in the Settings view: the firstmate bind command line,
   and its Copy button. FirstMate holds the Shortcut, so scribe cannot bind
   it; it gives the operator the command line to run once. Where the browser
   gives no clipboard, Copy selects the line instead, for Ctrl+C. */
'use strict';

(function () {
  const command = document.getElementById('bind-command');
  const copy = document.getElementById('copy-bind');
  const AGAIN_MS = 1400;

  function shown(word) {
    copy.textContent = word;
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, AGAIN_MS);
  }

  function select() {
    const range = document.createRange();
    range.selectNodeContents(command);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    shown('Selected');
  }

  copy.addEventListener('click', () => {
    if (!navigator.clipboard) return select();
    navigator.clipboard.writeText(command.textContent).then(() => shown('Copied'), select);
  });
})();
