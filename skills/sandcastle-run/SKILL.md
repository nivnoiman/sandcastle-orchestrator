---
name: sandcastle-run
description: Run a sandcastle-orchestrator Orchestration Issue end to end. Preflight it, launch it, watch it, act on what parks, and land the integration pull requests. Use when the user says "run sandcastle on #N", "start the sandcastle run", "/sandcastle-run", asks about a sandcastle-orchestrator run in flight, or asks you to babysit or finish one.
---

Take an Orchestration Issue from "start it" to "the integration pull requests are open", without asking the user to click anything.

Everything you need is the `sandcastle` CLI, run from the project root (the folder that holds `.sandcastle/`). It finds `.sandcastle/config.json` by walking up from the current directory, so no `--config` is needed there. From anywhere else, pass `--config=<project root>`. Run commands print one JSON object; read it, do not screen-scrape the UI.

```bash
sandcastle validate <parent>                # run model: queued, held, edges
sandcastle preflight <parent>               # every start-time check, no lock taken
sandcastle launch <parent> --cap=N          # brings the control plane up if it is down
sandcastle status [--items]                 # phases, holds, waiting, parked, last feed lines
sandcastle logs <item> [stage]              # tail the newest recorded attempt
sandcastle resume-parked [--only=<text>]    # retry parked items whose reason matches
sandcastle resolve-conflict <item>          # retry one park; the gate gets another resolve agent
sandcastle finish                           # assert complete, print the integration pull requests
```

The dashboard is at `http://127.0.0.1:<ui.port>` (from `.sandcastle/config.json`, default 7777). The control plane log is `.sandcastle/ui-<parent>.log`.

## The loop

1. **Validate, then preflight.** `sandcastle validate <parent>` shows which items are queued, which are **held** (no `ready-for-agent`), and the edges. Tell the user up front which held items block the rest. Then `sandcastle preflight <parent>`. Every failure names what to fix:

   | preflight failure | fix |
   |---|---|
   | missing `.env.orchestrator` or `GH_TOKEN` | fill `.sandcastle/.env.orchestrator` (ask the user for the token) |
   | missing `.env.sandbox` | create `.sandcastle/.env.sandbox`; an empty file is fine |
   | Docker down or image missing | start Docker; `npm run build-image` in the sandcastle clone |
   | missing agent skill | install it into `~/.claude` (see the repo README, Agent skills) |
   | dead agent credentials | `sandcastle sync-claude <source>` or log in to Claude Code again |

   Never launch on a red preflight.
2. **Launch.** `sandcastle launch <parent> --cap=N`. 2 is usual; 1 when the usage window is nearly spent. It is idempotent: if a run is already in flight it says so.
3. **Watch, slowly.** Poll `sandcastle status` every few minutes, not every few seconds. A run takes hours. Between polls, do nothing.
4. **Read each state and act:**

   | what `status` shows | what you do |
   |---|---|
   | `running` / `awaiting` items | Nothing. The normal case. |
   | `waiting`, `waitReason: rate-limit` | **Nothing.** It resumes itself at `resumeAt`. Do not retry it. |
   | `waiting`, `waitReason: auth` | The run re-probes every poll. Still waiting after two polls: `sandcastle sync-claude <source>`, or re-login on the host. |
   | `held` items | A human must do them or add `ready-for-agent`. Report them; never relabel on your own. |
   | `parked`, merge conflict | `sandcastle resolve-conflict <item>`. If it parks again: `sandcastle logs <item>`, resolve by hand in `~/.sandcastle/worktrees/<project>/<repo>/<branch>` (never in the user's working checkout) and push with `--force-with-lease`. |
   | `parked`, red checks | `sandcastle logs <item> verify`. Trivial and inside the item's own files: fix it in the item's worktree, push, `sandcastle resume-parked --only=<reason>`. Pre-existing breakage on the base branch: tell the user. It is a `checks` config problem, not this item's. |
   | `parked`, `UNFIXABLE` | Report it with the agent's reason. Do not retry. |
   | `parked`, anything else | `sandcastle logs <item>`, report the last event, then decide. |
   | `stalled`, everything parked or held | You have work to do. See the rows above. |
5. **Finish.** When `status` says `complete`, run `sandcastle finish`. Green means the integration pull requests are open. Comment a summary on the parent issue (items merged, human interventions, anything still held) and give the user the pull-request URLs. A red Feature Verify is a report, not a retry: give the user the reason and the failing scenarios.

## Hard rules

- **Never kill the UI process to "restart cleanly".** Crash-resume re-runs whole stages on already-reviewed branches and burns tokens.
- **Never `git rebase` a worktree while its container is up.** The item must not be `running`.
- **Always `--force-with-lease`,** never a plain `--force`.
- **Resolve conflicts in `~/.sandcastle/worktrees/<project>/`,** never in the user's checkout. Their uncommitted work lives there.
- **A `waiting` item is not a parked item.** Retrying one throws the wait away.
- **One control plane per project.** To line several parents up, `launch` them together or `sandcastle enqueue`.
- **Do not edit item code yourself** beyond the conflict and red-check exceptions. The agents own the implementation; you own the pipeline.
- **Never merge the integration pull requests.** A human does.

## Reporting

After each meaningful event (launch, a park you acted on, completion) say in one or two lines: the phase, what you did, what you are waiting for. Do not narrate every poll. If you are blocked on something only the user can decide (an `UNFIXABLE` item, a red Feature Verify, held items), say exactly what you need.

Background: the sandcastle-orchestrator `README.md` (config, publish contract, commands) and `docs/internals.md` (preflight, waiting, conflicts, rework, Feature Verify, transcripts).
