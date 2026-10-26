# Dashboard aggregates per-project servers

The multi-project dashboard is a separate `sandcastle dashboard` process that discovers running per-project `sandcastle ui` servers through a shared instance registry and proxies their state, event streams and actions. Each project keeps its own process, port, lock and state dir; the engine is untouched.

## Considered Options

- One process hosting every project: cleanest UX but rewrites boot, locks, state dirs and engine. Rejected as too risky.
- Browser connecting to each port directly: needs CORS on every server plus port discovery in the client.
- Rail of plain links to other ports: cheapest, but switching is not seamless.

## Consequences

- A single project server still serves the new view on its own (rail of one).
- Process isolation is kept: one project crashing doesn't take down others.
- The registry remembers Known Projects that have run before; the Dashboard can start a stopped one by spawning an idle `sandcastle ui` (no parent argument) in its directory. Adding a brand-new project (init) stays CLI-only.
- At most one registry entry (one Project Server) per Project; mode (dry/real) is recorded per entry and flagged loudly in the UI. The Dashboard only ever spawns real-mode Idle Project Servers; dry runs stay CLI-only.
- The Dashboard binds 127.0.0.1, enforces the same Host/header guard, forwards the header without adding authority, proxies only to registered loopback ports, and spawns only a fixed `sandcastle ui` command for Known Projects addressed by id (never a client-supplied path or argument).
