/**
 * Build the files of a Plugin Release into `release/` (FirstMate ADR-0033).
 *
 *   node scripts/release.ts
 *
 * The repository runs from source with no build step; only the Plugin Release
 * is built. It holds exactly what the Host needs to run the Plugin:
 *
 * - `mcp.js`, `mcp.ts` bundled into one file with `tsdown`. It is not minified,
 *   so a stack trace stays readable. There is no `mcp.ts` beside it, because
 *   the Host starts `mcp.ts` before `mcp.js` (FirstMate ADR-0028) and would run
 *   the source.
 * - `downloads.json`, the list `src/downloads.ts` reads beside its own file,
 *   which in the bundle is `mcp.js`.
 * - `web/`, the Plugin Page, as it is.
 * - `mcp`, the `sh` wrapper for a `wsl` Place, which runs `mcp.js`.
 *
 * It never copies `scribe.db`, `settings.json` or `audio/`: they are the
 * Plugin's data, and `firstmate update` keeps every file that is not a
 * Release File.
 */
import { chmod, cp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'release');

/** The `mcp` of the Plugin Release: the wrapper of the source, pointed at `mcp.js`. */
const WRAPPER = `#!/bin/sh
# The Host runs this file in a \`wsl\` Place and speaks MCP to it over stdio. It
# looks for a Node 24 rather than trusting \`node\`, because a service's PATH is
# not a login shell's (see the \`mcp\` of the source repository).
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for node in \${SCRIBE_NODE:+"$SCRIBE_NODE"} \\
            "$(command -v node 2>/dev/null)" \\
            "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$node" ] || continue
  major=$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  [ "$major" -ge 24 ] 2>/dev/null || continue
  exec "$node" "$here/mcp.js"
done

echo "scribe: no Node 24 or newer was found. Set SCRIBE_NODE to a Node 24, or start the Host with one on its PATH." >&2
exit 1
`;

await rm(OUT, { recursive: true, force: true });
await build({
  cwd: ROOT,
  config: false,
  entry: { mcp: 'mcp.ts' },
  format: 'esm',
  platform: 'node',
  outDir: OUT,
  fixedExtension: false,
  clean: false,
  dts: false,
  minify: false,
  sourcemap: false,
  logLevel: 'warn',
});
await cp(join(ROOT, 'src', 'downloads.json'), join(OUT, 'downloads.json'));
await cp(join(ROOT, 'web'), join(OUT, 'web'), { recursive: true });
await writeFile(join(OUT, 'mcp'), WRAPPER);
await chmod(join(OUT, 'mcp'), 0o755);
