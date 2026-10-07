/**
 * The settings file, `settings.json`, in the Plugin directory beside
 * `scribe.db`: what the operator chose on the Plugin Page.
 *
 * It lives in the Plugin's own directory, so it is scribe's alone and the Host
 * neither reads nor keeps it (FirstMate ADR-0005). A setting in it works
 * however the Host was started: the App, a shell or systemd. research keeps
 * its own `settings.json` the same way, so an operator finds both alike.
 *
 * The file is written whole, to a file beside it, and then renamed over it, so
 * a Plugin Server that stops halfway leaves the old file or the new one and
 * never half of either. A key this scribe does not know is kept as it is.
 * A file that is not JSON is not read at all, and the next save writes a new
 * one in its place (ADR-0004).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The name of the settings file in the Plugin directory. */
export const SETTINGS_FILE = 'settings.json';

/** The settings file as an object of whatever it holds, or an empty one when there is none. */
export function readSettingsFile(directory = '.'): Record<string, unknown> {
  const path = pathOf(directory);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (fault) {
    if ((fault as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw fault;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${path} is not a JSON object; save the settings on the Plugin Page to write it again.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Write the whole settings file: a key whose value is null is left out. */
export function writeSettingsFile(
  whole: Readonly<Record<string, unknown>>,
  directory = '.',
): void {
  const kept = Object.fromEntries(Object.entries(whole).filter(([, value]) => value !== null));
  const path = pathOf(directory);
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(kept, null, 2)}\n`);
  renameSync(next, path);
}

/** The absolute path of the settings file, for a sentence that names it. */
export function pathOf(directory = '.'): string {
  return resolve(join(directory, SETTINGS_FILE));
}
