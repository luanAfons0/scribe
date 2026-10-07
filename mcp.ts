/**
 * The entry point the Host runs: its own Node, with this file, in the Plugin
 * directory, with no shell (FirstMate ADR-0028). It works on every system the
 * App runs on, because it needs nothing but a Node.
 *
 * It is one line on purpose. `mcp`, the `sh` wrapper, is for a `wsl` Place and
 * runs `src/main.ts` the same way.
 */
import './src/main.ts';
