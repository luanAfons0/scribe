# The Plugin Release is built, and the repository is not

The repository runs from source: Node 24 runs `mcp.ts` with no build step. The
Plugin Release that `firstmate install scribe` fetches is built by
`npm run release` (`scripts/release.ts`): `tsdown` bundles `mcp.ts` into
`release/mcp.js`, not minified, and `release/` also holds `web/`, an `mcp`
wrapper for a `wsl` Place, and `downloads.json`, which `src/downloads.ts`
reads beside its own file. It holds no `mcp.ts`, because the Host starts
`mcp.ts` before `mcp.js`, and none of `scribe.db`, `settings.json` or `audio/`,
which are the Plugin's data and which `firstmate update` keeps. The decision is
FirstMate's [ADR-0033](https://github.com/luanAfons0/FirstMate/blob/main/docs/adr/0033-a-git-url-is-fetched-as-a-plugin-release.md);
`.github/workflows/release.yml` calls its workflow on a tag `v*.*.*`.
