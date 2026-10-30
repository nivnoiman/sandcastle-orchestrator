# Stage editor (Board View)

Status: draft. Builds on [configurable-stages.md](configurable-stages.md).

## Goal
Operator edits the stage flow + per-stage model from Board View. No hand-editing `.sandcastle/config.json`. Applies to NEW runs only.

## Facts that shape it
- `config.json` `stages` → `parseStages` → `ProjectConfig.stages` (singleton via `setActiveProject`, read once at boot).
- Engine captures `stages` at construction (`EngineOptions.stages ?? activeStageChain()`); per-run, so a new engine = new chain. OK.
- `OrchestratorConfig` (`loadOrchestratorConfig`, built once in `controlPlane.ts`) copies `project.stages` + `project.agents`. `SandboxRunner` looks specs up by NAME in `deps.config.stages` (`sandboxRunner.ts:476`), `resolveStageAgent` likewise. => stale after a reload; an in-flight run's names could even vanish. Must fix (see Reload).
- `UiState.stages` comes from `activeStageChain()` → board columns. After reload, in-flight run columns would shift. Must be per-run (see Risks).
- Built-in model today: `agents.<role>` in config (develop/simplify/review/…); custom agent stage: own `provider`/`model`. Claude with no model → `SANDCASTLE_MODEL` (main roles) / `SANDCASTLE_REVIEW_MODEL`.
- Existing rules: `develop` first, `verify` last (auto-appended if missing), names unique, kebab ≤30, reserved names, placeholders checked, prompt file must exist.

## Built-in policy
| Stage | Remove | Reorder | Model |
|---|---|---|---|
| develop | NO (rework, salvage, PR-section audit, resume all anchor on it) | NO (must be first) | yes (`agents.develop`) |
| simplify | yes | yes (between develop and verify) | yes (`agents.simplify`) |
| review | yes | yes | yes (`agents.review`) |
| verify | NO (merge gate; always last) | NO | NOT per stage (verify agent = `agents.default`/resolve role; out of scope) |
| custom agent | yes | yes | yes |
| custom command | yes | yes | n/a |

Refusals (clear errors, same code as `validate`): remove/move develop or verify; empty/unknown name; duplicate; reserved; bad model name (`MODEL_NAME`); unknown placeholder; prompt too big (>64 KiB) / empty; unknown provider. Removing review leaves `needsReworkStory` unused — fine; rework sources are generic strings.
Removed `simplify`/`review` while a run's PR has their sections: resume walks the chain from the end by section, so unknown sections are ignored. Verify with an engine test.

## Data / types
New module `src/project/stagesWriter.ts` (+ shared edit shape in `stagesConfig.ts`):
```ts
/** One row the editor sends; the full ordered list replaces `stages` (no patch ops). */
export type StageEdit =
  | { kind: "builtin"; name: BuiltinAgentStage; provider?: ProviderName; model?: string }
  | { kind: "verify" }
  | { kind: "agent"; name: string; prompt: string /* text */; provider?: ProviderName; model?: string }
  | { kind: "command"; name: string; run: string | Record<string,string> };
export interface StagesPut { stages: StageEdit[] }
```
Built-in model rows write to `agents.<role>`; custom agent rows to the stage entry. Prompt text → `.sandcastle/prompts/<name>.md`.
Read model for UI (`GET /api/stages`):
```ts
interface StageView { name; kind; removable: boolean; movable: boolean; promptText?: string; provider?: string; model?: string; effectiveModel: string /* label, e.g. "claude · sonnet" */; run?: ... }
{ ok: true, stages: StageView[], providers: string[], placeholders: string[], appliesTo: "new runs" }
```

## API (Project Server, `src/ui/server.ts`; write needs `x-sandcastle: 1` like others)
- `GET /api/stages` → view above. No credentials in it (no env/secret fields exist in config; assert in test).
- `PUT /api/stages` body `StagesPut` → 200 `{ok:true, stages}`; 400 `{ok:false,error}` (validation, message from `parseStages`/`parseChoice`); 409 never; body cap 256 KiB.
- Slice 2 only: same PUT handles add/edit/remove/reorder (full-list replace keeps one validation path). No per-stage routes.

## Write path
1. Build candidate raw config: read current `config.json` text, JSON.parse, replace `stages` and the `agents.<builtin role>` entries touched; keep all other keys verbatim.
2. Write candidate prompt files to temp names; validate by `parseProjectConfig(candidate, configPath)` with `readText` redirected to pending prompt text (same function `validate`/boot use) — nothing touches disk unless valid.
3. Commit atomically: prompt files (write tmp + rename), then `config.json` (tmp + rename in same dir). Prompt path = `join(projectRoot, ".sandcastle/prompts", name + ".md")`; name already `^[a-z][a-z0-9-]*$` so no traversal; assert `resolve()` stays under the prompts dir anyway.
4. Orphan prompt files from removed stages are left (never delete user files).
5. Concurrency: compare config mtime/hash read at step 1 vs just before rename; mismatch → 400 "config changed on disk, reload".
6. Pretty-print JSON with 2 spaces (check: does today's file use it? scaffold writes it that way).

## Reload (new runs only)
- `ProjectConfig` gets re-read after write → `setActiveProject(next)`.
- `OrchestratorConfig.stages/agents` must become live: make `SandboxRunner`/`resolveStageAgent` resolve from the spec carried on the spawn request (`SpawnStageRequest.spec`), not by name from boot config. In-flight run keeps its engine's chain, so it keeps its specs. Small, contained change; engine tests for "edit while run live".
- `UiState.stages` → per-run: `runs[i].stages` (captured from engine); top-level `stages` = active chain for idle/next run. Board columns use the run's own. (Check how multi-run boards consume `stages` first.)
- UI copy: "Changes apply to runs started after saving. Running runs keep their stages."
- Dashboard (multi-project) just links to the Project Server's Board View; no separate editor.

## UI (Board View, `src/ui/board/view/`)
- New `stages.ts` pure render: `renderStageEditor(view: StagesView, draft: StageDraft): string` (+ `panels.ts` entry point in the rail/drawer). Rows: handle, name, kind chip, model chip, edit/remove/up/down (buttons, no drag in v1). Edit row expands: provider select, model text input (placeholder "default"), prompt textarea (agent) / run input (command), placeholder hint list. Save/Cancel; error banner from API; notice "applies to new runs only".
- Draft state in `model.ts` (client state), save via `projectApi.send("PUT", "/api/stages", ...)`.
- Slice 1: read-only flow + per-stage provider/model override for built-in & custom agent rows (PUT only changes models/provider; order & set locked). Slice 2: add/edit/remove/reorder + prompt text.

## Files
- new `src/project/stagesWriter.ts`, `src/project/stagesView.ts` (view model); edit `stagesConfig.ts` (export removable/movable rules), `projectConfig.ts` (export parse-from-raw reuse — `parseProjectConfig` already), `server.ts` (+2 routes), `controller.ts`/`state.ts` (per-run stages), `sandboxRunner.ts`+`agents/index.ts` (spec on request), `cli/ui.ts` wiring.
- new `src/ui/board/view/stages.ts`, edits `panels.ts`/`model.ts`/`api.ts`/`board.css`.
- tests: `tests/project/stagesWriter.test.ts`, `tests/ui/stagesRoutes.test.ts`, `tests/ui/board/stages.test.ts` (render), engine test (edit while live), `validate` shares code so covered.
- docs: README/config section + this file.

## Plan
1. S1a (M): writer + view + `GET/PUT /api/stages` for models only + tests. Reload plumbing + spec-on-request (M, the risky bit).
2. S1b (M): Board View panel read-only flow + model editing, render tests, screenshot. → PR 1.
3. S2a (M): writer supports full list + prompt files + built-in policy errors. 
4. S2b (M): UI add/edit/remove/reorder, prompt textarea. → PR 2.

## Risks
- Stale boot config in runner/agent resolution (above) — highest.
- Per-run `stages` in UiState touches board columns for parallel parents.
- Windows rename-over-existing: use `renameSync` (atomic replace works on NTFS); fall back error message if file locked.
- `agents.<role>` edits also affect Feature Verify/polish/resolve? No: those are separate roles; only develop/simplify/review rows touch their own key.
- Comments/formatting in config.json are lost if hand-formatted (JSON has none; key order preserved).

## Open decisions
1. Slice split OK (1: models only, 2: structure)? Or one PR?
2. Reorder: buttons only in v1 (recommend) vs drag.
3. Verify model: leave unconfigurable (recommend) vs add `agents.verify`.
4. Command stages editable in UI (`run` string only, no per-repo map) or agent-only in v1? Recommend: edit/remove existing, add string-run only.
5. Prompt files: always `.sandcastle/prompts/<name>.md` (recommend) vs user-chosen path. Edit of an agent stage whose existing `prompt` is elsewhere: write to that existing path if under projectRoot, else refuse.
6. Allow removing simplify/review (recommend yes) — and show a warning when review is removed (no NEEDS-REWORK gate)?
7. Per-run `stages` in `/api/state` (recommend) vs freeze UI chain until idle.
