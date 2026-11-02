import type { Express, Request, Response } from "express";
import { messageOf } from "../messageOf.js";
import { activeProject, readProjectConfig, setActiveProject, type ProjectConfig } from "../project/projectConfig.js";
import { DEFAULT_MODEL, DEFAULT_REVIEW_MODEL, readOrchestratorEnv, resolveLayout } from "../real/env.js";
import { nodeFileSystem } from "../real/fileSystem.js";
import type { ClaudeDefaultModels } from "../project/stageModels.js";
import { StagePromptError, stagePromptOf } from "./stagePrompt.js";
import { parseStageEdits, saveStageEdits, stagesViewOf } from "../project/stagesEditor.js";

export interface StagesRouteDeps {
  configPath: string;
  activate(project: ProjectConfig): void;
  /** Read per request, so an edit to .env.orchestrator shows on refresh. */
  claudeDefaults(): ClaudeDefaultModels;
}

/** The models claude runs with when nothing pins one, as the engine reads them; `null` when the env layers cannot be read. */
function envClaudeDefaults(): ClaudeDefaultModels {
  try {
    const { values } = readOrchestratorEnv(nodeFileSystem, resolveLayout(nodeFileSystem));
    return { main: values["SANDCASTLE_MODEL"] || DEFAULT_MODEL, review: values["SANDCASTLE_REVIEW_MODEL"] || DEFAULT_REVIEW_MODEL };
  } catch {
    return { main: null, review: null };
  }
}

export function defaultStagesRouteDeps(configPath: string): StagesRouteDeps {
  return { configPath, claudeDefaults: envClaudeDefaults, activate: (project) => setActiveProject({ ...activeProject(), agents: project.agents, stages: project.stages }) };
}

function reply(response: Response, run: () => unknown): void {
  try {
    response.json({ ok: true, result: run() });
  } catch (cause) {
    response.status(400).json({ ok: false, error: messageOf(cause) });
  }
}

function editsOf(request: Request): unknown {
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null) throw new Error('expected a JSON body with "stages"');
  return (body as Record<string, unknown>)["stages"];
}

/**
 * `/api/stages` (under `/api/` so the Dashboard proxy reaches it). Reads always come from the file, so a hand edit shows up on refresh.
 * Mount after `express.json()`.
 */
export function mountStagesRoutes(app: Express, deps: StagesRouteDeps): void {
  app.get("/api/stages", (_request, response) => {
    reply(response, () => stagesViewOf(readProjectConfig(deps.configPath), deps.claudeDefaults()));
  });

  app.get("/api/stages/prompt", (request, response) => {
    const name = request.query["name"];
    try {
      if (typeof name !== "string") throw new StagePromptError("expected ?name=<stage>", 400);
      response.json({ ok: true, result: stagePromptOf(readProjectConfig(deps.configPath), name) });
    } catch (cause) {
      response.status(cause instanceof StagePromptError ? cause.status : 400).json({ ok: false, error: messageOf(cause) });
    }
  });

  app.post("/api/stages/reload", (_request, response) => {
    reply(response, () => {
      const project = readProjectConfig(deps.configPath);
      deps.activate(project);
      return stagesViewOf(project, deps.claudeDefaults());
    });
  });

  app.put("/api/stages", (request, response) => {
    reply(response, () => {
      const project = saveStageEdits(deps.configPath, parseStageEdits(editsOf(request)));
      deps.activate(project);
      return stagesViewOf(project, deps.claudeDefaults());
    });
  });
}
