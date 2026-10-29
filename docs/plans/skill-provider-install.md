# Provider choice for skills install - plan

Status: scoping only, no code.

## Key finding: two audiences, only one is Claude-bound

| Artifact | Reader | Today | Provider-specific? |
|---|---|---|---|
| `simplify`, `mat-review`, `tdd`, `to-spec`, `to-tickets` | stage containers (any provider) | host `~/.claude/skills`, mounted + copied by every provider's `hydrateCommand` (`src/real/agents/{claude,codex,cursor}.ts`), checked by preflight (`staleSkills`, `REQUIRED_SKILLS`) | **No.** Must stay in `~/.claude`, regardless of Operator choice |
| `sandcastle-run` skill, `commands/sandcastle-run.md`, `commands/{polish,review}.md` | the **Operator's own** agent CLI (Orchestrator Agent) | `~/.claude` only | **Yes.** This is all the choice affects |

So the choice is "which agent CLI does the Operator drive sandcastle from", not "which provider runs stages" (that is `.sandcastle/config.json` `agents`, `PROVIDER_NAMES = claude|codex|cursor`). Keep the two concepts separate in naming: flag `--operator=` is clearer than `--provider=` (which collides with `agents.default.provider`). Open question 1.

## Provider facts (primary docs)

Codex (developers.openai.com/codex/skills -> learn.chatgpt.com/docs/build-skills, /docs/custom-prompts):
- Skills: user `$HOME/.agents/skills`, repo `.agents/skills`, admin `/etc/codex/skills`. Docs do not list `~/.codex/skills` or `~/.claude/skills`. `SKILL.md` needs `name` + `description` (same as Claude). Invoke `/skills` or `$name`; implicit by description. Optional `agents/openai.yaml` (`policy.allow_implicit_invocation`).
- Custom prompts: `~/.codex/prompts/*.md` (top level only), frontmatter `description`, `argument-hint`, args `$1..$9`/`$ARGUMENTS`, invoked `/prompts:<name>`. **Deprecated**, docs say use skills.
- Matches existing code: `codex.ts` already links container `~/.agents/skills`.

Cursor (cursor.com/docs/context/skills):
- Skills: `~/.agents/skills`, `~/.cursor/skills`, project `.agents/skills`, `.cursor/skills`. **Also loads `~/.claude/skills` and `~/.codex/skills`.** Frontmatter `name` (must equal folder) + `description`; optional `disable-model-invocation: true` = only via `/skill-name`.
- Commands: docs page I could fetch only says `/migrate-to-skills` (Cursor 2.4+) converts user and workspace slash commands into skills. Command file location/format NOT verified from primary docs (the commands page was not reachable). Treat commands as legacy; ship as a skill.

Claude Code: `~/.claude/skills/<n>/SKILL.md`, `~/.claude/commands/<n>.md` (current behaviour, unchanged). Not re-fetched; existing ADR 0003 is the source.

## Proposed CLI UX

- `sandcastle skills install [--operator=claude|codex|cursor[,..]|all] [--check] [--force] [--target=<dir>]`
- `sandcastle init` accepts the same `--operator`.
- Resolution order: flag > saved choice > prompt (TTY only) > default `claude`.
- Prompt: TTY only, multi-select (a person may use two CLIs), default = claude. Non-TTY / CI / `--yes`: no prompt, use saved or default `claude` (keeps today's behaviour, no hang).
- Save choice in `~/.sandcastle/` user config (not the project config: it is per person, not per repo). Alternative: derive from which of `~/.claude`, `~/.codex`, `~/.cursor` exist. Open question 2.
- `--check` stays provider-aware: checks only chosen targets; preflight keeps checking `~/.claude` for the required stage skills (unchanged).

## Per-provider install target + format

Stage skills: always `~/.claude/skills` (unchanged, every provider, required).

Operator artifacts, by choice:

| Operator | `sandcastle-run` skill | Command `/sandcastle-run N` | Conversion |
|---|---|---|---|
| claude | `~/.claude/skills/sandcastle-run` | `~/.claude/commands/sandcastle-run.md` | none (today) |
| codex | `~/.agents/skills/sandcastle-run` | none; invoke `$sandcastle-run` (prompts deprecated) | fold command checklist + `$ARGUMENTS` text into SKILL.md; drop `argument-hint` |
| cursor | already visible via `~/.claude/skills`; install to `~/.cursor/skills/sandcastle-run` anyway so it works if Claude dir is absent | none; `/sandcastle-run` works as a skill | same SKILL.md; optionally `disable-model-invocation: false` default |

Also: `commands/polish.md` and `review.md` are Claude slash commands; codex/cursor do not need them (stages tell codex to run passes itself, see README). Install only for claude.

Shared neutral source: make `skills/sandcastle-run/SKILL.md` provider-neutral (no `Skill` tool, `$ARGUMENTS`, or "Claude Code" wording; PR #37 added provider-aware auth text but body still Claude-flavoured), and keep `commands/sandcastle-run.md` as a thin Claude-only wrapper pointing at the skill. Then conversion is just a copy to a different root, no templating. Only fall back to a small per-provider frontmatter transform if a real difference appears (YAGNI).

## Code shape (deep module)

Generalise `SkillEntry` with a `home` (target root) per entry rather than the single `claudeDir`:
- `discoverEntries(sourceRoot, targets)` where `targets = { stageHome: ~/.claude, operatorHomes: Record<Operator, dir> }`.
- Manifest: one `.sandcastle-installed.json` per home dir (same as today), keyed `skills/<name>`. No cross-home collision, so check/force/modified-skip carry over unchanged: per entry digest compare vs source and vs manifest; `modified` kept unless `--force`; `--check` fails on missing/outdated only.
- Edge: Cursor reads `~/.claude/skills` AND `~/.cursor/skills`, so same skill twice. Cursor dedupe behaviour unverified; safest is for cursor choice to install only into `~/.claude` (already done) and skip `~/.cursor/skills`. Open question 3.

## ADR?

Yes, short ADR 0005: "Operator provider vs stage provider; stage skills always in `~/.claude`". It amends ADR 0003 (which says `~/.claude/skills` and `~/.claude/commands` only) and records why the choice does not move required skills (container hydrate + preflight depend on it). Update README Agent skills table + CONTEXT.md glossary ("Operator provider"?).

## Test plan (critical paths only)

Extend `tests/skills/install.test.ts` with temp dirs:
1. codex choice installs `sandcastle-run` to `<home>/.agents/skills`, stage skills still in `~/.claude`, no command file.
2. claude choice identical to today (regression).
3. modified copy in the codex home is skipped; `--force` overwrites; `--check` per-home states.
4. Resolution: flag beats saved beats default; non-TTY never prompts.
No real home writes: all via `--target`-style injected roots. Prompt UI untested beyond resolution logic.

## PR breakdown (each to dev, squash)

1. `docs: operator provider ADR 0005 + glossary` (this plan's decisions, after user answers).
2. `refactor: skill entries carry their target home` (no behaviour change, tests green).
3. `feat: provider-neutral sandcastle-run skill` (rewrite body, thin claude command).
4. `feat: --operator flag on skills install and init` (codex + cursor targets, check/force).
5. `feat: operator prompt + saved choice` (TTY multi-select, non-interactive default).
6. `docs: README skills table per operator`.

## Unresolved questions

1. Flag name: `--operator=` (recommended, avoids clash with `agents.default.provider`) or `--provider=`?
2. Remember choice: user config file, infer from existing `~/.codex`/`~/.cursor`, or ask every time?
3. Cursor: install to `~/.cursor/skills` or rely on its `~/.claude/skills` compat (avoids duplicates)? Needs a quick manual check in Cursor.
4. Cursor commands: OK to skip command files (legacy, replaced by skills)? I could not verify `~/.cursor/commands` format from docs.
5. Codex: skills only (`$sandcastle-run`) and skip deprecated `~/.codex/prompts`? Recommended yes.
6. Should codex/cursor also get stage skills in their own home, or is `~/.claude` as the single source fine (current mounts read only there)? Recommended: single source.
7. Multi-select default when TTY and nothing saved: claude only, or pre-tick detected CLIs?
8. Is a new `sandcastle-run` neutral rewrite acceptable even if it loses Claude-specific tool hints (e.g. `Skill` tool)?
