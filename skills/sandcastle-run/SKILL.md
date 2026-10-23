---
name: sandcastle-run
description: Run a sandcastle-orchestrator Orchestration Issue end to end — preflight it, launch it, watch it, act on what parks, and land the integration pull requests. Use when the user says "run sandcastle on <repo>#N", "start the sandcastle run", asks about a sandcastle-orchestrator run in flight, or asks you to babysit or finish one.
---

Take an Orchestration Issue from "start it" to "the integration pull requests are open", without asking the user to click anything.

Everything you need is `npm run ops` in the sandcastle-orchestrator checkout. Every subcommand prints one JSON object; read it, don't screen-scrape the UI. Every command needs the project: pass `--config=<path to sandcastle.config.json>` or export `SANDCASTLE_CONFIG` once for the shell.

```bash
npm run ops -- preflight <parent>              # every start-time check, no lock taken
npm run ops -- launch <parent> --cap=N         # brings the control plane up if it is down
npm run ops -- status [--items]                # phases, holds, waiting, parked, last feed lines
npm run ops -- logs <item> [stage]             # tail the newest recorded attempt
npm run ops -- resume-parked [--only=<text>]   # retry parked items whose reason matches
npm run ops -- resolve-conflict <item>         # retry one park; the gate gets another resolve agent
npm run ops -- finish                          # assert complete + print the integration pull requests
```

## The loop

1. **Validate, then preflight.** `npm run validate -- <parent>` shows the run model: which items are queued, which are **held** (no `ready-for-agent`), and the edges. Tell the user up front which held items block the rest. Then `ops -- preflight <parent>`: every failure names what to fix (missing `.env`/`GH_TOKEN`, missing `.env.sandbox`, docker down or image missing → `npm run build-image`, a missing skill, dead agent credentials → `npm run sync-claude` or log in to Claude Code again). Never launch on a red preflight.
2. **Launch.** `launch <parent> --cap=N` (2 is usual; 1 when the usage window is nearly spent). It is idempotent: if a run is already in flight it says so.
3. **Watch, slowly.** Poll `status` every few minutes, not every few seconds. A run takes hours. Between polls, do nothing.
4. **Read each state and act:**

   | what `status` shows | what you do |
   |---|---|
   | `running` / `awaiting` items | nothing. The normal case. |
   | `waiting`, `waitReason: rate-limit` | **nothing.** It resumes itself at `resumeAt`. Do not retry it. |
   | `waiting`, `waitReason: auth` | the run re-probes every poll. Still waiting after two polls → `npm run sync-claude` (or re-login on the host). |
   | `held` items | a human must do them or add `ready-for-agent`. Report them; never relabel on your own. |
   | `parked`, merge conflict | `resolve-conflict <item>`. Parks again → `logs <item>`, resolve by hand in `projects/<project>/worktrees/<repo>/<branch>` — never in the user's working checkout — and push with `--force-with-lease`. |
   | `parked`, red checks | `logs <item> verify`. Trivial and inside the item's own files → fix it in the item's worktree, push, `resume-parked --only=<reason>`. Pre-existing breakage on the base branch → tell the user; it is a `checks` config problem, not this item's. |
   | `parked`, `UNFIXABLE` | report it with the agent's reason. Do not retry. |
   | `parked`, anything else | `logs <item>`, report the last event, then decide. |
   | `stalled`, everything parked or held | you have work to do — see the rows above. |
5. **Finish.** When `status` says `complete`, run `finish`. Green means the integration pull requests are open: comment a summary on the parent issue (items merged, human interventions, anything still held), give the user the pull-request URLs. A red Feature Verify is a report, not a retry: give the user the reason and the failing scenarios.

## Hard rules

- **Never kill the UI process to "restart cleanly".** Crash-resume re-runs whole stages on already-reviewed branches and burns tokens.
- **Never `git rebase` a worktree while its container is up.** The item must not be `running`.
- **Always `--force-with-lease`,** never a plain `--force`.
- **Resolve conflicts in the state dir's `worktrees/`,** never in the user's checkout — their uncommitted work lives there.
- **A `waiting` item is not a parked item.** Retrying one throws the wait away.
- **One control plane per project.** To line several parents up, `launch` them together or `ops -- enqueue`.
- **Do not edit item code yourself** beyond the conflict/red-check exceptions. The agents own the implementation; you own the pipeline.
- **Never merge the integration pull requests.** A human does.

## Reporting

After each meaningful event (launch, a park you acted on, completion) say in one or two lines: the phase, what you did, what you are waiting for. Do not narrate every poll. If you are blocked on something only the user can decide — an `UNFIXABLE` item, a red Feature Verify, held items — say exactly what you need.

Background: the repo's `README.md` (config, publish contract, commands) and `docs/internals.md` (preflight, waiting, conflicts, rework, Feature Verify, transcripts).
