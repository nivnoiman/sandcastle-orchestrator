# Agent providers

Status: approved 2026-10-23.

## Goal

Run any agent stage with an agent CLI other than Claude Code, on the owner's **subscription login** (Claude Pro/Max, ChatGPT Plus/Pro) or an API key, and mix providers per stage.

First: `claude` (unchanged behaviour), `codex` (OpenAI Codex CLI). Room for `gemini`.

## Today (what is hardwired)

| Seam | Where |
|---|---|
| command + flags | `claudeCommand()` / `CLAUDE_FLAGS` — `src/real/sandboxRunner.ts` |
| credential mounts | `claudeHomeMounts()` (`~/.claude` + `~/.claude.json`, read-only) |
| home hydration | `hydrateHomeCommand()` copies `.credentials.json`, settings, skills, commands into a container-local `~/.claude` |
| credential env | `agentAuthEnv()` — `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (`src/real/env.ts`) |
| failure parsing | `src/real/agentFailure.ts` — Claude stream-json `rate_limit_event`, 401, auth phrases |
| auth probe | `src/real/authProbe.ts` — throwaway container, `claude -p` "reply ok" |
| call sites | `DockerSandboxRunner.runAgent` (develop/simplify/review/salvage/resolve), `CommandVerifyHarness` + `DockerComposeHarness` (feature-verify agent), `DockerIntegrationHarness` (feature-fix, polish) |
| skills | `src/real/skills.ts` — `simplify`, `mat-review`, `tdd` read by path from `~/.claude/skills/*/SKILL.md`; polish runs `/polish` via Claude's `Skill` tool, fallback reads `~/.claude/commands/polish.md` |
| egress preflight | `CONTAINER_EGRESS_HOSTS = ["api.anthropic.com", "api.github.com"]` |
| dashboard transcript | `src/ui/page.html` `describeEvent()` — Claude stream-json only |
| image | `docker/Dockerfile` — `npm i -g @anthropic-ai/claude-code` |

## Prior art: mattpocock/sandcastle

`src/AgentProvider.ts`: factories `claudeCode(model)`, `codex(model)`, … returning

```ts
interface AgentProvider {
  name: string;
  env: Record<string, string>;
  buildPrintCommand(o): { command: string; stdin?: string };
  parseStreamLine(line: string): ParsedStreamEvent[]; // text | tool_call | result | session_id | usage
}
```

Install lives outside the provider (per-agent Dockerfile template). Auth is env-only (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY`). We reuse the shape (name, env, command builder, stream parser) and add what we need that it lacks: login-file mounts/hydration, failure classification (rate-limit / auth → park-and-resume), probe, skill delivery.

## Design

### Module

`src/real/agents/` — deep module, one entry (`index.ts`):

```ts
export type ProviderName = "claude" | "codex";           // "gemini" later

export interface AgentProvider {
  readonly name: ProviderName;
  readonly label: string;                                 // "Claude Code", "Codex CLI" — for messages
  readonly egressHosts: readonly string[];
  /** Shell command; the prompt arrives on stdin. Model omitted → the CLI's own default. */
  command(model: string | undefined): string;
  /** Read-only host mounts this provider's home hydrates from (login files, instructions). */
  homeMounts(layout: SandcastleLayout): Mount[];
  /** Builds the container-local home: login, instructions, skills. Fails if a required skill is missing. */
  hydrateCommand(): string;
  /** Credential env for this provider's containers only. */
  authEnv(config: OrchestratorConfig): Record<string, string>;
  /** rate-limit / auth wait, or undefined. */
  classify(stdout: string, stderr: string): AgentWaitError | undefined;
  /** Has Claude's `Skill` tool and subagents (polish prompt variant). */
  readonly skillTool: boolean;
  /** A login file the CLI rewrites on refresh (codex auth.json): refresh gate + copy-back. */
  credential?: RefreshableCredential;
}

export function resolveAgent(config, role: AgentRole): ResolvedAgent; // { provider, model }
export function defaultAgent(config): ResolvedAgent;                 // non-agent containers (verify gate)
export function agentsInUse(config): ResolvedAgent[];                // probe, preflight, egress
export function snapshotCredential(...) / syncBackCredential(...);   // copy-back
// authProbe.ts: probeAgentAuth (all providers), probeAgent (one), ensureFreshLogin (refresh gate)
```

`AgentRole` = `develop | simplify | review | resolve | feature-verify | feature-fix | polish`. Salvage uses its stage's role.

Call sites stop using `claudeCommand/claudeHomeMounts/hydrateHomeCommand` (still re-exported from `sandboxRunner.ts`); they take a `ResolvedAgent` and call `agent.provider.command(agent.model)` etc. `agentWaitFrom(cause)` becomes `agentWaitFrom(cause, provider.classify)`.

### Config

`.sandcastle/config.json` (committed, no secrets):

```json
"agents": {
  "default": "claude",
  "review": "codex",
  "polish": { "provider": "codex", "model": "gpt-5.5-codex" }
}
```

- Value = provider name, or `{ provider, model? }`.
- Missing `agents` → `{ "default": "claude" }` → today's behaviour.
- Unknown role or provider → config error at load.
- Model resolution: stage entry `model` → for `claude` only, today's `SANDCASTLE_MODEL` (develop, resolve, feature-fix) / `SANDCASTLE_REVIEW_MODEL` (the rest) → for `codex`, none (Codex's built-in default).

Secrets stay in `.sandcastle/.env.orchestrator`:

| Provider | Subscription | API key |
|---|---|---|
| claude | mounted `~/.claude` login (`.credentials.json`) or `CLAUDE_CODE_OAUTH_TOKEN` | `ANTHROPIC_API_KEY` |
| codex | mounted `~/.codex/auth.json` (`codex login`, ChatGPT account) | `CODEX_API_KEY` (or `OPENAI_API_KEY`, forwarded as `CODEX_API_KEY`) |

Host login dirs: `SANDCASTLE_CLAUDE_HOME` (exists), new `SANDCASTLE_CODEX_HOME` (default `~/.codex`).

Least privilege: a container only gets **its own provider's** env and mounts (a codex review container never sees `ANTHROPIC_API_KEY`, and vice versa). Feature-verify containers get the verify agent's provider only.

### claude provider

Exactly today: same command, mounts, hydration, env (`agentAuthEnv`), parser. Code moves; strings and tests stay.

### codex provider

- **Install:** `RUN npm install -g @openai/codex` in `docker/Dockerfile` (both CLIs in one image; no per-provider images).
- **Command:** `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral [-m <model>] -` — prompt on stdin, JSONL on stdout. The container is the sandbox (same stance as Claude's `--dangerously-skip-permissions`). `--ephemeral`: no rollout files.
- **Mounts:** host `~/.codex` read-only at `/home/agent/.codex-host`; the skill source (`<claude home>/skills`, `commands`) read-only as today.
- **Hydration:** container-local `~/.codex` (`CODEX_HOME`) gets `auth.json` and `AGENTS.md` (if present) copied in. Host `config.toml` is **not** copied (it can name host MCP servers/paths); `-m`/`-c` come from sandcastle config. Skills: see below.
- **Auth env:** `CODEX_API_KEY` if set (wins over `auth.json` inside Codex).
- **Token refresh (the subtle part).** Codex refreshes ChatGPT tokens when `last_refresh` is > ~8 days old or on a 401, writes them back to `auth.json`, and refresh tokens rotate (re-use → `refresh_token_reused`). A copied-in file that refreshes inside a container would silently invalidate the host's login. So:
  1. **Copy-back:** after every codex run, the orchestrator reads the container's `auth.json`; if it changed and the host file is still the one copied in, it atomically replaces the host file (host-side mutex). Container-only refreshes therefore keep the chain linear.
  2. **Refresh gate:** before starting a codex container, if host `auth.json`'s `last_refresh` is > 7 days old, run the probe first (serialized), so parallel stages start with a fresh token and don't race to refresh.
  3. API key (`CODEX_API_KEY`) needs neither; README recommends it for high parallelism.
- **Failure classification** (Codex prints errors as JSON on stdout: `{"type":"error"}`, `turn.failed.error.message`, `item.completed` with `item.type:"error"`):
  - rate-limit: `/you.ve hit your usage limit/i`, `usage_limit_reached`, `rate limit exceeded`, `Quota exceeded` → `rate-limit`; `resumeAt` parsed from "try again at 3:15 PM" / "try again at Oct 24th, 2026 3:15 PM" (container TZ = UTC), else undefined (engine's default backoff).
  - auth: `refresh token has expired|was already used|was revoked`, `Failed to refresh token`, `401 Unauthorized`, `Not logged in`, `invalid api key` → `auth`.
  - transient: existing `transientWaitFrom` (provider-neutral).
- **Probe:** same throwaway container, `codex exec` with the existing "reply ok" prompt (`codex login status` ignores `CODEX_API_KEY`, so a real call is the honest probe). Copy-back applies.
- **Egress:** `api.openai.com`, `chatgpt.com` (ChatGPT-login backend), `auth.openai.com` (refresh).

### Skills

Skills stay **files read by path** — every stage prompt already says "Read `<path>` and follow it", which works for any agent that can read files. One source on the host (`<claude home>/skills`, unchanged), hydrated into every container at the same `~/.claude/skills/<name>/SKILL.md`, so prompts don't change.

- claude: as today (also discoverable as Claude skills).
- codex: same files, plus `~/.agents/skills → ~/.claude/skills` symlink so Codex's native skill discovery sees them (our SKILL.md files already carry `name`/`description` frontmatter). No inlining needed; inlining stays the fallback for a future provider that can't read files.
- polish: prompt picks the instruction from `capabilities.skillTool`. Claude: unchanged ("invoke via the `Skill` tool, else read `~/.claude/commands/polish.md`"). Codex: "read `~/.claude/commands/polish.md` and follow it; you cannot spawn subagents, so run its three passes yourself in order, committing between them".
- Global instructions: claude `CLAUDE.md` (today); codex host `~/.codex/AGENTS.md` if present.

### Auth hold / rate limits with mixed providers

- `waiting:rate-limit` is per item already → unaffected; message names the provider ("Codex CLI usage limit reached …").
- `waiting:auth` holds new stages globally (today). The re-probe now probes **every provider in use** and releases when all pass. Simple and safe; per-provider holds are a later refinement.

### Preflight

- `agent auth` check: probe each provider in use (a real call is the honest credential check); the failure names the provider.
- Egress: union of providers' hosts + `api.github.com`.
- `agent skills`: unchanged (one source).

### Transcripts / dashboard

Attempt logs keep raw stdout (Claude stream-json or Codex JSONL). `describeEvent()` in `page.html` learns Codex events: `thread.started` (meta), `item.completed` → `agent_message` (text), `command_execution` (tool `→ $ cmd`), `file_change` (tool), `error` / `turn.failed` (err), `turn.completed` (result + tokens). Agent header line becomes `--- agent (codex, gpt-5.5-codex) ---`.

### Smoke

`sandcastle smoke [repo] [--agent=claude|codex]` (default `claude`, today's checks). With `--agent=codex`: `codex --version`, hydrate, then a real `codex exec` "reply ok" through the mounted login/env, classify output, copy-back. This is the end-to-end proof.

### Gemini (later, not built now)

Fits the interface: `npm i -g @google/gemini-cli`; `gemini -p "" --yolo --skip-trust -o stream-json [-m]` (stdin appended); `GEMINI_API_KEY` or mounted `~/.gemini/oauth_creds.json` (headless reuse unverified); `GEMINI_CLI_TRUST_WORKSPACE=true` else `--yolo` is silently ignored.

## Out of scope

- Per-provider auth holds; per-provider concurrency caps.
- Session resume/fork; token/cost accounting across providers.
- Codex `config.toml` passthrough, reasoning-effort knobs (can add `effort` to the stage entry later).

## Work plan

1. `src/real/agents/` + claude provider; move code; all call sites through `ResolvedAgent`. Tests green, no behaviour change.
2. Config `agents` parsing + model resolution + tests.
3. codex provider: command, hydration, env, classifier (+ resetsAt parser), copy-back + refresh gate. Unit tests.
4. Preflight/probe/hold over providers in use; egress union.
5. Dockerfile, prompt polish variant, dashboard events, smoke `--agent`.
6. README Configuration + Security model; `docs/internals.md` pointer.

## Decisions

1. Token refresh: copy-back + refresh gate.
2. Role names as listed.
3. Default provider stays `claude`. A stage set to `codex` without `model` omits `-m` (Codex's own default).
4. No Codex account available: smoke `--agent=codex` checks install, hydration and the command; a real Codex call is untested. README says non-Claude providers are untested on subscriptions.
5. PR targets `main`, stacked on PR #1 (`refactor/polish`).
