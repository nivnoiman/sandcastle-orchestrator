---
description: Run a sandcastle-orchestrator Orchestration Issue end to end
argument-hint: <parent issue number, #N or issue URL> [more parents]
---

Run a sandcastle-orchestrator Orchestration Issue end to end: $ARGUMENTS

Use the `sandcastle-run` skill (you are the Orchestrator Agent). `$ARGUMENTS` is a parent issue number, `#N`, or a GitHub issue URL. The CLI takes numbers only, so pass the number from a URL. Several parents: `sandcastle launch <a> <b> --cap=2` queues them.

Checklist, from the project root (the folder that holds `.sandcastle/`):

1. `sandcastle dashboard --detach`
2. `sandcastle validate <parent>`. Report held Items that block the rest.
3. `sandcastle preflight <parent>` until green. Never launch on red.
4. `sandcastle launch <parent> --cap=2`
5. `sandcastle dashboard --open` so the Operator sees the Board View.
6. Poll `sandcastle status` every few minutes. Between polls, do nothing.
7. Report Needs Attention by name and act per the skill (Parked Item, Run Stall, Quiet Item, Holds, Project Server died...).
8. On `complete`: `sandcastle finish`, comment a summary on the parent issue, report the integration pull request URLs.

Hard rules:

- Never kill the Project Server process.
- Never rebase a worktree whose container is up.
- Never retry a `waiting` Item. It resumes itself.
- Never merge the integration pull requests. A human does.
