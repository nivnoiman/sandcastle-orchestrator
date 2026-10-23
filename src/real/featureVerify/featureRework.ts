import type { RunModel, TargetRepo } from "../../model/runModel.js";
import { landAgentWork, type IntegrationHarness, type LandOutcome } from "../integrationHarness.js";
import { buildFeatureFixPrompt } from "../promptBuilder.js";
import { FEATURE_PARKED_SENTINEL, featureBriefsIn, featureFixComment, type FeatureFixBrief, type FeatureRound } from "./featureBrief.js";
import {
  idleFeatureVerify,
  involvedRepos,
  parkParent,
  type FeatureVerifyIssueOps,
  type FeatureVerifyRun,
  type FeatureVerifyStatus,
} from "./runFeatureVerify.js";
import { messageOf } from "../../messageOf.js";

export const FEATURE_FIX_STAGE = "fvfix";

export interface FeatureFixResult {
  repo: TargetRepo;
  outcome: LandOutcome;
}

export interface FeatureFixDeps {
  harness: IntegrationHarness;
  model: RunModel;
  hubRepo: string;
  briefs: readonly FeatureFixBrief[];
  round: FeatureRound;
  warn: (itemNumber: number, message: string) => void;
}

export async function runFeatureFix(deps: FeatureFixDeps): Promise<FeatureFixResult[]> {
  const repos = involvedRepos(deps.model);
  return Promise.all(
    repos.map(async (repo) => ({
      repo,
      outcome: await landAgentWork({
        harness: deps.harness,
        repo,
        stage: "feature-verify fix",
        prompt: (workspace) =>
          buildFeatureFixPrompt({
            feature: deps.model.feature,
            hubRepo: deps.hubRepo,
            parentNumber: deps.model.parentNumber,
            parentTitle: deps.model.title,
            parentBody: deps.model.parentBody,
            items: deps.model.items,
            repo,
            otherRepos: repos.filter((other) => other !== repo),
            integrationBranch: deps.model.integrationBranch,
            checks: workspace.checks,
            round: deps.round.round,
            limit: deps.round.limit,
            briefs: deps.briefs,
          }),
        onLeftovers: (leftovers) =>
          deps.warn(deps.model.parentNumber, `feature-verify fix ${repo}: discarded uncommitted leftovers before the checks — ${leftovers.join(", ")}`),
      }),
    })),
  );
}

export function fixResultLines(results: readonly FeatureFixResult[]): string[] {
  return results.flatMap(({ repo, outcome }) => {
    if (outcome.kind === "pushed") {
      return [
        `- \`${repo}\`: pushed ${outcome.subjects.length} commit(s) after \`${outcome.checks}\` stayed green`,
        ...outcome.subjects.map((subject) => `  - \`${subject}\``),
      ];
    }
    if (outcome.kind === "unchanged") return [`- \`${repo}\`: no change — the agent found nothing to fix in this repo`];
    return [`- \`${repo}\`: dropped — ${outcome.reason}`];
  });
}

export interface FeatureLoopGh extends FeatureVerifyIssueOps {
  issueComments(itemNumber: number): string[];
}

export interface FeatureLoopDeps {
  gh: FeatureLoopGh;
  model: RunModel;
  limit: number;
  verify: (round: FeatureRound) => Promise<FeatureVerifyRun>;
  fix: (briefs: readonly FeatureFixBrief[], round: FeatureRound) => Promise<FeatureFixResult[]>;
  onStatus: (status: FeatureVerifyStatus) => void;
  log: (message: string) => void;
  warn: (itemNumber: number, message: string) => void;
}

function recordedBriefs(deps: FeatureLoopDeps): FeatureFixBrief[] | string {
  try {
    return featureBriefsIn(deps.gh.issueComments(deps.model.parentNumber));
  } catch (cause) {
    return `could not read earlier fix rounds from the parent: ${messageOf(cause)}`;
  }
}

function recordFix(deps: FeatureLoopDeps, round: FeatureRound, lines: readonly string[], parked: boolean): void {
  const tail = parked
    ? ["", "Nothing landed on the integration branch, so another Feature Verify run would test the same code. The run is parked for a human.", FEATURE_PARKED_SENTINEL]
    : ["", "Feature Verify runs again on the updated integration branch."];
  try {
    deps.gh.comment(deps.model.parentNumber, featureFixComment(round, [...lines, ...tail]));
  } catch (cause) {
    deps.warn(deps.model.parentNumber, `fix round ${round.round} result could not be posted: ${messageOf(cause)}`);
  }
}

export async function runFeatureVerifyLoop(deps: FeatureLoopDeps): Promise<FeatureVerifyStatus> {
  const briefs = recordedBriefs(deps);
  if (typeof briefs === "string") {
    parkParent(deps, deps.model.parentNumber, briefs);
    return { ...idleFeatureVerify("red"), reason: briefs };
  }
  if (briefs.length > 0) deps.log(`[feature-verify] ${briefs.length} fix round(s) already on the parent — continuing from there`);
  for (;;) {
    const round: FeatureRound = { round: briefs.length + 1, limit: deps.limit };
    const reverify = briefs.length > 0 ? { round: briefs.length, limit: deps.limit } : undefined;
    deps.onStatus({ ...idleFeatureVerify("running"), rework: reverify });
    const { story, ...status } = await deps.verify(round);
    if (status.phase !== "fixing" || story === undefined) return status;

    const brief: FeatureFixBrief = { round: round.round, story, fix: undefined };
    briefs.push(brief);
    deps.onStatus(status);
    const results = await deps.fix(briefs, round);
    const lines = fixResultLines(results);
    brief.fix = lines.join("\n");
    const landed = results.some((result) => result.outcome.kind === "pushed");
    recordFix(deps, round, lines, !landed);
    deps.log(`[feature-verify] fix round ${round.round}/${round.limit}: ${landed ? "landed, verifying again" : "landed nothing"}`);
    if (!landed) {
      const reason = `fix round ${round.round}/${round.limit} landed nothing on ${deps.model.integrationBranch}`;
      parkParent(deps, deps.model.parentNumber, reason);
      return { ...status, phase: "red", reason, rework: { round: round.round + 1, limit: round.limit } };
    }
  }
}
