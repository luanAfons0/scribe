/* The offers to fetch whisper.cpp and a model, under their settings in the
   Settings view, as get_downloads tells them (ADR-0005).

   Nothing is fetched until the operator clicks: each fetch tool is called
   from its own button and nowhere else. A download runs in the Plugin Server;
   this view asks how far it got while one runs, and when it ends draws the
   settings again, which now name what was fetched. A download that failed
   leaves its one sentence under its button. The offer to fetch whisper.cpp
   is shown only while whisper.cpp is not set, or is set and cannot be run;
   the models are always offered, the one downloads.json names first.

   settings.js calls showDownloads(settings) when the Settings view opens. */
'use strict';

/** How often the view asks how far a download got. */
const DOWNLOAD_POLL_MS = 500;

/** The timer of the next ask, or null when no download runs. */
let downloadTimer = null;

/** A size in bytes, as a person reads it. */
function sizeText(bytes) {
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
}

/**
 * Whether whisper.cpp is set and can be run, as get_settings last said. The
 * offer to fetch it is shown only when it is not.
 */
let whisperReady = false;

/** Whether a download is in flight. */
function inFlight(download) {
  return download !== null && download.failed === null;
}

/** Whether a download failed, and its sentence is to be shown. */
function failedDownload(download) {
  return download !== null && download.failed !== null;
}

/** Draw one download: its progress while it runs, its sentence when it failed. */
function drawDownload(download, button, progress, failed) {
  const running = inFlight(download);
  button.disabled = running;
  progress.hidden = !running;
  if (running) progress.value = download.size > 0 ? download.received / download.size : 0;
  failed.hidden = !failedDownload(download);
  failed.textContent = failedDownload(download) ? download.failed : '';
}

/** Draw both offers, and ask again while a download runs. */
function drawDownloads(downloads) {
  const whisper = downloads.whisper;
  const offer = document.getElementById('whisper-offer');
  const fetchWhisper = document.getElementById('fetch-whisper');
  // A whisper.cpp that is set and runs needs no offer, unless one is being
  // fetched or has just failed, which the operator asked for.
  const offered = !whisperReady || inFlight(whisper.fetch) || failedDownload(whisper.fetch);
  offer.hidden = !offered;
  if (whisper.build === null) {
    offer.textContent = whisper.missing;
    fetchWhisper.hidden = true;
  } else {
    offer.textContent =
      'Or fetch whisper.cpp ' + whisper.release + ' for this system, ' +
      sizeText(whisper.build.size) + ', checked before it is kept.';
    fetchWhisper.hidden = !offered;
  }
  drawDownload(
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
      option.selected = model.name === downloads.models.default;
      return option;
    }));
  }
  drawDownload(
    downloads.models.fetch,
    document.getElementById('fetch-model'),
    document.getElementById('model-progress'),
    document.getElementById('model-fetch-failed'),
  );

  const running = inFlight(whisper.fetch) || inFlight(downloads.models.fetch);
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

/**
 * Draw the offers with what the Plugin Server holds now. `settings` is what
 * get_settings answered, which says whether whisper.cpp is set and runs.
 */
async function showDownloads(settings) {
  whisperReady = settings.whisper.value !== null && settings.whisper.problem === null;
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
