# Configurable stage chain

Status: approved 2026-10-24.

## Goal

Add, drop or reorder per-item stages from `.sandcastle/config.json`, without code changes. Example: a security agent after review on another provider, and a command check before the verify gate.

No `stages` key means today's chain, byte for byte: `develop -> simplify -> review -> verify`.

## Today (what is hardwired)

| Seam | Where |
|---|---|
| chain | `STAGE_CHAIN`, `AGENT_STAGES`, `StageName`, `AgentStage` (`src/engine/adapters.ts`) |
| scheduling | `Engine.startStage` / `handleStageCompletion` index into `STAGE_CHAIN`; `isAgentStage` = not `verify` (`engine.ts`) |
| labels | `STAGE_LABELS`, `RUNNING_STAGE_LABELS`, `VERIFY_STAGE_LABEL`; real client strips other `sc:*` on set (`ghClient.ts`); `reset.ts` reverts the fixed list |
| crash-resume | `frozenStageIndex` (label to index), `auditedStageIndex` (hardcoded review, simplify, develop sections) (`resume.ts`, `resumeEvidence.ts`) |
| rework | `ReworkSource = "verify" \| "review"`; brief heading parse rejects other sources (`stageAudit.ts`); comment text names the fixed chain (`rework.ts`) |
| prompts | `BUILDERS` / `SALVAGE_BUILDERS` / `FRESH_EYES_SPECS` keyed by `AgentStage` (`promptBuilder.ts`) |
| settlement | `STAGE_COMMIT_TAG`, `STAGE_SECTION_TITLE`, `isFreshEyesStage`, `needsReworkStory` (review only) (`stageAudit.ts`, `sandboxRunner.ts`) |
| agents | `AGENT_ROLES` fixed; `resolveAgent(config, role)` (`agentsConfig.ts`, `agents/index.ts`) |
| UI | `UI_STAGES` hardcoded in `page.html`; `UI_STAGE_CHAIN` (`state.ts`); `--fail=<n>:<stage>` (`cli/ui.ts`); `ATTEMPT_ID` stage is `[a-z]+` (`attemptLog.ts`) |

## Config

```json
"stages": [
  "develop",
  "simplify",
  "review",
  {
    "name": "security",
    "kind": "agent",
    "prompt": ".sandcastle/prompts/security.md",
    "provider": "codex",
    "model": "gpt-5.5-codex"
  },
  {
    "name": "e2e",
    "kind": "command",
    "run": { "web": "pnpm playwright test" }
  },
  "verify"
]
```

Rules (config error at load, naming the entry):

- Order in the array is the order of the chain. There is no `after` field: one way to say where a stage goes.
- `develop` must be first. `verify` must be last; if left out it is appended. `simplify` and `review` are optional.
- A string entry must be a built-in name. Each name appears once.
- Custom `name`: lower-case kebab (`^[a-z][a-z0-9-]*$`), at most 30 characters (it becomes `sc:<name>`, a container name part and a commit scope). Reserved: the built-ins plus `resolve`, `salvage`, `rework`, `queued`, `blocked`, `done`, `needs-human`, `merged`, `feature-verify`, `feature-fix`, `polish`.
- `kind` is required: `"agent"` or `"command"`.
- `agent`: `prompt` required, a path relative to the project root, must exist at load. `provider` / `model` optional, same values as `agents` entries; default `agents.default`. Claude without `model` uses `SANDCASTLE_REVIEW_MODEL`, like the other fresh-eyes stages.
- `command`: `run` required, a string (every repo) or a map `repo -> command`. A repo absent from the map skips the stage for that item (success, with a dashboard note). Map keys must be repos under `repos`.
- `agents.<custom name>` is rejected with a hint to put `provider` / `model` on the stage entry. Built-in roles keep working in `agents`.

Parsed into `ProjectConfig.stages: StageSpec[]`:

```ts
type StageSpec =
  | { name: "develop" | "simplify" | "review"; kind: "builtin-agent" }
  | { name: "verify"; kind: "verify" }
  | { name: string; kind: "agent"; promptPath: string; agent: AgentChoice | undefined }
  | { name: string; kind: "command"; run: string | Record<string, string> };
```

## Engine

- `StageName` becomes `string`. `EngineOptions.stages` (default: `activeProject().stages`, which defaults to the built-in chain). The engine indexes into that list instead of `STAGE_CHAIN`.
- `startStage` dispatches on `kind`:
  - `builtin-agent`, `agent`: today's `startAgentStage` (sync with integration, `sandbox.spawnStage({ stage: name, ... })`).
  - `command`: ensure worktree, then `sandbox.spawnCommandStage({ itemNumber, stage, repo, branch, integrationBranch, command })`. No sync with integration: the verify gate rebases anyway, and a command has no agent to resolve a conflict.
  - `verify`: unchanged.
- Completion handling is unchanged: success advances, failure with `rework` goes back to develop, failure without parks, waiting holds. `verify` success merges (checked by kind, not by name).
- Rework: `ReworkSource` becomes `string` (a stage name). A rework round re-runs the whole configured chain from develop. The rework comment names the configured chain.
- Picking order (`deepest stage first`) is by index, so it carries over.

## Labels

- Built-ins keep their labels (`sc:developing`, `sc:simplifying`, `sc:in-review`, `sc:verifying`).
- A custom stage running: `sc:<name>`.
- `stageLabels(chain)` = the fixed labels plus each custom one. The real client's "strip other stage labels" and `reset` use it.
- Created on demand: the real `GhClient` runs `gh label create sc:<name> --repo <hub> --force --color ... --description "sandcastle stage <name>"` once per process before the first add of a custom label. Preflight checks the host `gh` can do that (it already checks label writes).

## Crash-resume

- `frozenStageIndex(label, chain)`: the stage whose running label matches, as an index into the configured chain.
- A label for a stage no longer in the chain (config changed between runs) throws, and `trustable()` already falls back to the pull request trail with a warning.
- `auditedStageIndex(body, chain, hasSection, round)`: walk the chain from the end; the last non-develop, non-verify stage with its section for the round places the item at the next index. Develop keeps today's rule (round 0: a PR means develop is done; round > 0: needs the develop rework section). Default chain gives the same answers as today.
- Command stages leave a trail too: on green the orchestrator appends a section to the PR body:

  ```
  <!-- sandcastle:e2e -->
  ## e2e
  `pnpm playwright test` passed.
  ```

  So a restart after a green command stage resumes at the next stage instead of re-running it.

## Custom agent stage

- Fresh container, bootstrap, agent on the provider from the stage entry. Same idle timeout and salvage flow as simplify / review.
- Prompt: the fresh-eyes frame (`sharedHeader`: issue spec, required reading, memories, environment; what is on the branch; rework history; commit, section, push, stop; hard rules) with the user's file as the method, inside `<stage-instructions>` in place of "read the skill". Contract step 2 becomes "Do what the stage instructions ask" and step 3 keeps "apply every finding, commit".
- Placeholders in the prompt file: `{{issue}}` (`owner/hub#n`), `{{issueNumber}}`, `{{title}}`, `{{repo}}`, `{{branch}}`, `{{integrationBranch}}`, `{{feature}}`, `{{stage}}`, `{{round}}`. An unknown placeholder is a config error at load, and fails the stage if the file changed since.
- The file is read on every spawn, so edits apply to the next stage start.
- Commit tag `fix(<name>):`. PR section: sentinel `<!-- sandcastle:<name> -->` (rework: `<!-- sandcastle:<name> rework=N -->`), heading `## <name>`.
- Settlement as review: no PR fails; `UNFIXABLE:` parks with the reason; `NEEDS-REWORK:` sends it back to develop with source `<name>`; section present is success; tagged commits without a section get an orchestrator-written section.

## Custom command stage

- Fresh container, `copy` workspace (like the verify gate: the command cannot change the branch), bootstrap, then `run` with the idle timeout. Output is teed to the attempt log.
- Green: append the trail section, success.
- Red: rework round, source `<name>`, story built like `verifyReworkStory` (what ran, last output, commits on the branch, what a fix must achieve). Limit reached parks as today.
- Agent waits do not apply; `transientWaitFrom` does (network, bootstrap).

## Agents

- `resolveStageAgent(config, spec)`: built-in roles go through `resolveAgent` as today; a custom agent stage uses its own choice, else `agents.default`.
- `agentsInUse` includes custom agent stages, so the auth probe, preflight egress and the refresh gate cover their providers.

## UI and CLI

- `UiState.stages: string[]` (the chain names). `page.html` draws `queued, ...stages, merged` from it instead of `UI_STAGES`.
- `ATTEMPT_ID` and the garbage-collected container name pattern accept kebab stage names with digits (`x-check`, `e2e`).
- `--fail=<n>:<stage>` (paced dry-run) validates against the configured chain.
- `sandcastle validate` reports stage config errors (they surface at load). `dry-run` prints custom stages and their labels with no other change.

## Tests

- Config: defaults, ordering rules, names, kinds, prompt existence, placeholders, `run` map keys, `agents.<custom>` rejection.
- Engine: a custom agent stage and a command stage scheduled in order; labels `sc:security`, `sc:e2e`; command red sends back to develop with its source; `NEEDS-REWORK` from a custom stage; default chain unchanged (existing tests untouched).
- Resume: label to index for custom stages; unknown custom label falls back; audit trail through a custom agent section and a command trail section.
- Prompts: custom agent prompt frame, placeholder substitution, section marker and commit tag; salvage variant.
- Settlement: custom agent `NEEDS-REWORK` / `UNFIXABLE` / orphaned commits; command green appends the trail, red returns a rework.
- Labels: `stageLabels`, on-demand creation once, reset covers custom labels.
- Dry-run with a project that declares both custom kinds.

## Out of scope

- Parallel stages (two stages at the same index).
- Conditional stages (by label, path or repo), except the per-repo `run` map.
- Custom stages after `verify` or before `develop`; custom Feature Verify or polish steps.
- Command stages that commit.

## Work plan

1. `src/project/stagesConfig.ts` + `ProjectConfig.stages` + tests.
2. Engine, adapters, rework, resume generalized; fakes + dry-runner; engine and resume tests.
3. Labels: `stageLabels`, real client on-demand creation, reset.
4. Prompts and settlement for custom agent stages; command stage runner in `DockerSandboxRunner`; tests.
5. Agents resolution and `agentsInUse`; UI state, page, `--fail`, `ATTEMPT_ID`.
6. README Configuration section, `docs/internals.md` pointer, polish, PR to `main`.

## Decisions for the owner

1. Order is positional only; no `after` field.
2. `simplify` and `review` may be dropped; `develop` first and `verify` last stay mandatory.
3. Command stages run without syncing to the integration branch, on a copied workspace, and leave a PR trail section on green.
4. Custom agent stages can commit fixes (like review). A read-only mode is not built.
5. Provider and model for a custom stage live on the stage entry, not under `agents`.

## Changes during implementation

- No `title` field: a custom stage's PR heading is `## <name>`. Section headings are read in settlement and salvage without the stage entry at hand, so one source (the name) keeps them consistent.
- The real `GhClient` and `reset` treat every `sc:*` label as the orchestrator's, so labels of a custom stage removed from the config still get stripped.
