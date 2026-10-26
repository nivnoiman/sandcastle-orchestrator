# Agent skills shipped in-repo and installed by `sandcastle skills install`

The repo is public and must set up end to end on a fresh machine, so every skill the stages and the Orchestrator Agent need ships in the repo: our own under `skills/` and `commands/`, third-party ones (mattpocock/skills: `tdd`, `to-spec`, `to-tickets`) vendored under `skills/vendor/<owner>/` at a pinned commit with their license. `sandcastle skills install` copies them into `~/.claude/skills` and `~/.claude/commands`, skipping locally modified copies unless `--force`.

## Considered Options

- Claude Code plugin depending on mattpocock's plugin: plugin skills land under `~/.claude/plugins/`, which preflight checks and container mounts don't read, and Codex gets nothing.
- README `cp` instructions only: not a full setup for public users.

## Consequences

- Upstream skill changes reach stages only through a deliberate `sandcastle skills update-vendor`.
- Preflight reuses `sandcastle skills install --check`.
