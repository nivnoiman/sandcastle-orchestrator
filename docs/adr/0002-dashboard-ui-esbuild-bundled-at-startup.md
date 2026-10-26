# Dashboard UI: plain TypeScript bundled by esbuild at server startup

The new view is written in plain TypeScript (no framework) sharing `UiState`/`UiItem` types with the server, and the Project Server and Dashboard bundle it in memory with esbuild's API at startup. This keeps the repo's run-from-source model (`tsx`, nothing generated in git, no build step for `npm link`) while giving compile-time checks across the proxied state contract.

## Considered Options

- Native ES modules with JSDoc `@ts-check`: zero deps, but weaker sharing of server types.
- Preact/Lit: easier composition, but a new paradigm and more deps for a local operator tool.
- Committed bundle / build on `prepare`: generated artifacts or install-time breakage.

## Consequences

- `esbuild` becomes a direct dependency, pinned to the version `tsx` already pulls in.
- Startup pays a ~100ms bundle cost; the Legacy View stays a static file.
