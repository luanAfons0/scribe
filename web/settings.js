/* The Settings view: the four settings the operator chooses, as get_settings
   tells them, and the form that changes them with update_settings. scribe is
   set up here, once, and works however the Host was started (ADR-0004).

   A field shows what settings.json holds. When a variable set where the Host
   is started decides a setting, the note under its field says so, and what
   is saved here waits until the variable is gone. A variable that is not in
   its form, such as the shell line of scribe 1.x, decides nothing, and the
   Plugin Server's sentence beside the setting says to remove it. What is
   missing or wrong is the Plugin Server's own sentence, shown beside the
   setting it names.

   Under whisper.cpp and its model, downloads.js offers to fetch them.

   app.js decides when the view is shown, and calls showSettings() and
   recordingProblem(). */
'use strict';

/** The settings the operator chooses, in the order the view shows them. */
const SETTING_NAMES = ['whisper', 'whisperModel', 'minutesCommand', 'worklogPlugin'];

/** A value as a field shows it: a path or a name as it is, a command as its JSON array. */
function fieldText(value) {
  if (value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * What a field holds, as update_settings takes it: null when it is empty, and
 * a command read as JSON. A command that is not JSON is sent as the text it
 * is, and the Plugin Server refuses it with the sentence that shows the form.
 */
function fieldValue(name, text) {
  const given = text.trim();
  if (given === '') return null;
  if (name !== 'minutesCommand') return given;
  try {
    return JSON.parse(given);
  } catch {
    return given;
  }
}

/** Draw every setting; with `fill`, put what the file holds in the fields too. */
function drawSettings(settings, fill) {
  for (const name of SETTING_NAMES) {
    const setting = settings[name];
    if (fill) document.getElementById('set-' + name).value = fieldText(setting.saved);
    const from = document.getElementById(name + '-from');
    from.hidden = setting.from !== 'environment';
    from.textContent =
      setting.variable + ' decides this where the Host is started' +
      (setting.value === null ? '' : ': ' + fieldText(setting.value)) +
      '. What is saved here is used once it is not set.';
    const ignored = document.getElementById(name + '-ignored');
    ignored.hidden = setting.ignored === null;
    ignored.textContent = setting.ignored || '';
    const problem = document.getElementById(name + '-problem');
    problem.hidden = setting.problem === null;
    problem.textContent = setting.problem || '';
  }
}

/** Show the Settings view, with what the Plugin Server holds now, and what it can fetch. */
async function showSettings() {
  const settings = (await call('get_settings')).settings;
  drawSettings(settings, true);
  await showDownloads(settings);
}

/** The sentence that says why no Call can record, or null when one can. */
async function recordingProblem() {
  const settings = (await call('get_settings')).settings;
  return settings.whisper.problem || settings.whisperModel.problem || null;
}

document.getElementById('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = document.getElementById('settings-saved');
  const refused = document.getElementById('settings-refused');
  saved.hidden = true;
  const given = {};
  for (const name of SETTING_NAMES) {
    given[name] = fieldValue(name, document.getElementById('set-' + name).value);
  }
  try {
    drawSettings((await call('update_settings', given)).settings, true);
    refused.hidden = true;
    saved.hidden = false;
  } catch (fault) {
    // Nothing was kept: the fields stay as typed, so the one that is wrong
    // can be put right.
    refused.textContent = fault.message || String(fault);
    refused.hidden = false;
  }
});
