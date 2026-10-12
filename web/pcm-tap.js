/* An AudioWorklet that turns one track into chunks of 16-bit PCM of about
   five seconds, and posts each to the page. It runs on the audio thread, which
   Chromium does not slow down for a page that is not shown, so the chunks
   keep coming while the call's own app is in front. "flush" posts what is left,
   then "flushed". */
'use strict';

const CHUNK = 5 * 16000;

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return;
      this.post();
      this.port.postMessage('flushed');
    };
  }

  post() {
    if (this.filled === 0) return;
    const chunk = this.buffer.slice(0, this.filled);
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    // A track with nothing on it for a moment gives no channel at all. That
    // moment is written as silence, so both tracks keep the same clock: the
    // Plugin Server times each line by the samples before it.
    const channel = inputs[0] && inputs[0][0];
    const frames = channel ? channel.length : 128;
    for (let i = 0; i < frames; i += 1) {
      const sample = channel ? Math.max(-1, Math.min(1, channel[i])) : 0;
      this.buffer[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.filled += 1;
      if (this.filled === CHUNK) this.post();
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
