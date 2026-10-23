import type { Admission } from "../model/runModel.js";
import {
  agentStageForLabel,
  STAGE_CHAIN,
  VERIFY_STAGE_LABEL,
  type AgentStage,
  type ReworkBrief,
  type StageLabel,
} from "./adapters.js";

export interface ResumeEvidence {
  itemNumber: number;
  stageLabels: StageLabel[];
  branchExists: boolean;
  pullRequestExists: boolean;
  pullRequestMerged: boolean;
  auditedStageIndex: number;
  reworkBriefs?: ReworkBrief[];
}

export type ResumePlacement =
  | { kind: "done" }
  | { kind: "recompute" }
  | { kind: "parked"; stageIndex: number; parkReason: string | undefined }
  | { kind: "resume"; stageIndex: number; wasParked: boolean };

const RECOMPUTE_LABELS: readonly StageLabel[] = ["sc:queued", "sc:blocked"];

const STRANDED_REASON =
  "its branch is gone from git but its pull request never merged — sandcastle will not re-run a stage on a branch that no longer exists";

function frozenStageIndex(itemNumber: number, label: StageLabel): number {
  if (label === VERIFY_STAGE_LABEL) return STAGE_CHAIN.indexOf("verify");
  const stage = agentStageForLabel(label);
  if (!stage) throw new Error(`#${itemNumber}: "${label}" is not a stage the chain can resume from`);
  const index = STAGE_CHAIN.indexOf(stage);
  if (index === -1) throw new Error(`#${itemNumber}: stage "${stage}" is not part of the stage chain`);
  return index;
}

function placementFromLabels(evidence: ResumeEvidence, admission: Admission): ResumePlacement {
  const itemNumber = evidence.itemNumber;
  if (evidence.stageLabels.length === 0) return { kind: "recompute" };
  const parked = evidence.stageLabels.includes("sc:needs-human");
  const frozenLabels = evidence.stageLabels.filter((label) => label !== "sc:needs-human");
  if (frozenLabels.length > 1) {
    throw new Error(`#${itemNumber}: resume evidence carries conflicting stage labels [${frozenLabels.join(", ")}]`);
  }
  const frozenLabel = frozenLabels[0];
  if (parked) {
    if (!frozenLabel) {
      throw new Error(`#${itemNumber}: sc:needs-human without the frozen stage label it died at`);
    }
    const stageIndex = frozenStageIndex(itemNumber, frozenLabel);
    return admission === "queued"
      ? { kind: "resume", stageIndex, wasParked: true }
      : { kind: "parked", stageIndex, parkReason: undefined };
  }
  if (!frozenLabel) throw new Error(`#${itemNumber}: resume evidence carries no sc:* label`);
  if (frozenLabel === "sc:done") return { kind: "done" };
  if (RECOMPUTE_LABELS.includes(frozenLabel)) return { kind: "recompute" };
  return { kind: "resume", stageIndex: frozenStageIndex(itemNumber, frozenLabel), wasParked: false };
}

function stageIndexOf(placement: ResumePlacement): number {
  return "stageIndex" in placement ? placement.stageIndex : 0;
}

function raiseToAuditTrail(placement: ResumePlacement, auditedStageIndex: number, admission: Admission): ResumePlacement {
  if (auditedStageIndex <= 0) return placement;
  if (placement.kind === "recompute") {
    if (admission !== "queued") return placement;
    return { kind: "resume", stageIndex: auditedStageIndex, wasParked: false };
  }
  if (placement.kind === "done") return placement;
  return { ...placement, stageIndex: Math.max(placement.stageIndex, auditedStageIndex) };
}

export function auditedStageIndex(
  pullRequestBody: string | undefined,
  hasSection: (body: string, stage: AgentStage, round: number) => boolean,
  round = 0,
): number {
  if (pullRequestBody === undefined) return 0;
  if (hasSection(pullRequestBody, "review", round)) return STAGE_CHAIN.indexOf("verify");
  if (hasSection(pullRequestBody, "simplify", round)) return STAGE_CHAIN.indexOf("review");
  if (round === 0 || hasSection(pullRequestBody, "develop", round)) return STAGE_CHAIN.indexOf("simplify");
  return 0;
}

export function resumePlacement(evidence: ResumeEvidence, admission: Admission): ResumePlacement {
  if (evidence.pullRequestMerged) return { kind: "done" };
  if (admission === "done") return { kind: "done" };
  const placement = raiseToAuditTrail(placementFromLabels(evidence, admission), evidence.auditedStageIndex, admission);
  if (evidence.branchExists || !evidence.pullRequestExists) return placement;
  if (placement.kind === "done") return placement;
  return { kind: "parked", stageIndex: stageIndexOf(placement), parkReason: STRANDED_REASON };
}
