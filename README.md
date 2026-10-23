# sandcastle-orchestrator

Turn a GitHub issue tree into merged, verified code. You publish one **Orchestration Issue**
whose native sub-issues are the work; sandcastle-orchestrator runs each sub-issue through a
chain of fresh Claude Code agents in throwaway Docker containers, merges them into an
integration branch, verifies the assembled feature, and opens one `integration → dev` pull
request per repo for a human to merge.

```
sub-issue ──► develop ──► simplify ──► review ──► verify gate ──► squash-merge into integration/<feature>
   (one sandboxed agent per stage, rework rounds on red, park for a human when stuck)
                                          all items done ──► Feature Verify ──► polish ──► PR integration → dev
```

## Standing on the shoulders of Sandcastle

This is a **side project and a complement to [Matt Pocock's Sandcastle](https://github.com/mattpocock/sandcastle)**
(`@ai-hero/sandcastle`) — all the credit for the idea, the name and the "agents in a sandbox,
merge the branches back" model goes there. If you want a TypeScript library to orchestrate
sandboxed coding agents with `sandcastle.run()`, use Sandcastle.

sandcastle-orchestrator is an opinionated layer for one workflow on top of that idea:
**GitHub issues in, reviewed pull requests out**, with a scheduler, a dependency graph, crash
recovery from labels, a local control-plane dashboard and an operator CLI. It currently ships
its own Docker runner; moving its sandbox layer onto `@ai-hero/sandcastle` is on the roadmap.
It is not affiliated with or endorsed by the Sandcastle project.

## Features

- **Issue-driven runs.** A parent issue + native sub-issues + native *blocked-by* edges is the
  whole plan. Items are scheduled as a DAG under a worker cap, deepest stage first.
- **Stage chain per item.** develop (test-first) → simplify → review → verify gate (rebase,
  checks, squash-merge), each a fresh agent that did not write the code before it.
- **Rework rounds.** A red gate or `NEEDS-REWORK:` from review sends the item back to develop
  with a written brief, up to a limit; then it parks for a human.
- **Park, hold, resume.** `ready-for-agent` admits an item; without it the item is *Held*.
  Parked items flip to `ready-for-human`; flipping back re-queues from the stage that failed.
- **Crash-resume.** `sc:*` stage labels and pull-request markers are the durable state —
  restart the orchestrator and every item resumes where it was.
- **Docker sandbox.** One container per stage, sanitized `.env`, mounted read-only Claude
  home, idle timeout with a salvage pass, startup garbage collection of orphans.
- **Feature Verify.** Once every item merged, a fresh agent checks the assembled feature
  against every acceptance criterion — via a throwaway compose environment, your own verify
  command, or not at all (pluggable, see below). Red results get fix rounds.
- **Polish.** A final simplify/review/strip-comments pass on the integration pull request.
- **Control plane.** Express + SSE dashboard on `127.0.0.1:7777`: stage chains, live cap,
  pause, cancel/retry, reset, a run queue, parallel parents with a global cap.
- **Operator CLI.** `npm run ops -- <command>` prints one JSON object per call, so another
  agent (or you) can launch, watch and finish runs without the UI.
- **Single- or multi-repo.** The hub (where issues live) and the code repos can be the same
  repository or several.

## Requirements

- Node.js 20.11+ and npm
- Docker (Docker Desktop on Windows/macOS)
- [GitHub CLI](https://cli.github.com/) `gh`, logged in (`gh auth login`) with write access to
  the hub repo's issues
- [Claude Code](https://docs.claude.com/en/docs/claude-code), logged in on the host — agents
  reuse its credentials through a read-only mount (or set `ANTHROPIC_API_KEY`)
- The agent skills listed under [Agent skills](#agent-skills) in your `~/.claude`

## Install

```bash
git clone https://github.com/nivnoiman/sandcastle-orchestrator.git
cd sandcastle-orchestrator
npm ci
npm run build-image          # docker image sandcastle:latest (node 20, gh, claude, pnpm/yarn, playwright)
npm test                     # optional: the suite needs no docker, gh or tokens
```

## Set up a project

**1. Add `sandcastle.config.json` to the root of the repo that holds your issues.**

Single repo (issues and code in one place):

```json
{
  "hubRepo": "your-name/your-app",
  "integrationBase": "dev",
  "repos": {
    "app": {
      "github": "your-name/your-app",
      "bootstrap": "pnpm install --frozen-lockfile",
      "checks": "pnpm typecheck && pnpm test && pnpm build"
    }
  },
  "verify": {
    "strategy": "command",
    "commands": { "app": "pnpm typecheck && pnpm test && pnpm build" }
  }
}
```

A multi-repo example with a compose verify environment is in
[`examples/demo/sandcastle.config.json`](examples/demo/sandcastle.config.json).

| Field | Default | Meaning |
|---|---|---|
| `name` | repo part of `hubRepo` | project name (kebab); namespaces state dirs and docker objects |
| `hubRepo` | — | `owner/name` holding the Orchestration Issue and its sub-issues |
| `integrationBase` | `dev` | branch `integration/<feature>` is cut from and its PRs target |
| `imageTag` | `sandcastle:latest` | agent image |
| `memoryProject` | derived from the config folder | `~/.claude/projects/<this>/memory` holds `load_bearing_memories` |
| `stateDir` | `<tool>/projects/<name>` | `.env.orchestrator`, sandbox envs, worktrees, logs, lock, queue |
| `repos.<name>.github` | — | `owner/name`; `<name>` is what the `repo:<name>` label says |
| `repos.<name>.path` | `.` when it is the hub repo, else `../<name>` | local checkout, relative to the config file |
| `repos.<name>.bootstrap` | none | run in every agent container before work (`npm ci`, `pnpm install …`) |
| `repos.<name>.checks` | — | the per-item gate; must be green before an item merges |
| `verify` | `{ "strategy": "none" }` | Feature Verify strategy, see below |

**2. Give it secrets** — in the tool folder (never in your repo):

```bash
mkdir -p projects/<name>
cp .env.orchestrator.example projects/<name>/.env.orchestrator  # GH_TOKEN etc. (or <tool>/.env.orchestrator for all projects)
cp .env.sandbox.example projects/<name>/.env.sandbox # SAFE dev values only; an empty file is fine
```

Two env files, two jobs: `.env.orchestrator` is sandcastle's own secrets (read by the host only,
never visible to agents); `.env.sandbox` is your app's env, copied into each agent worktree as `.env`.

`GH_TOKEN` is a fine-grained PAT with *contents* + *pull requests* write on every repo under
`repos` — agents push and open PRs with it. Labels and comments use the host's `gh auth`.

**3. Point the commands at the config** with `--config=<path>`, `SANDCASTLE_CONFIG=<path>`, or by
running from the folder that holds `sandcastle.config.json` (e.g. `npm --prefix <tool> run ui -- 12`).
Relative paths resolve against the folder you ran `npm` in.

### Feature Verify strategies

| `verify.strategy` | What runs once every item merged |
|---|---|
| `none` | Nothing. The report says only the per-item gates ran; the integration PR still opens. |
| `command` | One throwaway container with a fresh copy of each involved repo's integration branch: `bootstrap`, then `verify.commands.<repo>` (default: its `checks`). Red → fix rounds. Green → a fresh agent checks every acceptance criterion against the built code (Playwright + chromium are in the image). `"agent": false` skips the agent and lets the green commands be the report. |
| `compose` | A throwaway docker network with an optional fresh `mongo` (`"mongo": true` or an image) and **every** repo built and served (`services.<repo>`: `build`, `seed`, `serve`, `port`, `healthPath`, `env`). `env` values expand `{{port}}`, `{{mongoUri}}`, `{{mongoDb}}`, `{{url:<repo>}}`. The agent drives the APIs over HTTP and UIs with Playwright; anything that needs a provider in `externalProviders` is marked `REQUIRES-STG` for a human. Every mongo URI in the env must point at the local container or verify refuses to start. |

## Publish contract

A run is defined entirely on GitHub:

**Parent (Orchestration Issue)** on `hubRepo`: label `sandcastle`, and exactly one yaml fence
with a `sandcastle:` key:

```yaml
sandcastle: v1
feature: my-feature                # kebab slug → integration/my-feature, feat/<n>-<slug>
required_reading:                  # repo-relative paths every agent reads first
  app:
    - CLAUDE.md
    - docs/architecture.md
load_bearing_memories:             # optional slugs from the project's Claude memory dir
  - feedback_no_code_comments
```

**Work Items** — native sub-issues of the parent:

- exactly one `repo:<name>` label naming a repo from the config (split cross-repo work into
  two items joined by a blocking edge);
- native *blocked-by* edges between siblings (a `## Blocked by` section with `#<n>` refs is the
  fallback only when the API is unavailable); an edge to a closed sibling is satisfied;
- `ready-for-agent` → queued, without it → **Held**; parked items get `ready-for-human`;
- body: `## What to build`, `## Acceptance criteria` checklist (review and verify measure
  against it); optional yaml fence `extra_memories: [<slug>]`.

**Labels** (create once on the hub): `sandcastle`, `repo:<name>` per repo, `ready-for-agent`,
`ready-for-human`, and the orchestrator-owned stage mirror `sc:queued` `sc:blocked`
`sc:developing` `sc:simplifying` `sc:in-review` `sc:verifying` `sc:done` `sc:needs-human`
(never set these by hand — crash-resume reads them).

`npm run validate` enforces all of it and names the offending issue for every violation:
version `v1`, slug format, `required_reading` keys ⊆ repos used, one known `repo:` label per
item, sibling-only edges, no cycles.

## Commands

All take `--config=<path>` (or `SANDCASTLE_CONFIG`). `<parent>` is the Orchestration Issue number.

```bash
npm run validate -- <parent>                     # parse + print the run model, or every violation
npm run dry-run -- <parent> [--cap=N]            # simulate scheduling with fake adapters (no tokens)
npm run preflight -- <parent> [--skip-verify]    # every start-time check, no lock, no tokens
npm run ui -- <parent> [--cap=N] [--port=N]      # control plane at http://127.0.0.1:7777, real mode
npm run ui -- <parent> --dry [--fail=17:review]  # paced simulation of that parent in the UI
npm run start -- <parent> [--cap=N]              # headless real run (spends tokens)
npm run reset -- <parent> [--apply]              # clear a killed run's containers/worktrees/labels
npm run smoke -- [repo]                          # non-billed container + git plumbing check
npm run sync-claude -- <source ~/.claude>        # copy skills/memories/credentials into the agent home
```

Try it with zero setup:

```bash
npm run dry-run -- examples/demo/demo-run.json --cap=2 --config=examples/demo/sandcastle.config.json
npm run ui -- examples/demo/demo-run.json --config=examples/demo/sandcastle.config.json
```

### Operating a run

`npm run ops -- <command>` is the operator surface — JSON out, idempotent:

```bash
npm run ops -- preflight <parent>
npm run ops -- launch <parent>... --cap=2 [--parallel=N | --sequential] [--global-cap=N]
npm run ops -- status [--parent=N] [--items] | status --summary | queue
npm run ops -- logs <item> [stage]
npm run ops -- resume-parked [--parent=N] [--only=<text>]
npm run ops -- resolve-conflict <item>
npm run ops -- pause | resume [--parent=N] | stop <parent> | cap <N> [--parent=N]
npm run ops -- finish [--parent=N]               # asserts done, prints the integration → base PRs
```

`launch` starts the control plane under a supervisor (restarts on crash, resumes from labels)
and logs to `projects/<name>/ui-<parent>.log`. **Waiting** items need nothing (a usage window or
a credential probe releases them); **parked** items need a decision. `finish` refuses to call a
run green while either is outstanding or Feature Verify was red.

Hard rules when you step in by hand: never kill the UI process mid-stage, never rebase a
worktree whose container is up, push with `--force-with-lease` only, and resolve conflicts in
`projects/<name>/worktrees/<repo>/<branch>` — never in your working checkout.

[`skills/sandcastle-run/SKILL.md`](skills/sandcastle-run/SKILL.md) is a Claude Code skill that
drives this loop end to end; copy it to `~/.claude/skills/sandcastle-run/`.

## Agent skills

The stage prompts invoke Claude Code skills that must exist in the host `~/.claude` (preflight
checks them):

- `skills/tdd/SKILL.md` — develop and rework (see [mattpocock/skills](https://github.com/mattpocock/skills))
- `skills/simplify/SKILL.md` — the simplify stage
- `skills/mat-review/SKILL.md` — the review stage (standards + spec, two axes)
- `commands/polish.md`, `commands/review.md` — the polish stage

Any skill with that name and the same contract (apply fixes since a fixed point; review a diff
against standards and the issue) works.

## Security model

Agents run Claude Code with `--dangerously-skip-permissions` inside their containers, read the
issue text you label, and hold real credentials. Treat that as the trust boundary:

- **Only label issues written by people you trust.** Issue bodies reach the agents verbatim;
  a hostile body is a prompt injection into an agent that can push code. Comments are not read.
- **`GH_TOKEN` is a fine-grained PAT** scoped to exactly the repos under `repos`, with
  contents + pull requests write and nothing else. Never a classic token, never org-wide.
- **Agents see your Claude credentials** (a read-only mount of `~/.claude`, copied into the
  container). Prefer a dedicated `ANTHROPIC_API_KEY` with a spend limit if that matters to you.
- **Containers have network access** (npm, GitHub, Anthropic). There is no egress filter.
- **The host is guarded against the shared `.git`.** Each container mounts the repo's `.git`
  so it can commit; host git runs with hooks and fsmonitor disabled, and the orchestrator
  refuses a stage (restoring the file) if a container changed `.git/config` or
  `.git/info/attributes`.
- **`.env.sandbox` is readable by agents.** Put only throwaway dev values there.
- **The control plane** listens on `127.0.0.1` only, checks the `Host` header and requires an
  `x-sandcastle: 1` header on every write.

## How it works

[`docs/internals.md`](docs/internals.md) covers the engine, labels, preflight, rework, conflicts,
sandbox hardening, salvage, prompts, the control plane API, Feature Verify, polish, parallel
parents and transcripts in detail.

## License

[MIT](LICENSE)
