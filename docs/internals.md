# How sandcastle-orchestrator works

## What this document covers

This is the design reference for sandcastle-orchestrator, an issue-driven multi-agent
orchestrator. It explains how a run is modelled, scheduled and executed, and how each part
fails safely: the engine, the stage chain, the GitHub label mirror, crash-resume, the
sandbox, Feature Verify, polish, the control plane and the operator CLI. For the shape an
Orchestration Issue must have, see README, Publish contract. Vocabulary used throughout:
Orchestration Issue (the parent), Work Item (a sub-issue), Stage Chain, Worker, Parked,
Held, Control Plane, Run Queue, Global Cap.

Where this document says "Claude Code" or `claude -p`, read "the stage's agent provider".
Agent CLIs are pluggable per stage (`src/real/agents/`). The design and the Codex specifics,
such as token refresh, failure parsing and skill delivery, are in
[design/agent-providers.md](design/agent-providers.md).

The stage chain below is the default. A project can drop simplify or review and add custom
agent or command stages with `stages` in its config (`src/project/stagesConfig.ts`); see
[design/configurable-stages.md](design/configurable-stages.md).

A project is configured by `.sandcastle/config.json` at the root of the consuming repo.
The CLI finds it with `--config=<path>`, then `SANDCASTLE_CONFIG`, then by walking up from
the current directory to the first `.sandcastle/config.json`. `--config` and
`SANDCASTLE_CONFIG` accept the file, the `.sandcastle` folder or the project root; relative
paths in the config resolve against the project root. The config names the project
(`name`), the hub repo that holds orchestration issues (`hubRepo`, `owner/name`), the
integration base branch (`integrationBase`, default `dev`), the image (`imageTag`, default
`sandcastle:latest`), the host memory project (`memoryProject`), an optional `stateDir`, the
service repos (`repos.<name>`: `github`, `path`, `bootstrap`, `checks`), the Feature Verify
strategy (`verify.strategy`: `none` | `command` | `compose`) and the control plane port
(`ui.port`, default 7777). Any repo in `repos` is targeted by a `repo:<name>` label on a
sub-issue; the hub repo and a service repo may be the same repository (single-repo mode).
Examples below use an `api` and a `web` repo; they are examples, not a fixed set.

| What | Where (default) | Override |
|---|---|---|
| Config | `<project>/.sandcastle/config.json` | `--config`, `SANDCASTLE_CONFIG` |
| State: `.env.orchestrator`, `.env.sandbox*`, `logs/`, `.orchestrator.lock`, `.queue.json`, `ui-<parent>.log` | `<project>/.sandcastle/` | `stateDir` in the config, `SANDCASTLE_DIR` |
| Worktrees | `~/.sandcastle/worktrees/<project>/<repo>/<branch>` | `SANDCASTLE_WORKTREE_DIR` |
| Shared `.env.orchestrator` | `<sandcastle clone>/.env.orchestrator`, read first | the project's own file wins on a clash |
| Control plane port | `ui.port`, else 7777 | `--port=N`, then `SANDCASTLE_UI_PORT` |

Because state, lock, queue, Docker names (`sc-<project>-...`) and port are all per project,
several projects run side by side. State from the old layout
(`<sandcastle clone>/projects/<name>/`) moves into `<project>/.sandcastle/`, or `stateDir`
can point at the old folder.

From the sandcastle clone (`npm link` makes `sandcastle` global):

```bash
npm ci
npm run typecheck
npm test
npm run build-image                                                         # docker image (config imageTag)
sandcastle dry-run examples/demo/demo-run.json --config=examples/demo [--cap=N]        # zero tokens/env needed
sandcastle ui examples/demo/demo-run.json --config=examples/demo [--cap=N] [--port=N]  # control plane + paced dry run
```

From the project root:

```bash
sandcastle validate <parent-issue>
sandcastle dry-run <parent-issue> [--cap=N]                # live issue via gh
sandcastle smoke <repo>                                    # non-billed plumbing check
sandcastle ui <parent-issue> --dry [--fail=17:review]      # paced simulation of THAT parent
sandcastle ui <parent-issue> [--cap=N]                     # control plane, real mode
sandcastle start <parent-issue> [--cap=N]                  # the real thing (spends tokens)
sandcastle reset <parent-issue> [--apply]                  # clear a killed run's debris
```

`validate` fetches an Orchestration Issue (native sub-issues + native blocked-by via
`gh`), builds the run model, and prints it, or every contract violation, naming the
offending issue and rule.

`dry-run` feeds the run model to the scheduling engine with fake adapters and instant
stage completions, printing every emitted command (branch creation, sc:* label mirror,
stage spawns, verify gate, merges) plus each item's final state. The engine
(`src/engine/`) is event-driven and deterministic: DAG admission, global worker cap
(default 1), stage chain develop -> simplify -> review -> verify-gate -> merge, drain-first
slot handoff (deeper stage first, then most currently-blocked dependents, then lowest
issue number; verify occupies a slot too), park-on-failure. It
talks only through the GhClient / SandboxRunner / GitOps / UiSink adapter interfaces:
`src/engine/fakes.ts` records them for tests, `src/real/` implements them for real.

## Live-watch sync

`engine.applySnapshot(nextModel)` folds a freshly fetched run model into a live run.
It is **additive-safe**, never destructive:

- new sub-issues join as held / blocked / queued per admission + deps, with their
  `sc:*` label mirrored;
- dependency edits re-wire items that have **not** started, promoting or re-blocking
  them; a queued/blocked/held item that leaves the model or gets closed drops out of
  the queue (a dep pointing at an item that completed and then left counts satisfied);
- **running / awaiting / parked items are never killed or re-wired**: any change
  touching one emits `ui.warn(itemNumber, …)` and is otherwise ignored; cancellation
  stays a manual action.

Admission is a per-item hold lever: `ready-for-agent` appearing flips
held -> queued and the item is schedulable in the same `applySnapshot`; losing it
un-admits the item **only if it has not started**.

`src/watch/pollDriver.ts` is the thin driver around it: `new WatchLoop({ fetchSnapshot,
engine, intervalMs, sleep?, stopWhen?, onInvalidSnapshot? })` re-fetches ->
`loadRunModel` -> `engine.applySnapshot` on each `tick()`, and `run()` repeats until
`stop()` or until `stopWhen()` says the run is over. The interval and the sleep are
injected, so tests call `tick()` directly and the engine itself owns no timers, clock,
or randomness.

## When the run stops

The CLI passes `stopWhen: () => engine.complete()`. `Engine.complete()` is true only
once **every** item is done (or has dropped out of the run model). Parked, held and
blocked items do **not** end the run: the way out of them is a label flip a human makes
on GitHub, and the poll loop is the only thing that would ever see it, so exiting while
any item still waits on a human makes that protocol unreachable exactly when it is
needed.

`src/real/startRealRun.ts` is the one composition both real entry points use: the CLI
(`src/cli/run.ts`, a console front-end over it) and the control plane's real session.
It owns every preflight, the lock (released when the poll loop ends **and** on process
exit, so a crashed run never leaves a stale one), the startup GC, the adapters, the
engine and the watch loop; the callers differ only in where the log lines and the
warnings go.

`Engine.stalled()` is the second half of that seam: it returns `{ parked, held, blocked }`
when nothing can advance on its own and `undefined` otherwise (work in flight, or the
run complete). The CLI prints it once per poll (the parked, held and blocked counts and that it is
waiting for label flips), so a stalled run is never a silent one. `Ctrl+C` stops after
the poll in flight (again forces); the end-of-run epilogue (`src/cli/report.ts`) then
prints every item's final phase and names the ones that never reached done. The lock is
released as soon as the poll loop ends, just before the epilogue prints.

There is deliberately no end-of-run conflict probe. Rebase-at-the-gate plus serialized
squash merges makes cross-slice conflicts surface per item, at the gate, as a park with
the conflicting files, and every done item's branch is deleted by the merge, so a
run-level replay has nothing left to replay. Verifying the assembled integration branch
is Feature Verify's job.

## Preflight

`runPreflight` (`src/real/preflight.ts`) runs **before the lock is taken** and reports
every check as a line instead of dying on the first failure:

```
[preflight] ok   claude home: synced projects/…/memory, skills, commands, .credentials.json from ~/.claude
[preflight] ok   docker: daemon reachable, image sandcastle:latest present
[preflight] ok   gh auth (host) / GH_TOKEN (containers)
[preflight] FAIL repo checkouts: no git checkout at /work/api ... check repos.api.path in .sandcastle/config.json
[preflight] ok   integration base / sandbox env files / load-bearing memories / agent skills
[preflight] ok   agent auth: a throwaway container answered opus over the mounted credentials
```

`sandcastle preflight <parent>` runs the same checks without starting anything. Three
properties it guarantees:

- **The layout does not live in the shell.** `SANDCASTLE_WORKSPACE_ROOT`,
  `SANDCASTLE_WORKTREE_DIR`, `SANDCASTLE_CLAUDE_HOME` and `SANDCASTLE_MEMORY_DIR` are read
  from `.sandcastle/.env.orchestrator` (and the shared `.env.orchestrator` in the clone) as well as the process env, so
  `nohup … bash -c` (which never sources `~/.bashrc`) starts the same run an interactive
  shell does.
- **No hand-copied `~/.claude`.** Set `SANDCASTLE_CLAUDE_SOURCE` (e.g. the `.claude`
  folder of a Windows user profile when running under WSL) and every start copies the
  memories, skills, commands and `.credentials.json` into the home the containers hydrate
  from; `sandcastle sync-claude` does it on demand.
- **Dead credentials surface before the first stage.** The auth check runs `claude -p` in
  a throwaway container with the same home hydration a stage gets, so an expired OAuth
  session fails the start instead of parking items one by one, minutes later.

A preflight failure releases nothing because it holds nothing; any failure **after** the
lock releases it, so a failed start never leaves the next one refused by its own pid.

## Waiting: usage windows and dead credentials

A stage killed by the five-hour cap or by rejected credentials is **not** a park. The
last line of `claude -p`'s stream-json is parsed (`src/real/agentFailure.ts`): a
`rate_limit_event` carries `resetsAt`, an auth failure carries its message, and either
one puts the item in the `waiting` phase: stage label frozen, no `sc:needs-human`, no
comment, no human. New starts are held at the same moment, so the rest of the queue does
not spawn containers into a dead window.

- **rate limit**: the watch loop's clock resumes every waiting item, at its own stage
  cursor, once `resetsAt` passes.
- **auth**: the run re-probes the credentials and resumes itself when they work again (a
  `sync-claude` on the host is enough; no restart). The probe backs off 1 -> 2 -> 5 -> 10
  minutes while they stay rejected, so an overnight expiry does not spend a container and
  an agent call on every poll.
- **transient**: a network, GitHub or Claude API outage (`src/engine/transient.ts`:
  `ConnectionRefused`, `ECONNRESET`, `Could not resolve host`, HTTP 502/503/504, …) seen in
  the agent stream, in bootstrap (`npm ci`) output, or when branch creation or the
  pre-stage rebase fails. It holds only that item, which re-runs the same stage after
  2 -> 5 -> 10 -> 20 -> 30 minutes and parks with the original reason after the fifth retry. A
  successful stage gives the item a fresh budget. Check output is never scanned, so a test
  that prints `ECONNREFUSED` stays red. Preflight also runs `curl -4` to api.anthropic.com
  and api.github.com from inside the image: a host that still works over IPv6 hides a
  blocked IPv4 path, and containers may only have the latter.

The ui shows the countdown on the card and a header chip for as long as the whole run is
held. `retry` on a waiting item resumes it **and releases the hold for every other item**,
and the feed says so when it happens.

Everything else (red checks, conflicts, `UNFIXABLE`, unknown failures) still parks.
Park comments carry the **last** stream event rather than the start of the `init` event,
so a park reads as its actual cause instead of "init then exit 1".

## Conflicts

A sibling item merging into the integration branch while this one is in flight would
otherwise be a park at the gate, the one point in the pipeline with no agent attached.
Instead:

- **Every agent stage starts with a rebase** onto `origin/integration/<feature>` (develop's
  branch creation already did). Clean is the common case and costs a fetch + force-push.
- **A conflict is handed to that stage's agent**, not to a human: sandcastle aborts its own
  rebase, leaves the worktree clean, and the prompt opens with a `## Rebase conflict` section
  naming the files. The agent rebases, resolves, greens the tests, force-pushes, and only then
  starts its own stage contract.
- **A conflict that still reaches the gate** (a sibling that merged after the last stage
  started) gets one constrained **resolve** pass: a fresh container on the salvage idle
  budget, told to resolve and nothing else. The orchestrator then re-runs the gate itself.
  It parks only if the resolve pass left the branch off `origin/integration/<feature>`, and
  the park comment carries the conflicting files.
- The develop prompt tells agents that siblings are running in parallel and to grep the
  integration branch for an existing type/enum/helper before minting their own. The most
  common conflict is two siblings adding the same thing.

## The rework loop

Two failures send an item back to develop instead of parking it:

- **red checks at the verify gate** (`CheckFailure`): the orchestrator writes the brief itself, covering what happened, why it matters, the branch's commits, the last 3000 characters of check output, and what a fix must achieve;
- **review `NEEDS-REWORK:`**: the review agent writes the same story shape under its section. `UNFIXABLE:` still parks.

The engine bumps the item's round, keeps every brief, comments the new one on the hub sub-issue and puts the item back at develop (`awaiting`, so drain-first still applies). Before the round's develop starts, the runner appends the brief to the pull request (`<!-- sandcastle:rework=N -->`, idempotent) and counts the commits already ahead, so settlement can tell this round's work from earlier rounds'. The rework develop prompt carries every brief, oldest first, with the current one marked; it reproduces each problem as a failing test first, fixes the cause, commits `fix(rework):` and appends `## Rework N - fix` (`<!-- sandcastle:develop rework=N -->`). The round's simplify and review get the same history and write `<!-- sandcastle:<stage> rework=N -->` sections; the first pass keeps its original sentinels byte for byte.

After `SANDCASTLE_REWORK_LIMIT` rounds (default 3; `0` turns the loop off), the next failure parks with every round's brief in the comment; a human retry of that park grants one more round. Resume reads the round and briefs from the pull-request body, and a round whose develop section is missing resumes at develop, never at the first pass's audited stage. The card shows a `rework N/L` badge.

## Park and resume

A failed stage parks the item: `sc:needs-human` added **alongside** the frozen stage
label, `ready-for-agent` -> `ready-for-human`, plus a comment saying why, with the
failure's own output (red check tail, `UNFIXABLE:` reason, or the conflicting files
from a rebase that hit a merge conflict at the gate) fenced underneath it. The human
protocol is one label flip back: the next snapshot showing `ready-for-agent` removes
`sc:needs-human` and re-enters the item **at the stage it died at** (it competes as an
awaiting item at its stage cursor under drain-first), never from scratch, and never
re-creating its branch. A parked item closed by hand counts as done and unblocks its
dependents.

**No per-item operation may throw past its own item.** Everything `fillSlots()` can
reach (`createItemBranch`, `spawnStage`, `rebaseOntoIntegration`, `runChecks`, and the
hub writes `park` itself makes) is guarded, and a failure parks that one item and frees
its slot so the loop carries on with the next candidate. Without that guard, a single
`git worktree add` failure escaping `startAgentStage` would unwind out of `fillSlots` and
take every other unblocked item down with it.

The stage label is mirrored **before** the branch is created, not after, so that even a
park at the very first instant of `develop` leaves the `sc:developing` + `sc:needs-human`
pair the resume table below is written against. Parking straight out of `sc:queued` would
produce a label pair `resumePlacement` rejects, and it throws rather than skips, so one
such item would take the whole resume with it.

`Engine.resume(model, adapters, evidence, options)` rebuilds a run mid-flight after a
crash from the labels + git evidence alone. `ResumeEvidence` is
`{ itemNumber, stageLabels, branchExists, pullRequestExists, pullRequestMerged }`:

| evidence | placement |
|---|---|
| issue closed | done |
| `pullRequestMerged` | done: the shape every merged item has, since the squash merge deletes the branch |
| pull request, no branch, not merged | parked with a comment: sandcastle will not re-run a stage on a branch that is gone |
| `sc:done` | done |
| `sc:queued` / `sc:blocked` | recomputed from the live dependency graph |
| `sc:developing` / `sc:simplifying` / `sc:in-review` | re-runs that stage (stages are re-runnable) |
| `sc:verifying` | re-runs the verify gate. The gate has its own label, so a park there resumes at the gate instead of replaying develop -> simplify -> review on already-reviewed code |
| frozen stage label **+** `sc:needs-human` | parked, or resumed at that stage if admission is already back to `ready-for-agent` |

Contradictory evidence fails fast: `sc:needs-human` without a frozen stage label, two
stage labels at once, or evidence for an item that is not in the run model.

## Running for real

`sandcastle start <parent-issue>` wires the real adapters to the same
engine the dry run drives: snapshot -> `loadRunModel` -> `Engine.start()` -> `WatchLoop`.
Every stage transition the engine decides becomes a real branch, container, and `sc:*`
label. `--dry-run` still short-circuits to the fake adapters and writes nothing.

Startup refuses to continue unless all of these hold (fail fast, never half-configured):

1. the agent skills are installed on the host: `~/.claude/skills/simplify`,
   `~/.claude/skills/mat-review` and `~/.claude/skills/tdd` (each with its `SKILL.md`),
   which the develop, simplify and review agents read from the mounted home, plus
   `~/.claude/commands/polish.md` and `~/.claude/commands/review.md` for the polish stage.
   Skills ship in this repo and `sandcastle skills install --check` (run by preflight) reports any missing or outdated file with the fix; see README, Agent skills. The check
   resolves `~` through node's `os.homedir()` (i.e. `USERPROFILE` on Windows);
2. `.sandcastle/.env.orchestrator` (or the shared `.env.orchestrator` in the clone) exists and has `GH_TOKEN`
   (`sandcastle init` creates it from `.env.orchestrator.example`);
3. every repo the run targets has a sanitized sandbox env in the state dir
   (`.env.sandbox.<repo>` or `.env.sandbox`, created by `sandcastle init`), plus, unless
   `--skip-verify` is set, every repo Feature Verify needs. Under the `compose` strategy
   that is every configured repo, whatever the run touched, so a missing env fails at
   preflight, not an hour later inside `up()`;
4. the docker daemon answers and the config's `imageTag` exists (`npm run build-image`);
5. every `load_bearing_memories` / `extra_memories` slug resolves to a file in the
   host's project memory dir (config `memoryProject`);
6. the integration base branch (`integrationBase`) exists on every targeted repo;
7. no other orchestrator holds `.orchestrator.lock`.

Then it garbage-collects orphan `sc-<project>-*` containers and any worktree under
`~/.sandcastle/worktrees/<project>/` left by a dead run. That is also what makes
crash-resume safe: stale agents are killed *before* the engine schedules anything.

### Restarting after a killed run

A `SIGKILL`'d run leaves five kinds of debris. Startup GC clears two of them
(containers/networks/volumes, worktrees) and `acquireLock` reclaims a lock whose pid is
dead. `sandcastle reset <parent>` finishes the job in one command:

- garbage-collects the containers, networks, volumes and worktrees;
- reclaims `.orchestrator.lock`, and **refuses to do anything at all** while its pid is
  still alive, because resetting under a live run would reap that run's containers;
- reverts the orchestrator's own labels on the parent's items: every `sc:*` label comes
  off, and `ready-for-human` flips back to `ready-for-agent` **only** where
  `sc:needs-human` proves sandcastle put it there; a human's own triage flip is left
  alone. Closed and `sc:done` items are never touched;
- deletes item branches that carry no commits beyond `origin/<integration>`, locally and
  on origin. A branch with commits on it is somebody's work and is kept, and so is one
  whose commits git could not count (a missing base ref, a failed `rev-list`, or empty
  output where a number was expected) all read as "keep", never as "empty". A repo with no
  checkout on this machine still gets a line in the plan saying reset could not look at
  it, rather than silently contributing nothing to a plan that then reads as clean.

It is a **dry run by default** and prints the whole plan; `--apply` is what executes it.
Branch deletion runs after GC, so no worktree is still holding a branch when
`git branch -D` reaches it.

### The three adapters

Every process this repo starts goes through one injected `CommandRunner`
(`src/real/commandRunner.ts`, execFile-shaped: sync `run` for gh/git, streaming
`start` for containers). Nothing calls `child_process` directly, so each adapter's
command composition is unit-tested against a recording fake, with no docker daemon and no
tokens needed to test any of it.

- **GitOps** (`src/real/gitOps.ts`). Integration branch: fetch, then push
  `origin/<integrationBase>` to `integration/<feature>` if origin does not have it. Item
  branch: fetch, then `git worktree add` off the integration branch into
  `~/.sandcastle/worktrees/<project>/<repo>/<branch>`, then copy the sanitized `.env` in. A
  stale worktree is removed with `git worktree remove --force`, **never** `rm -rf`: these
  trees contain a `node_modules` junction on Windows and a recursive delete eats the
  real one. When git itself cannot remove the tree on Windows (container-created
  symlinks, paths past 260 characters), `removeWorktreeTree` falls back to
  `cmd /c rmdir /s /q \\?\<dir>`, which removes a junction without following it, then
  runs `git worktree prune`. It throws if the folder is still there afterwards. Before
  every rebase onto the integration branch, uncommitted leftovers from a killed stage are
  saved to `.sandcastle/logs/leftovers/<repo>-<worktree>-<ms>.patch` and discarded
  (`reset --hard` + `clean -fd`), so a dirty tree does not park the next stage. Which
  start point the worktree takes is decided by `itemBranchWorktreeArgs`, and all three
  arms matter for restarts: the branch on origin resets to `origin/<branch>`; a
  **local-only** branch (what a run killed before its first push leaves behind) resets
  to *itself*, so the killed run's commits survive the restart; only a branch that exists
  nowhere is created fresh off the integration branch. Plain `-b` on an existing local
  branch is a hard git error, which is why the three arms are split out. The verify gate
  rebases onto the integration branch and re-pushes the item branch with
  `--force-with-lease` so what GitHub merges is what the checks ran on.
- **SandboxRunner** (`src/real/sandboxRunner.ts`): one container per stage
  (`sc-<project>-<stage>-<item>-<stamp>`), removed in a `finally`. The worktree mounts
  at `/home/agent/workspace` and the repo's `.git` at `/home/agent/gitdir`, with
  `GIT_DIR`/`GIT_WORK_TREE` pointing git at the mounted admin dir. That is what makes
  a Windows-host worktree usable from Linux without rewriting the host's `.git` file.
  `GIT_DIR` comes from `git rev-parse --absolute-git-dir` run in the worktree, never
  from its basename: git appends a numeric suffix when two worktrees want the same
  admin dir name. The agent runs as `claude -p --output-format stream-json` with the
  prompt on stdin; streaming json is load-bearing, because idle detection watches
  output and plain text mode is silent until the very end.
- **GhClient** (`src/real/ghClient.ts`): `gh` CLI. `setStageLabel` reads the issue's
  labels and removes the other `sc:*` ones in the same edit that adds the target, so
  the mirror is always exactly one stage label. Label writes warn instead of throwing
  (a rate-limited mirror write must not kill a live run); comment, merge and close
  throw: the park comment is how a human learns *why* an item stopped, so losing it
  silently is not acceptable. Merge targets the **service** repo (`repos.<name>.github`;
  pull requests live there, which is the hub only in single-repo mode): `gh pr ready`,
  then `gh pr merge --squash --subject "<pr title>" --delete-branch`, and it hands the
  merged URL back. `closeIssue` takes that URL, comments it on the hub sub-issue and only
  then closes. When hub and service repo differ the reference is cross-repo, so GitHub
  will not auto-close; the parent issue is never touched. The engine splits that path's
  failures, because they mean opposite things: a `mergePullRequest` throw means the merge
  did **not** happen, so the item parks with the error as its park detail; a throw from
  the comment-and-close *after* a successful merge means the work is already integrated,
  so the item is marked done and the operator gets a loud warn naming the merged pull
  request and the sub-issue to close by hand. Neither leaves the item `running` forever.
  A pull request whose `body` or `title` comes back as anything other than a string is
  a hard error rather than an empty body: a completed stage must never read as an
  incomplete one. `appendToPullRequestBody` is the orchestrator's own append: it edits
  from the body it just read, never from a file it did not write.

### Sandbox hardening

The agent runs with `--dangerously-skip-permissions`, so the container is the only
boundary that exists:

- **The host `~/.claude` is never writable.** `~/.claude` and `~/.claude.json` mount
  **read-only** at `/home/agent/.claude-host{,.json}`; container start copies them into
  a container-local `~/.claude`, so session state and history die with the container
  and a compromised agent cannot rewrite the host's skills, settings, or credentials.
  The copy is an **allow-list** `tar`-to-`tar` pipe, not a blanket `cp -a`:
  `HYDRATE_COPIED_ENTRIES` names the entries a sandboxed agent actually reads
  (`CLAUDE.md`, `settings.json`, `settings.local.json`, `.credentials.json`, `agents/`,
  `commands/`, `hooks/` and `skills/`), and everything else stays on the host. An entry
  the host does not have costs nothing: `--ignore-failed-read` downgrades the missing
  file to a warning and tar still exits 0, which is what keeps `set -o pipefail` from
  failing the hydrate on a machine with no `settings.local.json`. An allow-list rather
  than a deny-list because the host home keeps growing: session transcripts (`projects/`,
  `todos/`, `sessions/`), `history.jsonl`, `jobs/`, `telemetry/` and plugin marketplace
  clones are all useless to the agent, and each new one would otherwise ride into
  *every* stage, salvage and verify container by default, typically ~1 MB instead of
  tens of MB. Hydration ends by asserting the fresh-eyes skill files actually landed, so
  a wrong allow-list fails the stage instead of quietly starving the review agent.
- **Containers match the host's line endings.** Hydration sets
  `git config --global core.autocrlf true` in the container. The worktree is a Windows
  checkout with CRLF on disk; without it a container opens on a "modified" tree it never
  touched, and agent commits churn line endings.
- **Secrets never reach the argv.** `GH_TOKEN` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` go in through
  `docker run --env-file`, a 0600 temp file (with its temp directory) deleted right
  after the container starts, not `-e K=V`, which is readable in host `ps` and
  `docker inspect`. `CommandFailure` also redacts `KEY=value` argv entries defensively,
  so a failing command's message cannot leak one.
- **An idle-killed agent dies with its container.** Killing the `docker exec` client
  leaves the `claude` process running inside; on idle timeout the container is
  `docker rm -f`'d and the salvage pass runs in a **fresh** one, so a zombie agent and
  the salvage agent can never write the same worktree at once.
- **Garbage collection is name-scoped.** Startup GC removes only containers matching
  this project's own naming scheme (`sc-<project>-<stage>-<item>-<stamp>`, networks
  `sc-<project>-net-...`, volumes `sc-<project>-vol-...`), never by image, which would reap
  a concurrent `sandcastle smoke` container (named `scsmoke-*`, deliberately outside the
  collected prefix) or another project's run.

### Idle timeout and the salvage pass

Each agent gets an idle budget (`--idle-timeout=N` or `SANDCASTLE_IDLE_TIMEOUT`, default 1200s, clamped to
[60, 7200]) measured from its last output, not from launch. Silence is counted on a
15s tick. A tick that arrives more than four ticks late means the host was asleep, and
it counts as one tick, so waking a machine up does not kill a stage that was fine when it
went to sleep. On timeout the container is killed and `AgentIdleTimeoutError` is raised,
then the develop stage looks at what actually landed:

| state at timeout | what happens |
|---|---|
| 0 commits on the branch | stage fails, item parks; nothing to salvage |
| commits + a pull request already open | treated as done; the agent only stalled after finishing |
| commits, no pull request | **salvage pass**: one constrained second agent, in a fresh container (`min(idle, 300)s` budget), that may only make the branch green and open the draft PR. No new features, no scope change, no amending |

Every stage has its own salvage contract, and the fresh-eyes stages read a different
state at timeout: no pull request at all is unsalvageable, a pull request already
carrying the stage's completion marker counts as done, and anything in between runs a
salvage pass that only lands half-applied edits and appends the stage section. A
salvage pass that also times out is not retried. If the develop agent leaves commits
but never opens the PR and salvage cannot either, the orchestrator pushes the branch
and opens the draft PR itself, so the work is never stranded.

### The fresh-eyes stages and their completion markers

Simplify (`simplify` skill, `refactor(simplify):` commits) and review (`mat-review`
skill, `fix(review):` commits) each run as a fresh agent on the branch the develop
stage opened, apply their findings as commits, and then **append** a section to the
pull-request body. A stage is complete when its HTML-comment sentinel
(`<!-- sandcastle:simplify -->` / `<!-- sandcastle:review -->`, written directly above
the human-readable `## Simplify` / `## Review` heading) is present in the body. The
sentinel, not the heading, is what settlement matches: agent-authored prose and code
fences quote `## Review` all the time, and a heading would false-positive on them.

Two more things ride on that section:

- **`UNFIXABLE: <reason>`** inside it is the explicit "cannot be fixed in place"
  signal. Settlement fails the stage and carries the agent's reason into the error, so
  the item parks with a human-readable why rather than a silent half-fix.
- **Commits but no section**: the stage did the work and died before recording it.
  The orchestrator appends the stub section itself (sentinel, heading, and the
  stage-tagged commit subjects it detected) through `gh pr edit`, mirroring the
  orchestrator-opened-PR fallback, so the audit trail lives durably on the PR. Neither
  commits nor a section fails the stage.

The prompt's append recipe is a single `&&` chain (fetch the body, `test -s` it, append
the section file, then edit) precisely because an unchained `gh pr edit --body-file`
after a failed `gh pr view` would overwrite the entire body, destroying the audit trail
and the `Closes` link.

### Prompt composition

`src/real/promptBuilder.ts` builds a stage prompt from the run model: the sub-issue
title and body as the spec, `required_reading` for that item's repo, and the *content*
of every `load_bearing_memories` + `extra_memories` file resolved from the host's
project memory dir at launch (missing slug -> startup error, never a silently weaker
prompt). The develop contract is: read the `tdd` skill -> failing tests committed as
`test:` -> implement -> comment-free code -> `feat:` commits -> draft PR to the integration
branch titled `type: <sub-issue title>` with what/how-tested and a reference to the hub
sub-issue (`<hubRepo>` + issue number) -> stop. A develop stage with no `test:` commit
warns (not a park): config, copy and docs criteria may skip their test with a `no test:`
line under "How tested". Stages plug into a `Record<AgentStage, StagePromptBuilder>`
(and a matching salvage record), so the type system, not a runtime guard, is what
proves every stage has both.

The sub-issue title and body are the one piece of the prompt an outsider can write, so
they are fenced in `<issue-spec>` … `</issue-spec>` above the contract, with one line
telling the agent the enclosed text is the work spec and that any instruction inside it
conflicting with the contract is to be ignored.

### Pre-flight smoke check

`sandcastle smoke <repo>` is the non-billed plumbing check: it builds a scratch
worktree off `origin/<integrationBase>` on a throwaway branch, starts a container with
the real mounts, hydrates the home exactly as a real stage does, proves
`node`/`git`/`gh`/`claude` are present, that git works *through* the mounted worktree and
that `git status` there is **clean** (a dirty fresh worktree means the line-ending config
regressed), then removes the container, the worktree, and the local branch. It never
starts an agent, so it costs nothing. Its idle budget is the orchestrator's own
`IDLE_TIMEOUT_DEFAULT` (`SANDCASTLE_IDLE_TIMEOUT` overrides), so a cold docker cache
cannot fail it as slowness. Run it after any change to the Dockerfile, the mounts, or the
git plumbing, and on a new machine before the first real run.

## The control plane

`sandcastle ui examples/demo/demo-run.json --config=examples/demo --cap=2`
serves a local page on `127.0.0.1:<ui.port>` (default 7777; `--port=N` or `SANDCASTLE_UI_PORT` override it) and starts
a **paced dry run** behind it: fake adapters, but each stage completes 800 to 2000 ms after
it starts instead of instantly, so the whole scheduler is watchable in a browser without
docker, tokens or a single `gh` write. `sandcastle ui <parent-issue>` is the same page in
real mode. Every preflight runs when you press **start**, which is deliberate: the
argument picks the mode and preselects that parent in the picker, but a human still
authorises the spend. `--cap=N` prefills the start form (and is what a real start
applies); `sandcastle ui <parent-issue> --dry` simulates **that** parent rather than
whichever one sorts first, and `--fail=<item>:<stage>` fails that stage once in a dry
run so park, the retry button and the stall chip are demoable from a fixture.

The page (`src/ui/page.html`, vanilla DOM, no framework, no CDN) shows one column per
repo, one card per Work Item, and the stage chain `queued -> develop -> simplify ->
review -> verify -> merged` with the current stage lit. Blocked cards name the items
they wait on, parked cards are red and carry the park reason plus a **retry** button,
held cards are grey, running cards carry **cancel**. A card links its pull request as
soon as the develop stage reports one, so a parked or awaiting item is one click from
the work in flight, not only merged ones. The header holds the cap control, the pause
toggle, the worker/phase counters and a stall chip; a feed underneath (collapsed by
default, open state remembered per browser) collects warnings, stalls and operator notes,
and every failed command raises a transient error banner above the board (the start
button hides itself once a run is in flight, so an error parked inside it would be
invisible exactly when it matters).

### The reset button

The header carries a **reset...** button: `sandcastle reset` without leaving the browser, for
clearing what a killed run left behind. It is deliberately narrow:

- **Real mode only, and only when no run is in flight.** The button reads `canReset` off
  the state and disables itself otherwise, with the reason in its tooltip; the server
  refuses independently with a 409, because a disabled button is not a boundary. Resetting
  under a live run would garbage-collect that run's own containers, and the orchestrator
  holds `.orchestrator.lock` while it runs, so `planReset` would refuse anyway. Stop the
  run first.
- **Two clicks, never one.** The first click posts a plan and renders it: orphans, the
  lock, the label edits, and every branch marked `DELETE` or `keep` with the verdict that
  decided it. Nothing has changed at that point. Only **apply** writes.
- **Apply re-plans on the server.** It does not trust the plan the browser is holding. The
  `ResetOps.apply` signature takes a parent number and nothing else, so passing the browser's
  copy is not expressible. A stale panel left open on a second monitor cannot delete a branch
  that has since grown commits. The panel applies to the parent its plan was *read* for, not
  to whatever the picker holds by the time apply is clicked.
- **The door stays shut while it works.** A reset in flight sets `resetting`, which refuses a
  run start and a second reset with a 409. The plan/apply pair spans two awaits, and without
  the flag a run slipped into that gap would have its containers collected out from under it.

What it did lands in the run feed like any other operator action, failures included, the gc's
own failures among them. **The control plane cannot answer while an apply runs:** the reset
path is `execFileSync` throughout (`git fetch`, `gh issue edit`, `git push --delete`), so it
holds the event loop. The feed says so before it starts. Making it non-blocking needs either an
async `CommandRunner` or a child process, and neither is worth it for an operation that is
already exclusive.

**The board shows only what is still moving.** Anything but `done` is
active and always drawn, parked and held included, because those are the two states
waiting on a human, and a phase the page has never heard of is drawn as an active card
labelled `(unknown)` rather than dropped, since a card that disappears from a column
while it still counts in that column's denominator is the one failure the board must
never have. Each repo column collapses its finished cards behind an `N done ▸` chip you
click to expand. The chip is per column, not global: the count sits next to the
column header (`3/8 done`) it belongs to, and one repo can be opened without flooding the
other. That header count is computed from **all** the column's items, so the filter
never moves it, and a column with nothing active says `no active items` with its done count rather
than going blank. The line drops away once the chip is expanded, where the cards say it
themselves. The parent picker groups the open parents by the sub-issue counts
`GET /api/parents` already returns: **ready to merge** (every sub-issue closed, so its
`integration/*` -> `<integrationBase>` PR is the thing waiting on you) pinned at the top
with a `N waiting for your merge` badge, then **working** (some closed), then **todo**
(none closed). A search box filters them by number or title. The search never
re-points the pick: the picked parent stays on offer whatever the query hides (the hidden
ones are counted in the list), the pick itself only ever changes when the operator
changes it, and **start** spends tokens on that pick rather than on whatever the DOM
happens to show. The picker is not a one-shot load either: it re-reads `/api/parents`
whenever the startbar comes back, which is exactly when a run has completed and the
counts and the merge badge have moved, and every 60 s while the startbar is up; it stays
quiet while a run is in flight, when the picker is hidden anyway. The pick, the query and
the expand choices live in the page's module scope, never in the DOM the renderer
replaces, so neither an SSE `state` event nor a parent refresh reopens a section the
operator collapsed, discards what they were typing, or moves what start will run.

`src/ui/server.ts` is Express + SSE: `GET /` (page), `GET /api/state` (full
projection), `GET /api/events` (a `state` event whenever the projection actually
changes, plus `feed` lines), `GET /api/parents` (open `sandcastle`-labelled hub issues
via `gh`), `POST /api/run`, `/api/items/:n/cancel`, `/api/items/:n/retry`,
`/api/pause`, `/api/resume`, `/api/cap`, `/api/reset`. Bad input is a 400; a command the
run cannot honour is a 409 carrying the engine's own `OperatorError` message (for
example, that only a running item can be cancelled); anything else (a `gh`
outage, a bug) is a 500, because dressing an unexpected failure as a conflict hides it.

The page is local, but "local" is not a boundary on its own: any page in the browser
can POST to `127.0.0.1`. So every POST must carry `x-sandcastle: 1`, a header a
cross-origin simple request cannot set without a preflight the server never answers,
and every request's `Host` must be a loopback name. Anything else is a 403. Starting a
run is guarded on the server too: the in-flight marker is set **synchronously** before
the snapshot fetch, so two `POST /api/run` racing each other can never build two
engines (and two container fleets) for one parent. The second gets a 409 whether the
first is still starting or already running. One SSE subscriber throwing never aborts
delivery to the rest, or turns a command that already succeeded into a 409: each
subscriber is written to inside its own `try`, and a dead one is dropped.

The engine exposes four operator levers, and they keep GitHub the mirror:

| lever | semantics |
|---|---|
| `cancelItem(n)` | running only; kills that stage's container (`SandboxRunner.kill`, `docker rm -f` by tracked name) and parks the item: `sc:needs-human`, `ready-for-agent` -> `ready-for-human`, park comment "cancelled by operator". The freed slot is handed on immediately. |
| cancel identity | a cancel targets the **attempt**, never the item: every launch takes a fresh attempt token, and the container, the kill, the removal and the dropped completion all key off it. A cancel landing between two containers (the salvage gap) marks the attempt, so the next container is never started rather than running on above the cap; a retried attempt's completion is its own, so it can never be swallowed by the earlier cancel and leave the card stuck `running`. |
| `retryItem(n)` | parked only; `ready-for-human` -> `ready-for-agent`, drops `sc:needs-human` and re-enters at the **frozen stage** through the same path a human label flip takes, never from scratch. |
| `pauseNewStarts()` / `resumeNewStarts()` | pausing stops **new** items starting; everything already in flight keeps walking its chain, and drain-first is untouched. Resuming fills the free slots at once. |
| `setWorkerCap(n)` | positive integers only; raising fills the new slots immediately, lowering takes effect as slots free (never kills a worker). |

Timers live outside the engine: `PacedDryRun` (`src/engine/pacedDryRunner.ts`) hands
each pending stage a due time, drops that due time when the stage is killed (a retried
stage must not inherit the cancelled attempt's clock and complete instantly) and
completes it on `tick()`, and the only `setInterval` in the system is the CLI's 250 ms
`controller.tick()`. Tests drive `tick()` with an injected clock, so the UI suite is as
deterministic as the engine's.

## Feature Verify

When `Engine.complete()` ends the poll loop, `startRealRun` runs the once-per-feature
Feature Verify stage, outside the engine, which never learns about it. What it does is
chosen by `verify.strategy` in the config.

### Strategies

- **`none`**: no environment. Feature Verify records a single PASS noting that only the
  per-item gates (each item's checks at the verify gate) ran, and the run proceeds to the
  integration pull requests.
- **`command`**: one throwaway container holding a fresh copy of each involved repo's
  integration branch. It runs each repo's `bootstrap`, then `verify.commands[<repo>]`
  (default: that repo's `checks`), then the verify agent against the result. With
  `verify.agent: false` no agent runs and the green commands are the report.
- **`compose`**: a throwaway docker network with one served build per repo, an optional
  local mongo, and the verify agent driving the live services. Described below.

### The compose environment

`src/real/featureVerify/composeHarness.ts` stands up a throwaway environment through the
same `CommandRunner` seam every other docker call uses: a network
(`sc-<project>-net-<parent>-<stamp>`), and, when the config asks for a database, a fresh
volume (`sc-<project>-vol-…`) and a `mongo:7` container on it; then one service per
configured repo, built from a **detached worktree** of `integration/<feature>`, each
bootstrapped and built, seeded, served detached, and polled until its health path
answers. Each service's env is templated: `{{port}}`, `{{mongoUri}}`, `{{mongoDb}}` and
`{{url:<repo>}}` (another service's in-network URL) are filled in per service. The verify
agent is one more container on that network, with read-only mounts of every source tree, a
scratch workspace, **no `GH_TOKEN`**, so it can drive the services but cannot push,
comment or merge. Every resource is registered *before* it is created and released in
reverse in `down()`, which runs in a `finally` and survives a docker refusal. A
`docker run` that fails after partially creating something is torn down by this run
rather than leaked to the next run's GC (which `--skip-gc` disables); the container names
fit the GC scheme, and the run-start GC sweeps orphan networks and volumes too.

Refs are resolved **before** anything is created, and the fallback is honest: a repo with
no work items in this run and no integration branch is composed from
`origin/<integrationBase>`, but a repo that *does* have work items and no
`integration/<feature>` on origin is a hard error: verifying an involved repo from the
base branch would mean scoring a feature the environment never contained. The ref each
service was actually built from is stated on the parent comment and in every pull
request body.

When the local mongo is in use, a remote database is unreachable by construction: the
composed env starts from the sanitized sandbox env, the mongo URI is overwritten with the
local one (`mongodb://mongo:27017/<db>`), the result is written both to the container's
`--env-file` and (0600) over the worktree's `.env` (so `dotenv` cannot re-introduce
anything), and `assertLocalMongoOnly` refuses to compose at all if **any** value in
**any** key still holds a `mongodb://` or `mongodb+srv://` URI whose host is not the local
`mongo` alias. The check is host-agnostic, and `localhost` counts as foreign because inside a
container it is not the compose mongo.

Provider credentials are a different problem and get a different control: keys matching
`/TOKEN|SECRET|KEY|PASSWORD/` are **not** stripped: a service may need them to boot,
and silently emptying them would produce mysterious boot failures. Instead, every run
logs the credential-shaped keys that survive into the compose env, per service. The
sanitized `.env.sandbox.<repo>` contract is the control; the warn line is the visibility
that makes a breach of that contract noticeable.

### The verify agent and its report

The agent's prompt (`buildFeatureVerifyPrompt`) carries the parent spec and every
sub-issue's acceptance criteria inside one `<issue-spec>` fence, the live service URLs
(compose) or the command results (command), and the report contract. Scenarios that
depend on a third-party provider listed in `verify.externalProviders` are `REQUIRES-STG`
and must never be faked green. The report is a file (`/home/agent/workspace/report.md`),
not parsed stdout.

The verdict grammar is deliberately permissive about shape and strict about meaning. A
scenario line is any bullet whose **leading token** is a verdict followed by a separator
(an em dash, `-`, `:`, `|`, or end of line), through bold/backtick/underscore decoration and in
any case: `PASS`/`PASSED`, `FAIL`/`FAILED`, `REQUIRES-STG` (`REQUIRES_STG`, `STG-ONLY`,
`REQUIRES-STAGING`). A bullet that looks like a scenario but shouts a token sandcastle
does not recognise (`- SKIPPED: ...`) counts as **FAIL**, the one direction a parser bug
is allowed to err in. Prose that merely contains a verdict word is not a scenario line.

The verdict itself is fail-safe: **green** only when the report exists, at least one
scenario **passed**, and **zero** failed. No report, no scenario lines, a failed
environment, a dead agent, or an all-`REQUIRES-STG` report ("no automated scenario
passed") are all **red**: a run that proved nothing never opens a pull request. Green
opens one `integration/<feature>` -> `<integrationBase>` pull request per involved repo
(`feat: <feature>`, the refs it was built from, the report itself in a bounded fenced
block, the requires-STG checklist and a note that a human merges it) and reuses an
existing one only if it is **open and on the right base**. Red with FAIL scenarios goes
to a fix round (below) while rounds remain. Any other red, and the red after the last
round, opens nothing, posts the report, and parks the **parent** with `sc:needs-human` +
`ready-for-human`, the same park labels the engine uses (no swap; the parent never
carries `ready-for-agent`); green clears both, in case a previous red run left them.
Per-item labels are never touched. Either way the plan and results are a comment on the
parent issue, and the phase (idle -> running -> green/red, plus `skipped`) shows in the UI
header, the SSE state and the CLI epilogue. `--skip-verify` exists for tooling and
bootstrap runs and says loudly what it skipped.

### Known edges

- On Docker Desktop the worktree reaches the container over a 9p/drvfs bind mount, which
  can be an order of magnitude slower than container-local disk for a large jest suite.
  So agent stages keep `node_modules` and `.jest-cache` on anonymous container volumes
  over the bind mount (they never land on the host worktree, and `docker rm -v` drops
  them with the container). The verify gate goes further: it mounts the worktree
  read-only at `/home/agent/source`, copies it into the container's own disk and runs
  bootstrap and checks there. On a large suite this took `npm ci` from ~10 min to
  ~1.5 min and a full tsc + jest run from hours to minutes. Every container gets
  `JEST_MAX_WORKERS` from `SANDCASTLE_JEST_WORKERS` (default 4; more workers than that
  barely helped).
- Playwright is pinned in the image (`ARG PLAYWRIGHT_VERSION`) so an image rebuild cannot
  silently change what the verify agent drives a browser with. `NODE_PATH` only
  resolves CommonJS, so a bare ESM `import "playwright"` would fail even though
  `require("playwright")` works; the image also links
  `/home/agent/node_modules/playwright`, which is on the ESM lookup path from the
  workspace, and the prompt tells the agent to write `.cjs` + `require` regardless.
- The compose network is a normal bridge network, so the composed services still have
  egress: bootstrap and build need the registry, and installs happen after the
  containers are attached. The controls on what they can reach are the sanitized env and
  (with mongo) `assertLocalMongoOnly`, not the network. Making the runtime network
  `--internal` would mean installing and building before attaching. That is worth doing if
  egress ever has to be proven closed, but it is not closed today.
- The verify gate runs each repo's configured `checks` (e.g. typecheck + tests for an
  `api` repo, build + lint for a `web` repo). It keeps the last 4000 characters of check
  output on the thrown `CheckFailure`; that text (like an `UNFIXABLE:` settlement
  reason) rides the stage completion's `detail` into the park comment
  (`src/engine/parkComment.ts`), bounded to the last 3000 characters in a fenced block.
  The fence is one backtick longer than the longest backtick run inside the detail
  (minimum four), and the 3000-character cut snaps forward to a code-point boundary, so
  neither check output full of code fences nor a truncated emoji can break the comment.
- Crash-resume is wired into every real start (`src/real/resumeEvidence.ts`). For each
  open item it reads the `sc:*` labels, whether the branch is on origin, and the open PR.
  The PR audit trail is the floor: a PR with a review section resumes at verify, a
  simplify section at review, a bare PR at simplify. So a label that a GitHub outage left
  stale (still `sc:developing` on an item whose PR is already reviewed) does not send a
  finished item back to develop. Labels that contradict each other are dropped with a
  warning in favour of the PR. An item a human has not admitted is never started. Startup
  GC removes every managed worktree, so the engine re-attaches one to the existing branch
  before the first stage it runs in this process, whichever stage that is. Label writes
  that fail are queued per item and replayed on every poll, in order, until GitHub
  answers.
- `sandcastle launch` starts `scripts/supervise.ts`, not the ui directly. The supervisor runs the
  ui and logs how it died when it exits non-zero or on a signal, so a ui that vanishes
  never leaves an empty log. It restarts the ui after 10s -> 30s -> 1m -> 2m -> 5m and POSTs
  `/api/run` again, so the run resumes from the evidence above. After 6 restarts within an
  hour it gives up. A clean exit (Ctrl-C, SIGTERM) ends supervision.

## Feature Verify fix rounds

`src/real/featureVerify/featureRework.ts` wraps Feature Verify in a loop. A red report
with FAIL scenarios, from an environment that came up, becomes a **brief**
(`featureBrief.ts`: what happened, the failing lines, why it matters, the report as
evidence, what a fix must achieve) appended to the red comment on the parent behind
`<!-- sandcastle:feature-rework=N -->`. One fix agent per involved repo (develop model,
`tdd` skill, `sc-<project>-fvfix-<parent>-…` containers) then works on the integration
branch with every brief so far. Each lands through the same path as polish: local
commits, leftovers discarded, the repo's `checks` in copy mode, fast-forward push only on
green. The round's result is a `<!-- sandcastle:feature-fix=N -->` comment, and Feature
Verify runs again.

`SANDCASTLE_FEATURE_REWORK_LIMIT` (default 3, 0 = park at once) caps the rounds. The
parent parks on the red run after the last round, on a round that landed nothing, and on
any red that is not FAIL scenarios (REQUIRES-STG only, no report, broken environment).
Park comments carry `<!-- sandcastle:feature-parked -->`; on start the loop counts the
briefs posted since the last park, so a crashed run continues its count and a human
re-run of a parked parent starts a fresh budget; a parent whose comments cannot be read
parks rather than restart the count. The chip reads "fixing · fix round N/L" while a
round runs, and `sandcastle finish` refuses until it settles.

## Polish

A green Feature Verify hands over to `src/real/polish/runPolish.ts`. For each open
`integration/<feature>` -> `<integrationBase>` pull request, in parallel,
`DockerIntegrationHarness` (`src/real/integrationHarness.ts`) checks out the integration
branch, pins its head, and runs one agent (review model) in a bind-mounted
`sc-<project>-polish-<parent>-…` container. The agent runs the global `/polish` command
as written against `origin/<integrationBase>` and commits locally; it must not push.
`commands/polish.md` and `commands/review.md` come from the hydrated agent home (see
README, Agent skills).

Then the orchestrator re-runs the repo's `checks` in a copy-mode container. Green pushes
the polish commits as a fast-forward. Red checks, a dead agent or a rejected push drop
them with the worktree, so the pull request keeps exactly what Feature Verify tested. A
comment with the last check output goes on the pull request. Polish never parks.

Every outcome appends `<!-- sandcastle:polish -->` + `## Polish` to the pull-request body:
the pushed commits and checks, "no changes", or why it was reverted. The review stage's
deferred list, written by the agent to `.sandcastle-polish-notes.md` (read and deleted
before the checks), goes in that section too. A body that already carries the sentinel is
skipped, so a resumed run does not polish twice. The phase (idle -> running ->
green/reverted, plus `skipped`) shows next to the Feature Verify chip, in `sandcastle status`,
in `sandcastle finish` (which refuses while polish runs; retry) and in the CLI epilogue. Agent
and check output land in the parent's attempt logs as `polish`.

## Parallel parents

One `sandcastle ui` control plane runs several parents. The first parent to start boots it
(config, `.orchestrator.lock`, GC once over every repo); later parents share it; the last
one to settle releases the lock.

| queue mode | the next queued parent starts when |
|---|---|
| `sequential` (default) | the previous parent's items are all done. Its Feature Verify, fix rounds and polish keep running beside the next parent. |
| `parallel` | fewer than `maxParallel` parents (default 2) have items in flight. |

A manual **start run** is refused the same way: in sequential mode while any parent has
items in flight, in parallel mode at `maxParallel`. Queue it instead.

**Caps.** Each parent has its own cap (the start bar's **parent cap**, or **run cap** on
its tab). The header's **global cap** limits workers across every parent and wins: a stage
starts only when both say yes, and freed slots go round-robin between parents. The header
chip reads `3/4 workers across parents`. Feature Verify, fix and polish agents are not
counted.

**Shared across parents.** A rate-limit or auth hold raised by one parent holds them all,
and one auth probe releases them all. Feature Verify runs one at a time (fixed compose
host ports): a parent whose verify round is waiting for another parent's shows the chip
`waiting`. Fix rounds and polish do not wait. A parent that starts while another is live
skips the claude-home sync in preflight, so the live parent's containers keep the home
they hydrated from.

**From the CLI.** Everything the page does has a `sandcastle` command, so no browser is needed:

```bash
sandcastle launch 120 121 122 --cap=2 --parallel=2 --global-cap=4
#   tasks in parallel inside a feature: --cap (per run)
#   features in parallel: --parallel=N or --sequential (queue mode)
#   ceiling across every feature: --global-cap
sandcastle enqueue 123 [--cap=N]          # behind the runs in flight (cap defaults to the saved parent cap)
sandcastle dequeue 123
sandcastle queue-mode parallel --max=3    # or: queue-mode sequential
sandcastle queue-resume                   # a restored or failed queue waits paused until this
sandcastle cap 3 --parent=120             # one run's cap; without --parent, the global cap
sandcastle pause|resume [--parent=N]
sandcastle stop 120
```

`launch` starts the first parent the control plane can take and queues the rest; parents
already live or queued are reported, not added twice. `sandcastle ui` takes the same
`--parallel=N`, `--sequential` and `--global-cap=N` flags; they override the saved queue
file.

**The page.** The queue panel lists queued parents with ↑ / ↓ / remove, a mode toggle,
`max parallel`, **clear**, and a `queue paused` chip with **resume queue**. Under it, one
tab per run (`running` / `settling` / `complete` / `ended`) holds that run's board, its run
cap, **pause new starts** and **stop**; the feed filters to the selected run (**all
parents** shows everything).

| route | does |
|---|---|
| `POST /api/queue {parents, cap}` | queue parents (cap = parent cap), start what the mode allows, unpause |
| `DELETE /api/queue/:parent` | drop one queued parent |
| `POST /api/queue/reorder {parents}` | new order; must list exactly the queued parents |
| `PUT /api/queue/mode {mode, maxParallel?}` | `sequential` or `parallel` |
| `POST /api/queue/resume` | unpause the queue and start what the mode allows |
| `POST /api/runs/:parent/stop` | stop that parent: no new stages, its slots return |
| `POST /api/runs/:parent/pause` / `resume` | pause or resume new starts for that parent |
| `POST /api/runs/:parent/cap {cap}` | that parent's cap |
| `POST /api/cap {value}` | the **global** cap |
| `POST /api/pause` / `resume` | every live parent at once |

**`.queue.json`.** The queue and its settings (mode, `maxParallel`, global cap, parent
cap) live in `.sandcastle/.queue.json`, written tmp + rename. A file that does not
parse is moved to `.queue.json.bad` and the queue starts empty. A restored queue loads
**paused**: resume it from the page or `POST /api/queue/resume`. A queued start that fails
goes back to the front and pauses the queue; so does a failed save of the file.

**Operating it.** `sandcastle status` gives one run's detailed view when only one run is live (or
only one exists); otherwise it prints the summary with a `note`, and `--parent=N` picks the
run. `sandcastle queue` prints the settings, the queued parents and every run. `finish --parent=N`
per parent. See [Operating a run without a human](#operating-a-run-without-a-human).

**Known limits.** Stopping a parent that waits for the verify lock does not cancel the
wait. There is no verify-lock timeout. A sibling's preflight `git fetch --prune` can
contend with a live parent's push.

## Agent transcripts

Every attempt tees its stream-json to
`.sandcastle/logs/<parent>/<item>/<stage>-<attempt>.jsonl`: the agent's own output
plus the bootstrap and check commands around it, so a misbehaving agent leaves more than
its commits and a short failure string behind.

- `GET /api/items/:n/attempts` lists `{id, stage, attempt, startedAt, endedAt, outcome, bytes}`.
- `GET /api/attempts/:id/log?from=<byte offset>` returns the next slice and whether the attempt
  is still running, so a reader can follow a live agent by polling from where it left off.
- The **transcript** button on a card opens a drawer: one tab per attempt, the stream rendered
  as a conversation (assistant text, `→ tool: first line of input`, `← result`, the closing
  `result` event with turns and cost), a raw-json toggle, and live follow while the stage runs.
- `reset --apply` deletes the parent's transcripts with the run's other debris.

## Loading parents, and running them back to back

`listParents` shows the `sandcastle`-labelled open issues on the hub. To point the control
plane at one it has not listed, the start bar has:

- **add orchestration issue...**: a panel taking one issue number or GitHub issue URL per
  line. `POST /api/parents` fetches each one, runs it through `loadRunModel`, and answers
  per line (`ok #120 ...`, or `FAIL <input>` with the reason); the valid ones join the parent select.
  A URL naming a repo other than the configured hub is refused without a fetch.
- **queue after**: `POST /api/queue {parents, cap}` starts the first parent if nothing is
  in flight and queues the rest. When the next one starts depends on the queue mode; see
  [Parallel parents](#parallel-parents). Queueing into a paused queue, or starting a
  parent by hand, leaves it paused. `POST /api/queue/clear` drops the queue. The start bar
  stays up mid-run (only **start run** hides), so parents can be queued (**queue next**)
  while a run is in flight.

## Operating a run without a human

The run commands (`sandcastle <command>`, also `sandcastle ops <command>`) are the operator
surface. Every one prints one JSON object and is idempotent, so an agent can drive a run from a prompt:

```bash
sandcastle preflight <parent>            # every start-time check, no lock taken
sandcastle launch <parent>... --cap=2    # starts the control plane if it is down, starts one, queues the rest
sandcastle status [--parent=N] [--items] # one run: phases, holds, waiting reasons, parks, its feed, the queue
sandcastle status --summary              # queue, global slots, one line per run, last feed lines
sandcastle queue                         # queue settings, queued parents, runs on the control plane
sandcastle logs <item> [stage]           # tail the newest recorded attempt
sandcastle resume-parked [--parent=N] [--only=<text>] # retry the parked items whose reason matches
sandcastle resolve-conflict <item>       # retry one park; the gate gets another resolve agent
sandcastle finish [--parent=N]           # assert complete, print that run's integration -> base PRs
```

`--parent=N` picks the run; `status`, `resume-parked` and `finish` may leave it out while
only one run exists or only one parent is live, and `resolve-conflict` finds the run that
owns the item. When `status` cannot pick one run it prints the summary, with a `note`
saying why.

`status` separates the two states that look alike and are not: **waiting** items need
nothing (a clock or a credential probe releases them), **parked** items need a decision.
`finish` refuses to call a run finished while either is outstanding, and refuses to call it
green when Feature Verify was red or never ran.

The `sandcastle-run` skill ([`skills/sandcastle-run/SKILL.md`](../skills/sandcastle-run/SKILL.md))
and the `/sandcastle-run` command ([`commands/sandcastle-run.md`](../commands/sandcastle-run.md))
are the loop around those commands (see README, Agent skills). They cover what to do per park
reason and the hard rules: never `pkill` the ui, never rebase a worktree whose container is
up, always `--force-with-lease`, resolve conflicts in `~/.sandcastle/worktrees/<project>/...`
and never in the shared checkout.
