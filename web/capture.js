/* Recording a Call in this tab (ADR-0001): the call's tab and its audio from
   Chrome's picker, the mic from the browser, both as 16 kHz mono, each sent
   to the Plugin Server in chunks of about five seconds, in order, as they are
   made. It defines one global: startCapture(hooks) → a Capture.

   The picker comes first, then the mic, and only then is the Call started,
   so a cancelled picker leaves no Call behind. A chunk that cannot be sent is
   tried again until it goes, so a Host that blinks loses no audio. When the
   Plugin Server says the Call no longer records — it was stopped from the
   Popup, or it was Cut — this tab lets go of the tab and the mic. */
'use strict';

(function () {
  const RATE = 16000;
  const RETRY_MS = 2000;
  const NOT_RECORDING = 'is not recording';

  /** An ArrayBuffer of PCM as base64, in pieces small enough for apply(). */
  function base64(buffer) {
    const bytes = new Uint8Array(buffer);
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
    }
    return btoa(text);
  }

  const pause = (ms) => new Promise((done) => setTimeout(done, ms));

  /**
   * Ask for the tab and the mic, start a Call, and send its audio. hooks.onEnd
   * is told once, when this tab stops recording for any reason, with a
   * sentence when the reason is a fault. Resolves to { id, stop() }.
   */
  async function startCapture(hooks) {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    });
    const release = [display];
    const letGo = () => release.forEach((stream) => stream.getTracks().forEach((t) => t.stop()));

    if (display.getAudioTracks().length === 0) {
      letGo();
      throw new Error(
        'Chrome shared no audio. Start again, choose the call’s tab, and tick ' +
          '“Also share tab audio”.',
      );
    }

    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (fault) {
      letGo();
      throw new Error('The browser would not give this page the mic: ' + fault.message);
    }
    release.push(mic);

    let id;
    try {
      id = (await call('start_call')).call.id;
    } catch (fault) {
      letGo();
      throw fault;
    }

    const context = new AudioContext({ sampleRate: RATE });
    await context.audioWorklet.addModule('pcm-tap.js');
    // The taps must be pulled to run, but nothing should be heard twice.
    const mute = context.createGain();
    mute.gain.value = 0;
    mute.connect(context.destination);

    let over = false;
    let ending = null;

    function end(fault) {
      if (over) return;
      over = true;
      letGo();
      context.close();
      window.removeEventListener('beforeunload', hold);
      hooks.onEnd(fault || null);
    }

    function hold(event) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', hold);

    /** One track: its tap, and the chunks it waits to send, in order. */
    function tap(track, stream) {
      const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const node = new AudioWorkletNode(context, 'pcm-tap', {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      source.connect(node);
      node.connect(mute);

      const queue = [];
      let seq = 0;
      let sending = false;
      let flushed = null;
      let drained = null;

      async function drain() {
        if (sending) return;
        sending = true;
        while (queue.length > 0 && !over) {
          try {
            await call('append_audio', { id: id, track: track, seq: seq, pcm: queue[0] });
            queue.shift();
            seq += 1;
          } catch (fault) {
            if (String(fault.message).includes(NOT_RECORDING)) {
              end(null);
              break;
            }
            hooks.onTrouble(fault);
            await pause(RETRY_MS);
          }
        }
        sending = false;
        if (queue.length === 0 && drained) drained();
      }

      node.port.onmessage = (event) => {
        if (event.data === 'flushed') {
          if (flushed) flushed();
          return;
        }
        queue.push(base64(event.data));
        drain();
      };

      return {
        /** Send what the tap still holds, and wait until all of it is sent. */
        async finish() {
          await new Promise((done) => {
            flushed = done;
            node.port.postMessage('flush');
          });
          if (queue.length > 0 || sending) await new Promise((done) => (drained = done));
        },
      };
    }

    const taps = [tap('tab', display), tap('mic', mic)];

    async function stop() {
      if (ending) return ending;
      ending = (async () => {
        await Promise.all(taps.map((one) => one.finish()));
        try {
          await call('stop_call', { id: id });
        } catch (fault) {
          if (!String(fault.message).includes('is not recording') &&
              !String(fault.message).includes('No Call is recording')) {
            end(fault);
            return;
          }
        }
        end(null);
      })();
      return ending;
    }

    // "Stop sharing" in Chrome's bar, or the call's tab closing, ends it too.
    display.getTracks().forEach((track) => track.addEventListener('ended', () => stop()));

    return { id: id, stop: stop };
  }

  globalThis.startCapture = startCapture;
})();
