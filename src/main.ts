/**
 * Start-up: read the settings, open `scribe.db`, serve the tools.
 *
 * The Host spawned this process, holds both ends of its pipe, and started it
 * in the Plugin's own directory, so the two files this Plugin owns,
 * `scribe.db` and `settings.json`, are one relative path away (FirstMate
 * ADR-0005).
 *
 * It says nothing on the way up. A Plugin Server that started is what the
 * Index Page shows; the journal is for what went wrong.
 */
import { receive } from './bus.ts';
import { readDownloads } from './downloads.ts';
import { fetcherFor } from './fetcher.ts';
import { sentenceFor, serve } from './mcp.ts';
import { minutesMakerFor, type MinutesMaker } from './minutes-maker.ts';
import { recorderFor } from './recorder.ts';
import { endEveryTree } from './run.ts';
import { openChoices, readSettings } from './settings.ts';
import { openStore } from './store.ts';
import { toolsFor } from './tools.ts';
import { transcriberFor } from './transcriber.ts';
import { entrySenderFor } from './worklog-entry.ts';

// A time that is not a number, or a `scribe.db` that cannot be opened, is one
// sentence and a non-zero exit: the Index Page shows the Plugin Stopped and
// the journal carries the reason. The Host does not start it again. What the
// operator chooses never ends it: a missing whisper.cpp or a broken settings
// file is said on the Plugin Page, where it is fixed (ADR-0004).
const { settings, choices, store, downloads } = (() => {
  try {
    return {
      settings: readSettings(),
      choices: openChoices(),
      store: openStore(),
      downloads: readDownloads(),
    };
  } catch (fault) {
    process.stderr.write(`scribe: ${sentenceFor(fault)}\n`);
    return process.exit(1);
  }
})();

// Whisper tells the MinutesMaker when a Call is heard, and the MinutesMaker
// asks Whisper whether it is: the one is made before the other, and each
// reaches the other through a function.
let maker: MinutesMaker | null = null;
const heard = (id: number): void => maker?.heard(id);
const transcriber = transcriberFor(store, choices, heard);
const sender = entrySenderFor(store, settings, choices);
maker = minutesMakerFor(
  store,
  settings,
  choices,
  (id) => transcriber.busyWith(id),
  (id) => sender.made(id),
);
const recorder = recorderFor(store, transcriber, settings, choices, heard);

const fetcher = fetcherFor(downloads, choices, settings);

serve(toolsFor({ store, recorder, transcriber, maker, choices, fetcher }), receive);

// No whisper.cpp and no Minutes command outlives the Plugin Server (ADR-0003).
// The Host closes stdin to stop it, and nobody is left to answer then, so it
// ends what it started and goes at once. A signal does the same, and then
// ends it as the signal would have.
process.on('exit', endEveryTree);
process.stdin.on('end', () => process.exit(0));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(signal, () => {
    endEveryTree();
    process.kill(process.pid, signal);
  });
}
