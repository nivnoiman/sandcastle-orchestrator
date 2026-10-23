---
description: Run a sandcastle-orchestrator Orchestration Issue end to end
argument-hint: <parent issue number, #N or issue URL> [more parents]
---

Run a sandcastle-orchestrator Orchestration Issue end to end: $ARGUMENTS

Use the `sandcastle-run` skill. `$ARGUMENTS` is a parent issue number, `#N`, or a GitHub issue URL. The CLI takes numbers only, so pass the number from a URL. With several parents, run them in order, or launch them together (`sandcastle launch <a> <b> --cap=2`) when they are independent.

Checklist:

1. Work from the project root: the folder that holds `.sandcastle/`. No `--config` needed there.
2. `sandcastle validate <parent>`. Report held items that block the rest.
3. `sandcastle preflight <parent>` until it is green. Fix what each failure names; never launch on red.
4. `sandcastle launch <parent> --cap=2`.
5. Poll `sandcastle status` every few minutes. Between polls, do nothing.
6. Act on parks as the skill's table says (`resolve-conflict`, `logs`, `resume-parked`, or report).
7. When `status` says `complete`: `sandcastle finish`.
8. Comment a summary on the parent issue: items merged, human interventions, anything still held.
9. Report the integration pull request URLs.

Hard rules:

- Never kill the UI process.
- Never rebase a worktree whose container is up.
- Never retry a `waiting` item. It resumes itself.
- Never merge the integration pull requests. A human does.
