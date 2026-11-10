import type { Express, Request, Response } from "express";
import { messageOf } from "../messageOf.js";
import { integrationBase } from "../project/projectConfig.js";
import { parseDiff, type DiffFile, type ParsedDiff } from "./changes/diff.js";
import { assertRelativePath, ChangesError, type ChangeSource, type ChangesSource, type ChangeTarget, type FileText } from "./changes/source.js";
import type { UiState } from "./state.js";

export interface ChangesRouteDeps {
  source: ChangesSource;
  state(): UiState;
  /** The branch features merge into; read per request. */
  baseBranch?: () => string;
}

export interface ChangesResult {
  source: ChangeSource;
  branch: string;
  base: string;
  files: DiffFile[];
  totals: ParsedDiff["totals"];
  truncated: boolean;
  /** Raw git output hit the byte cap. */
  clipped: boolean;
  /** Lockfile/generated hunks are included. */
  generated: boolean;
  generatedAt: string;
}

/** Item number, else the parent number of a run (Feature lifecycle drawer). */
export function targetOf(state: UiState, number: number, baseBranch: string): ChangeTarget | undefined {
  for (const run of state.runs) {
    const item = run.items.find((candidate) => candidate.number === number);
    if (item) return { repo: item.repo, branch: item.branch, base: run.parent.integrationBranch, pullRequestUrl: item.pullRequestUrl };
  }
  const run = state.runs.find((candidate) => candidate.parent.number === number);
  const repo = run?.items[0]?.repo;
  if (!run || repo === undefined) return undefined;
  return { repo, branch: run.parent.integrationBranch, base: baseBranch, pullRequestUrl: run.featureVerify.pullRequests[0] };
}

function numberOf(request: Request): number {
  const raw = request.query["item"];
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw)) throw new ChangesError("item must be a positive integer");
  return Number(raw);
}

function reply(response: Response, work: () => Promise<unknown>): void {
  work().then(
    (result) => response.json({ ok: true, result }),
    (cause: unknown) => {
      const known = cause instanceof ChangesError;
      if (!known) console.error(`changes: ${messageOf(cause).split("\n")[0]}`);
      response.status(known ? 400 : 500).json({ ok: false, error: known ? cause.message : "could not read the changes" });
    },
  );
}

export function mountChangesRoutes(app: Express, deps: ChangesRouteDeps): void {
  const resolveTarget = (request: Request): ChangeTarget => {
    const target = targetOf(deps.state(), numberOf(request), (deps.baseBranch ?? integrationBase)());
    if (!target) throw new ChangesError("this item is no longer in the run");
    return target;
  };

  app.get("/api/changes", (request, response) => {
    reply(response, async (): Promise<ChangesResult> => {
      const target = resolveTarget(request);
      const generated = request.query["generated"] === "1";
      const raw = await deps.source.diff(target);
      const parsed = parseDiff(raw.text, { includeGenerated: generated });
      return {
        source: raw.source,
        branch: target.branch,
        base: target.base,
        files: parsed.files,
        totals: parsed.totals,
        truncated: parsed.truncated || raw.clipped,
        clipped: raw.clipped,
        generated,
        generatedAt: new Date().toISOString(),
      };
    });
  });

  app.get("/api/changes/file", (request, response) => {
    reply(response, async (): Promise<FileText> => {
      const target = resolveTarget(request);
      const path = request.query["path"];
      if (typeof path !== "string") throw new ChangesError("path is required");
      return deps.source.file(target, assertRelativePath(path));
    });
  });
}
