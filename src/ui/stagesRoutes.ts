import type { Express, Request, Response } from "express";
import { messageOf } from "../messageOf.js";
import { readProjectConfig, setActiveProject, type ProjectConfig } from "../project/projectConfig.js";
import { parseAgentEdits, saveAgentEdits, stagesViewOf } from "../project/stagesEditor.js";

export interface StagesRouteDeps {
  configPath: string;
  /** Makes `project` what new runs are built from; in-flight runs keep their own chain. */
  activate(project: ProjectConfig): void;
}

export function defaultStagesRouteDeps(configPath: string): StagesRouteDeps {
  return { configPath, activate: setActiveProject };
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
  if (typeof body !== "object" || body === null) throw new Error('expected a JSON body with "edits"');
  return (body as Record<string, unknown>)["edits"];
}

/**
 * `/api/stages` (under `/api/` so the Dashboard proxy reaches it). Reads always come from the file, so a hand edit shows up on refresh.
 * Mount after `express.json()`.
 */
export function mountStagesRoutes(app: Express, deps: StagesRouteDeps): void {
  app.get("/api/stages", (_request, response) => {
    reply(response, () => stagesViewOf(readProjectConfig(deps.configPath)));
  });

  app.post("/api/stages/reload", (_request, response) => {
    reply(response, () => {
      const project = readProjectConfig(deps.configPath);
      deps.activate(project);
      return stagesViewOf(project);
    });
  });

  app.put("/api/stages/agents", (request, response) => {
    reply(response, () => {
      const project = saveAgentEdits(deps.configPath, parseAgentEdits(editsOf(request)));
      deps.activate(project);
      return stagesViewOf(project);
    });
  });
}
