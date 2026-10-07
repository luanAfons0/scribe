/* The offers to fetch whisper.cpp and a model, under their settings in the
   Settings view, as get_downloads tells them (ADR-0005).

   Nothing is fetched until the operator clicks: each fetch tool is called
   from its own button and nowhere else. A download runs in the Plugin Server;
   this view asks how far it got while one runs, and when it ends draws the
   settings again, which now name what was fetched. A download that failed
   leaves its one sentence under its button.

   settings.js calls showDownloads() when the Settings view opens. */
'use strict';

/** How often the view asks how far a download got. */
const DOWNLOAD_POLL_MS = 500;

/** The timer of the next ask, or null when no download runs. */
let downloadTimer = null;

/** A size in bytes, as a person reads it. */
function sizeText(bytes) {
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
}

/** Whether a download is in flight. */
function fetching(fetch) {
  return fetch !== null && fetch.failed === null;
}

/** Draw one download: its progress while it runs, its sentence when it failed. */
function drawFetch(fetch, button, progress, failed) {
  const running = fetching(fetch);
  button.disabled = running;
  progress.hidden = !running;
  if (running) progress.value = fetch.size > 0 ? fetch.received / fetch.size : 0;
  failed.hidden = fetch === null || fetch.failed === null;
  failed.textContent = fetch === null || fetch.failed === null ? '' : fetch.failed;
}

/** Draw both offers, and ask again while a download runs. */
function drawDownloads(downloads) {
  const whisper = downloads.whisper;
  const offer = document.getElementById('whisper-offer');
  const fetchWhisper = document.getElementById('fetch-whisper');
  if (whisper.build === null) {
    offer.textContent = whisper.missing;
    fetchWhisper.hidden = true;
  } else {
    offer.textContent =
      'Or fetch whisper.cpp ' + whisper.release + ' for this system, ' +
      sizeText(whisper.build.size) + ', checked before it is kept.';
    fetchWhisper.hidden = false;
  }
  drawFetch(
    whisper.fetch,
    fetchWhisper,
    document.getElementById('whisper-progress'),
    document.getElementById('whisper-fetch-failed'),
  );

  const choice = document.getElementById('model-choice');
  if (choice.options.length !== downloads.models.offered.length) {
    choice.replaceChildren(...downloads.models.offered.map((model) => {
      const option = document.createElement('option');
      option.value = model.name;
      option.textContent = model.name + ' · ' + sizeText(model.size);
      option.selected = model.name === 'ggml-small.bin';
      return option;
    }));
  }
  drawFetch(
    downloads.models.fetch,
    document.getElementById('fetch-model'),
    document.getElementById('model-progress'),
    document.getElementById('model-fetch-failed'),
  );

  const running = fetching(whisper.fetch) || fetching(downloads.models.fetch);
  clearTimeout(downloadTimer);
  downloadTimer = running ? setTimeout(followDownloads, DOWNLOAD_POLL_MS) : null;
}

/** Ask how far the downloads got; when one has ended, draw the settings it changed. */
async function followDownloads() {
  try {
    const downloads = (await call('get_downloads')).downloads;
    drawDownloads(downloads);
    if (downloadTimer === null) await showSettings();
  } catch {
    downloadTimer = setTimeout(followDownloads, DOWNLOAD_POLL_MS * 4);
  }
}

/** Draw the offers with what the Plugin Server holds now. */
async function showDownloads() {
  drawDownloads((await call('get_downloads')).downloads);
}

/** Start a download from its button, and show its refusal under it when there is one. */
async function startFetch(start, failed) {
  try {
    drawDownloads(await start());
  } catch (fault) {
    failed.textContent = fault.message || String(fault);
    failed.hidden = false;
  }
}

document.getElementById('fetch-whisper').addEventListener('click', () =>
  startFetch(
    async () => (await call('fetch_whisper')).downloads,
    document.getElementById('whisper-fetch-failed'),
  ));

document.getElementById('fetch-model').addEventListener('click', () =>
  startFetch(
    async () => (await call('fetch_model', {
      name: document.getElementById('model-choice').value,
    })).downloads,
    document.getElementById('model-fetch-failed'),
  ));
