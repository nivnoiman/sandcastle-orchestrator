import { itemBranch } from "../engine/engine.js";
import { auditedStageIndex, resumePlacement, type ResumeEvidence } from "../engine/resume.js";
import type { StageLabel } from "../engine/adapters.js";
import { activeStageChain, type StageSpec } from "../engine/stageChain.js";
import type { RunModel, TargetRepo } from "../model/runModel.js";
import type { PullRequestRef } from "./ghClient.js";
import { hasPrSection, reworkBriefsIn } from "./stageAudit.js";
import { messageOf } from "../messageOf.js";

export interface ResumeEvidenceSources {
  stageLabels(itemNumber: number): StageLabel[];
  remoteRefExists(repo: TargetRepo, branch: string): boolean;
  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined;
  warn(itemNumber: number, message: string): void;
}

export function collectResumeEvidence(
  model: RunModel,
  sources: ResumeEvidenceSources,
  chain: readonly StageSpec[] = activeStageChain(),
): ResumeEvidence[] {
  const evidence: ResumeEvidence[] = [];
  for (const item of model.items) {
    if (item.admission === "done") continue;
    const branch = itemBranch(item);
    const stageLabels = sources.stageLabels(item.number);
    const branchExists = sources.remoteRefExists(item.repo, branch);
    const pullRequest = branchExists ? sources.findPullRequest(item.repo, branch, model.integrationBranch) : undefined;
    const body = pullRequest?.body;
    const reworkBriefs = reworkBriefsIn(body ?? "");
    const entry: ResumeEvidence = {
      itemNumber: item.number,
      stageLabels,
      branchExists,
      pullRequestExists: pullRequest !== undefined,
      pullRequestMerged: false,
      auditedStageIndex: auditedStageIndex(body, hasPrSection, reworkBriefs.at(-1)?.round ?? 0, chain),
      reworkBriefs,
    };
    evidence.push(trustable(entry, item.admission, sources, chain));
  }
  return evidence;
}

function trustable(
  entry: ResumeEvidence,
  admission: RunModel["items"][number]["admission"],
  sources: ResumeEvidenceSources,
  chain: readonly StageSpec[],
): ResumeEvidence {
  try {
    resumePlacement(entry, admission, chain);
    return entry;
  } catch (cause) {
    sources.warn(
      entry.itemNumber,
      `stage labels [${entry.stageLabels.join(", ")}] cannot be resumed from (${messageOf(cause)}) — placing it from its pull request instead`,
    );
    return { ...entry, stageLabels: [] };
  }
}
