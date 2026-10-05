/**
 * Start-up: read the settings, open `scribe.db`, serve the tools.
 *
 * The Host spawned this process, holds both ends of its pipe, and started it
 * in the Plugin's own directory, so the one file this Plugin owns is one
 * relative path away (FirstMate ADR-0005).
 *
 * It says nothing on the way up. A Plugin Server that started is what the
 * Index Page shows; the journal is for what went wrong.
 */
import { receive } from './bus.ts';
import { sentenceFor, serve } from './mcp.ts';
import { minutesMakerFor, type MinutesMaker } from './minutes-maker.ts';
import { recorderFor } from './recorder.ts';
import { readSettings } from './settings.ts';
import { openStore } from './store.ts';
import { toolsFor } from './tools.ts';
import { transcriberFor } from './transcriber.ts';
import { entrySenderFor } from './worklog-entry.ts';

// A missing whisper.cpp, a missing model, or a file that cannot be opened is
// one sentence and a non-zero exit: the Index Page shows the Plugin Stopped
// and the journal carries the reason. The Host does not start it again.
const { settings, store } = (() => {
  try {
    return { settings: readSettings(), store: openStore() };
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
const transcriber = transcriberFor(store, settings, heard);
const sender = entrySenderFor(store, settings);
maker = minutesMakerFor(
  store,
  settings,
  (id) => transcriber.busyWith(id),
  (id) => sender.made(id),
);
const recorder = recorderFor(store, transcriber, settings, heard);

serve(toolsFor({ store, recorder, transcriber, maker }), receive);
