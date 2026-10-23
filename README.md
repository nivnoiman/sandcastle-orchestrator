# sandcastle-orchestrator

Issue-driven multi-agent orchestrator. GitHub sub-issues in, verified integration pull requests out.

You publish one **Orchestration Issue** whose native sub-issues are the work. Each sub-issue runs through a chain of fresh Claude Code agents in throwaway Docker containers and is squash-merged into an integration branch. The assembled feature is then verified, and one `integration/<feature> -> dev` pull request per repo waits for a human to merge.

## How it works

```
sub-issue -> develop -> simplify -> review -> verify gate -> squash-merge into integration/<feature>
             (one sandboxed agent per stage; rework rounds on red; park for a human when stuck)

all items done -> Feature Verify -> polish -> PR integration/<feature> -> dev
```

| Part | What it does |
|---|---|
| Scheduler | Items run as a DAG of native *blocked-by* edges under a worker cap, deepest stage first. |
| Stage chain | develop (test-first), simplify, review, verify gate (rebase, checks, squash-merge). Each stage is a fresh agent. |
| Rework | A red gate or `NEEDS-REWORK:` from review sends the item back to develop with a written brief, up to a limit. Then it parks. |
| Park and hold | `ready-for-agent` admits an item; without it the item is held. Parked items get `ready-for-human`. Flipping the label back resumes from the failed stage. |
| Crash-resume | `sc:*` labels and pull-request markers are the durable state. A restart resumes every item where it was. |
| Sandbox | One container per stage, sanitized `.env`, read-only Claude home, idle timeout with a salvage pass, startup cleanup of orphans. |
| Feature Verify | After every item merged, a fresh agent checks the assembled feature against every acceptance criterion. Red results get fix rounds. |
| Polish | A final simplify, review and comment-strip pass on each integration pull request. |
| Control plane | Local dashboard (Express + SSE): stage chains, cap, pause, cancel, retry, reset, a run queue, parallel parents. |
| Operator CLI | Run commands print one JSON object each, so an agent or a person can launch, watch and finish runs without the UI. |

The hub repo (where issues live) and the code repos can be one repository or several.

## Requirements

| Tool | Notes |
|---|---|
| Node.js 20.11+ and npm | |
| Docker | Docker Desktop on Windows and macOS |
| [GitHub CLI](https://cli.github.com/) `gh` | Logged in (`gh auth login`) with write access to the hub repo's issues |
| An agent CLI login | [Claude Code](https://docs.claude.com/en/docs/claude-code) (default) and/or [Codex CLI](https://github.com/openai/codex), logged in with your subscription or an API key. See [Agent providers](#agent-providers) and [Agent login](#agent-login). |
| Agent skills | Installed in `~/.claude`, see [Agent skills](#agent-skills) |

## Install

Once per machine:

```bash
git clone https://github.com/nivnoiman/sandcastle-orchestrator.git && cd sandcastle-orchestrator && npm ci && npm link && npm run build-image
```

| Step | Result |
|---|---|
| `npm ci` | Dependencies |
| `npm link` | A global `sandcastle` command |
| `npm run build-image` | Docker image `sandcastle:latest` (node 20, gh, claude, codex, pnpm, yarn, Playwright) |

`npm test` runs the suite. It needs no Docker, `gh` or tokens.

Without `npm link`, run commands from the project root as `npm --prefix <sandcastle clone> run <script> -- <args>` (run-operating commands: `npm --prefix <sandcastle clone> run ops -- <command>`). `init` always targets the directory it is run from, so it ignores `--config`.

## Quick start

Run everything from the root of the project that holds your issues.

```bash
cd ~/src/my-app
sandcastle init                       # or: sandcastle init --hub=owner/name --port=7781
```

`init` detects the hub repo (`gh repo view`, then the `origin` remote), the package manager and the `typecheck`, `test` and `build` scripts. It picks the first free port from 7777 and creates `.sandcastle/`. Then:

1. Put a fine-grained `GH_TOKEN` in `.sandcastle/.env.orchestrator`.
2. Put safe dev values in `.sandcastle/.env.sandbox`. An empty file is fine.
3. Review `bootstrap` and `checks` in `.sandcastle/config.json`.
4. Commit `.sandcastle/config.json` and `.sandcastle/.gitignore`.
5. Publish an Orchestration Issue (see [Publish contract](#publish-contract)) and run it:

```bash
sandcastle validate 12                # parse the issue tree, print the run model or every violation
sandcastle preflight 12               # every start-time check, no lock, no tokens
sandcastle launch 12 --cap=2          # start the control plane and the run
sandcastle status                     # watch it
sandcastle finish                     # assert done, print the integration pull requests
```

The dashboard is at `http://127.0.0.1:<ui.port>`.

To try the scheduler with no setup, from the clone:

```bash
sandcastle dry-run examples/demo/demo-run.json --cap=2 --config=examples/demo
sandcastle ui examples/demo/demo-run.json --config=examples/demo
```

## Configuration

The project is found by walking up from the current directory to the first `.sandcastle/config.json`. `--config=<path>` or `SANDCASTLE_CONFIG` override that and accept the config file, the `.sandcastle` folder or the project root. Relative paths in the config resolve against the project root.

Single repo, as `init` writes it:

```json
{
  "hubRepo": "your-name/your-app",
  "integrationBase": "dev",
  "repos": {
    "your-app": {
      "github": "your-name/your-app",
      "bootstrap": "pnpm install --frozen-lockfile",
      "checks": "pnpm typecheck && pnpm test && pnpm build"
    }
  },
  "verify": { "strategy": "command" },
  "ui": { "port": 7777 }
}
```

A multi-repo example with a compose verify environment is in [`examples/demo/.sandcastle/config.json`](examples/demo/.sandcastle/config.json).

| Field | Default | Meaning |
|---|---|---|
| `name` | repo part of `hubRepo` | Project name, lower-case kebab. Namespaces worktrees and Docker objects (`sc-<name>-...`). |
| `hubRepo` | required | `owner/name` holding the Orchestration Issue and its sub-issues |
| `integrationBase` | `dev` | Branch `integration/<feature>` is cut from and its pull requests target |
| `imageTag` | `sandcastle:latest` | Agent image |
| `memoryProject` | derived from the project root | `~/.claude/projects/<this>/memory` holds `load_bearing_memories` |
| `stateDir` | `<project>/.sandcastle` | Env files, logs, lock, queue, `ui-<parent>.log` |
| `repos.<name>.github` | required | `owner/name`. `<name>` is what the `repo:<name>` label says. |
| `repos.<name>.path` | `.` for the hub repo, else `../<name>` | Local checkout, relative to the project root |
| `repos.<name>.bootstrap` | none | Runs in every agent container before work (`npm ci`, `pnpm install ...`) |
| `repos.<name>.checks` | required | The per-item gate. Must be green before an item merges. |
| `verify` | `{ "strategy": "none" }` | Feature Verify strategy, see below |
| `ui.port` | `7777` | Control plane port for this project |
| `agents` | `{ "default": "claude" }` | Which agent CLI runs each stage, see [Agent providers](#agent-providers) |

Port precedence: `--port=N`, then `SANDCASTLE_UI_PORT`, then `ui.port`, then `7777`.

### Agent providers

Every agent stage runs one agent CLI. `agents.default` picks it for all stages, and a role key overrides one stage:

```json
"agents": {
  "default": "claude",
  "review": "codex",
  "polish": { "provider": "codex", "model": "gpt-5.5-codex" }
}
```

| Provider | CLI | Subscription login | API key |
|---|---|---|---|
| `claude` (default) | Claude Code | `~/.claude` login or `CLAUDE_CODE_OAUTH_TOKEN` | `ANTHROPIC_API_KEY` |
| `codex` | OpenAI Codex CLI | `~/.codex/auth.json` from `codex login` (ChatGPT account) | `CODEX_API_KEY` (or `OPENAI_API_KEY`) |

- Roles: `develop`, `simplify`, `review`, `resolve`, `feature-verify`, `feature-fix`, `polish`. Salvage runs under its stage's role.
- A value is a provider name or `{ "provider": ..., "model": ... }`.
- Models: `model` from the entry first. Otherwise claude keeps `SANDCASTLE_MODEL` (develop, resolve, feature-fix; default `opus`) and `SANDCASTLE_REVIEW_MODEL` (the rest; default `sonnet`). Codex without a `model` uses its own default.
- Skills are the same files for every provider (see [Agent skills](#agent-skills)). Claude invokes them as skills. Codex reads them by path and also finds them in `~/.agents/skills`. Codex has no `Skill` tool or subagents, so polish tells it to run the `/polish` passes itself, in order.
- Auth holds and re-probes cover every provider in use. One rejected login holds new stages for the whole run.
- `sandcastle smoke --agent=codex` checks the codex install, home and flags in a container. It makes a real call only when a Codex login or `CODEX_API_KEY` is present.

> **Status:** `claude` is the tested path. `codex` is unit-tested and smoke-checked up to the CLI, but it has **not** been run end to end on a ChatGPT subscription or an OpenAI API key yet. Gemini CLI fits the same interface but is not built.

### Feature Verify strategies

| `verify.strategy` | What runs once every item merged |
|---|---|
| `none` | Nothing. The report says only the per-item gates ran. The integration pull request still opens. |
| `command` | One throwaway container with a fresh copy of each involved repo's integration branch: `bootstrap`, then `verify.commands.<repo>` (default: its `checks`). Red: fix rounds. Green: a fresh agent checks every acceptance criterion against the built code (Playwright and Chromium are in the image). `"agent": false` skips the agent; the green commands are the report. |
| `compose` | A throwaway Docker network with an optional fresh `mongo` (`"mongo": true` or an image) and every repo built and served (`services.<repo>`: `build`, `seed`, `serve`, `port`, `healthPath`, `env`). `env` values expand `{{port}}`, `{{mongoUri}}`, `{{mongoDb}}`, `{{url:<repo>}}`. The agent drives APIs over HTTP and UIs with Playwright. Scenarios that need a provider in `externalProviders` are marked `REQUIRES-STG` for a human. Every mongo URI in the env must point at the local container or verify refuses to start. |

## Files in `.sandcastle/`

| File | Committed | Purpose |
|---|---|---|
| `config.json` | yes | Project config |
| `.gitignore` | yes | `*`, `!.gitignore`, `!config.json`. Everything else stays local. |
| `.env.orchestrator` | no | sandcastle's own secrets (`GH_TOKEN`, optional `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, overrides). Read by the host only, never visible to agents. |
| `.env.sandbox` | no | Your app's env, copied into each agent worktree as `.env`. Agents can read it. `.env.sandbox.<repo>` overrides it for one repo. |
| `logs/` | no | Attempt transcripts and saved leftovers |
| `.orchestrator.lock` | no | Held while a run is live |
| `.queue.json` | no | Run queue and its settings |
| `ui-<parent>.log` | no | Control plane log written by `launch` |

A shared `.env.orchestrator` in the sandcastle clone is read first; the project's own file wins on a clash. Use it to share one `GH_TOKEN` across projects.

Agent worktrees live outside the repo, in `~/.sandcastle/worktrees/<project>/<repo>/<branch>`. `SANDCASTLE_WORKTREE_DIR` overrides the base folder.

`GH_TOKEN` is a fine-grained PAT with *contents* and *pull requests* write on every repo under `repos`. Agents push and open pull requests with it. Labels and comments use the host's `gh auth`.

**Migrating from the old layout:** state that lived in `<sandcastle clone>/projects/<name>/` moves into `<project>/.sandcastle/`. Alternatively set `stateDir` to the old folder.

## Publish contract

A run is defined entirely on GitHub.

**Parent (Orchestration Issue)** on `hubRepo`: label `sandcastle`, and exactly one yaml fence with a `sandcastle:` key:

```yaml
sandcastle: v1
feature: my-feature                # kebab slug: integration/my-feature, feat/<n>-<slug>
required_reading:                  # repo-relative paths every agent reads first
  app:
    - CLAUDE.md
    - docs/architecture.md
load_bearing_memories:             # optional slugs from the project's Claude memory dir
  - feedback_no_code_comments
```

**Work Items** are native sub-issues of the parent:

- Exactly one `repo:<name>` label naming a repo from the config. Split cross-repo work into two items joined by a blocking edge.
- Native *blocked-by* edges between siblings. A `## Blocked by` section with `#<n>` refs is the fallback only when the API is unavailable. An edge to a closed sibling is satisfied.
- With `ready-for-agent` the item is queued; without it the item is held. Parked items get `ready-for-human`.
- Body: `## What to build` and an `## Acceptance criteria` checklist (review and verify measure against it). Optional yaml fence `extra_memories: [<slug>]`.

**Labels** (create once on the hub):

| Label | Set by |
|---|---|
| `sandcastle` | You, on the parent |
| `repo:<name>` | You, one per repo |
| `ready-for-agent`, `ready-for-human` | You, and the orchestrator on park |
| `sc:queued` `sc:blocked` `sc:developing` `sc:simplifying` `sc:in-review` `sc:verifying` `sc:done` `sc:needs-human` | The orchestrator only. Never set these by hand: crash-resume reads them. |

`sandcastle validate` enforces all of it and names the offending issue for every violation: version `v1`, slug format, `required_reading` keys within the repos used, one known `repo:` label per item, sibling-only edges, no cycles.

## Commands

`<parent>` is the Orchestration Issue number. Every command except `init` accepts `--config=<path>`; from inside the project it is not needed. Inside a project, run a command without arguments to print its usage.

**Project**

| Command | What it does |
|---|---|
| `sandcastle init [--hub=owner/name] [--port=N]` | Create `.sandcastle/` in the current directory |
| `sandcastle validate <parent> [owner/repo]` | Parse and print the run model, or every violation |
| `sandcastle dry-run <parent \| fixture.json> [--cap=N]` | Simulate scheduling with fake adapters (no tokens) |
| `sandcastle preflight <parent> [--skip-verify]` | Every start-time check, no lock, no tokens |
| `sandcastle ui <parent \| fixture.json> [--cap=N] [--port=N] [--dry] [--fail=<item>:<stage>]` | Control plane in the browser. `--dry` simulates that parent. |
| `sandcastle start <parent> [--cap=N] [--skip-verify]` | Headless real run (spends tokens) |
| `sandcastle reset <parent> [--apply]` | Clear a killed run's containers, worktrees and labels. Prints the plan without `--apply`. |
| `sandcastle smoke [repo] [--agent=claude\|codex]` | Container, git plumbing and agent-home check. Non-billed, except a codex smoke with a login makes one tiny call. |
| `sandcastle sync-claude <source ~/.claude>` | Copy skills, memories and credentials into the agent home |

**Operating a run** (JSON out; also available as `sandcastle ops <command>`)

| Command | What it does |
|---|---|
| `sandcastle launch <parent>... [--cap=N] [--parallel=N \| --sequential] [--global-cap=N]` | Start the control plane if it is down, start the first parent, queue the rest |
| `sandcastle enqueue <parent>... [--cap=N]` | Queue parents behind the runs in flight |
| `sandcastle dequeue <parent>` | Drop a parent from the queue |
| `sandcastle queue-mode sequential\|parallel [--max=N]` | One parent at a time, or up to N at once |
| `sandcastle queue-resume`, `sandcastle queue-clear` | Resume a paused queue, or empty it |
| `sandcastle queue` | Queue settings, queued parents, runs on the control plane |
| `sandcastle cap <N> [--parent=N]` | One run's worker cap, or the global cap without `--parent` |
| `sandcastle pause`, `sandcastle resume [--parent=N]` | Hold or release new stage starts |
| `sandcastle stop <parent>` | No new stages start for that run |
| `sandcastle status [--parent=N] [--items]` | One run: phases, holds, waiting reasons, parks, feed, queue |
| `sandcastle status --summary` | Queue, global slots, one line per run |
| `sandcastle logs <item> [stage] [--bytes=N]` | Tail the newest recorded attempt for an item |
| `sandcastle resume-parked [--parent=N] [--only=<text>]` | Retry every parked item whose reason contains `<text>` |
| `sandcastle resolve-conflict <item> [--parent=N]` | Retry one parked item. The gate re-runs and may resolve it with an agent. |
| `sandcastle finish [--parent=N]` | Assert the run is complete and print its integration pull requests |

`--parent=N` may be left out while only one run exists or only one parent is live.

## Running several projects

Each project has its own state folder, lock, queue, worktree folder and Docker names (`sc-<project>-...`). Give each project its own `ui.port` (`init` picks a free one) and they run side by side:

```bash
cd ~/src/app-one && sandcastle launch 12 --cap=2      # ui.port 7777
cd ~/src/app-two && sandcastle launch 40 --cap=1      # ui.port 7778
```

Within one project, one control plane runs several parents: pass several to `launch`, or use `enqueue`, `--parallel=N` and `--global-cap=N`. See [Parallel parents](docs/internals.md#parallel-parents).

## Operating a run

`launch` starts the control plane under a supervisor that restarts it on a crash and resumes from labels. It logs to `.sandcastle/ui-<parent>.log`.

| State in `status` | Meaning | Action |
|---|---|---|
| `running`, `awaiting` | Normal | None |
| `waiting` | Usage window or credential probe | None. It resumes itself. Do not retry it. |
| `held` | No `ready-for-agent` | A human adds the label or does the item |
| `parked` | Needs a decision | Read `logs <item>`, then `resolve-conflict`, `resume-parked`, or report it |

`finish` refuses to call a run green while waiting or parked items remain, or when Feature Verify was red.

Hard rules when you step in by hand:

- Never kill the UI process mid-stage. Crash-resume re-runs whole stages.
- Never rebase a worktree whose container is up.
- Push with `--force-with-lease` only.
- Resolve conflicts in `~/.sandcastle/worktrees/<project>/<repo>/<branch>`, never in your working checkout.
- Integration pull requests are merged by a human.

## Agent login

Log in every provider you use in `agents`, one way each:

| Provider | Method | Setup | Billing |
|---|---|---|---|
| claude | Host login (default) | Log in to Claude Code on the host. `~/.claude/.credentials.json` is mounted read-only into each container. Works on Windows and Linux. | Your Claude subscription |
| claude | OAuth token | Run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` in `.sandcastle/.env.orchestrator`. Needed on macOS, where the login lives in the Keychain. | Your Claude subscription |
| claude | API key | Set `ANTHROPIC_API_KEY` in `.sandcastle/.env.orchestrator`. | Anthropic API usage |
| codex | Host login | Run `codex login` on the host (set `cli_auth_credentials_store = "file"` in `~/.codex/config.toml` if your OS keyring holds it). `~/.codex/auth.json` is mounted read-only and copied into each container. `SANDCASTLE_CODEX_HOME` points elsewhere. | Your ChatGPT subscription |
| codex | API key | Set `CODEX_API_KEY` (or `OPENAI_API_KEY`) in `.sandcastle/.env.orchestrator`. | OpenAI API usage |

With a subscription, a spent usage window shows items as **waiting**; they resume when the window resets. `sandcastle preflight` checks that a throwaway container can reach every provider in use with whichever login is configured.

**Codex token refresh.** Codex rotates its ChatGPT refresh token when it refreshes, roughly every 8 days, and a reused token logs every copy out. So sandcastle refreshes a login that is close to expiry once, through the probe, before the stage starts. When a container refreshes anyway, sandcastle writes the new `auth.json` back to the host, unless the host file changed in the meantime. With many parallel codex stages, `CODEX_API_KEY` avoids the question entirely.

## Security model

Agents run their CLI with every approval and CLI sandbox switched off inside their containers: Claude Code with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`. The Docker container is the sandbox. Agents read the issue text you label and hold real credentials. Treat that as the trust boundary.

- **Only label issues written by people you trust.** Issue bodies reach the agents verbatim. A hostile body is a prompt injection into an agent that can push code. Comments are not read.
- **`GH_TOKEN` is a fine-grained PAT** scoped to exactly the repos under `repos`, with contents and pull requests write and nothing else. Never a classic token, never org-wide.
- **Agents see the credentials of their own provider, and only those.** A claude container gets a read-only mount of `~/.claude`, copied into the container, plus `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`. A codex container gets `~/.codex` (`auth.json`, `AGENTS.md`), the shared `~/.claude/skills` and `~/.claude/commands`, and `CODEX_API_KEY`. It never sees the Claude login, and a claude container never sees Codex's. Use a dedicated `claude setup-token` token or an API key with a spend limit if that matters to you.
- **A refreshed Codex login is written back to the host.** This is the one path where a container's output reaches a host credential file. sandcastle accepts it only if it parses as JSON and the host file is unchanged since the container started.
- **Containers have network access** (npm, GitHub, Anthropic, OpenAI). There is no egress filter.
- **The host is guarded against the shared `.git`.** Each container mounts the repo's `.git` so it can commit. Host git runs with hooks and fsmonitor disabled, and the orchestrator refuses a stage (restoring the file) if a container changed `.git/config` or `.git/info/attributes`.
- **`.env.sandbox` is readable by agents.** Put only throwaway dev values there.
- **`.env.orchestrator` never reaches a container.** The host reads it; it is gitignored.
- **The control plane** listens on `127.0.0.1` only, checks the `Host` header and requires an `x-sandcastle: 1` header on every write.

## Agent skills

The stage prompts invoke skills that must exist in the host `~/.claude`, whichever provider runs the stage. Preflight checks them. Codex containers get a copy of `skills/` and `commands/` only.

| File | Used by |
|---|---|
| `~/.claude/skills/tdd/SKILL.md` | develop and rework (see [mattpocock/skills](https://github.com/mattpocock/skills)) |
| `~/.claude/skills/simplify/SKILL.md` | simplify stage |
| `~/.claude/skills/mat-review/SKILL.md` | review stage (standards and spec) |
| `~/.claude/commands/polish.md`, `~/.claude/commands/review.md` | polish stage |

Any skill with that name and the same contract works: apply fixes since a fixed point; review a diff against standards and the issue.

This repo also ships a skill and a slash command that let Claude Code operate a run end to end:

| File | Install to | Use |
|---|---|---|
| [`skills/sandcastle-run/`](skills/sandcastle-run/SKILL.md) | `~/.claude/skills/sandcastle-run/` | Triggers on requests like "run sandcastle on #12" |
| [`commands/sandcastle-run.md`](commands/sandcastle-run.md) | `~/.claude/commands/sandcastle-run.md` | `/sandcastle-run 12` |

```bash
cp -r skills/sandcastle-run ~/.claude/skills/
cp commands/sandcastle-run.md ~/.claude/commands/
```

## Documentation

[`docs/internals.md`](docs/internals.md) covers the engine, labels, preflight, rework, conflicts, sandbox hardening, salvage, prompts, the control plane API, Feature Verify, polish, parallel parents and transcripts.

## Credits

This is a side project that complements [Matt Pocock's Sandcastle](https://github.com/mattpocock/sandcastle) (npm `@ai-hero/sandcastle`). The name and the idea (agents in a sandbox, branches merged back) come from there. For a TypeScript library that orchestrates sandboxed coding agents, use Sandcastle.

sandcastle-orchestrator is not affiliated with or endorsed by the Sandcastle project. It ships its own Docker runner today. Moving the sandbox layer onto `@ai-hero/sandcastle` is on the roadmap.

## License

[MIT](LICENSE)
