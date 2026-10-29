# Tracker seam and Local Tracker

A Project picks a Tracker (`tracker: local | github`). Run state reads (`fetchRunSnapshot`) and writes (`GhClient`) move behind one Tracker interface, with GitHub as the existing implementation. The Local Tracker stores issues as files in the hub repo, so a Project works with no GitHub.

## Decisions

- Layout follows `to-tickets`' local format: `.scratch/<slug>/issues/00-parent.md` plus `NN-slug.md`, extended with YAML frontmatter (`repo`, `state`, `stage`, `blocked-by`). The number is the canonical handle; slug or path also accepted.
- The engine writes only its own frontmatter keys (atomic read-modify-write), appends park reasons as a section, and re-reads files each tick so Operator edits are picked up.
- Git: real `origin` if present, else a bare repo per code repo under `.sandcastle/remotes/`. Per-Item draft PR + squash merge becomes `git merge --squash` into the integration branch; a Run ends with an integration branch for the Operator to merge.
- Agent prompts get a local variant selected by `tracker` (no `gh pr` lines).
- `sandcastle init` writes `docs/agents/issue-tracker.md` naming the Tracker; the vendored `to-tickets` stays unmodified.
- `hubRepo` is required only for `tracker: github`; preflight skips `gh`/`origin` checks locally and validates the issue files instead.

## Considered Options

- Single `issues.yaml`: harder to diff and to edit in parallel.
- Making every `origin/` ref configurable (no remote at all): large churn across git code for little gain.
- Modifying the vendored `to-tickets`: breaks the pinned-copy rule (ADR 0003).

## Consequences

- Slice 1 is a behavior-neutral refactor; local mode builds on it.
- Publishing local issues to GitHub later is out of scope; the frontmatter keeps the needed data.
