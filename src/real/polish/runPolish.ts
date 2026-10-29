import { boundedTail, fencedBlock } from "../../markdown.js";
import type { RunModel, TargetRepo } from "../../model/runModel.js";
import { involvedRepos } from "../featureVerify/runFeatureVerify.js";
import type { PullRequestRef } from "../ghClient.js";
import { integrationBase, type TrackerKind } from "../../project/projectConfig.js";
import { landAgentWork, type IntegrationHarness } from "../integrationHarness.js";
import { buildPolishPrompt } from "../promptBuilder.js";
import { messageOf } from "../../messageOf.js";

export type PolishPhase = "idle" | "running" | "green" | "reverted" | "skipped";

export const POLISH_SENTINEL = "<!-- sandcastle:polish -->";
export const POLISH_NOTES_FILE = ".sandcastle-polish-notes.md";
export const POLISH_COMMAND_FILES = ["polish.md", "review.md"] as const;
export function polishFixedPoint(): string {
  return `origin/${integrationBase()}`;
}
const EVIDENCE_LIMIT = 3000;

export interface PolishStatus {
  phase: PolishPhase;
  pullRequests: string[];
  reason: string | undefined;
}

export interface PolishGh {
  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined;
  appendToPullRequestBody(repo: TargetRepo, pullRequest: PullRequestRef, addition: string): void;
  commentOnPullRequest(repo: TargetRepo, pullRequest: PullRequestRef, body: string): void;
}

export interface PolishDeps {
  harness: IntegrationHarness;
  gh: PolishGh;
  model: RunModel;
  hubRepo: string;
  tracker?: TrackerKind | undefined;
  log: (message: string) => void;
  warn: (itemNumber: number, message: string) => void;
}

interface PolishTarget {
  repo: TargetRepo;
  pullRequest: PullRequestRef;
}

type PolishResult =
  | { kind: "already" }
  | { kind: "unchanged"; notes: string | undefined }
  | { kind: "polished"; checks: string; subjects: string[]; notes: string | undefined }
  | { kind: "reverted"; reason: string; subjects: string[]; evidence: string | undefined };

export function idlePolish(phase: PolishPhase = "idle", reason?: string): PolishStatus {
  return { phase, pullRequests: [], reason };
}

export function hasPolishSection(body: string): boolean {
  return body.includes(POLISH_SENTINEL);
}

function commitLines(subjects: readonly string[]): string[] {
  return subjects.map((subject) => `- \`${subject}\``);
}

function notesLines(notes: string | undefined): string[] {
  return ["", "Deferred by review (needs a human decision):", notes?.trim() || "_none_"];
}

type RecordedResult = Exclude<PolishResult, { kind: "already" }>;

function outcomeLines(result: RecordedResult): string[] {
  if (result.kind === "polished") {
    return [
      `**Polished** — \`/polish\` (simplify → review+fix → strip comments) ran against \`${polishFixedPoint()}\`; \`${result.checks}\` stayed green afterwards, so its ${result.subjects.length} commit(s) were pushed:`,
      ...commitLines(result.subjects),
      ...notesLines(result.notes),
    ];
  }
  if (result.kind === "unchanged") {
    return [`**No changes** — \`/polish\` ran against \`${polishFixedPoint()}\` and found nothing to change.`, ...notesLines(result.notes)];
  }
  const dropped = result.subjects.length > 0 ? ["", "Dropped commits:", ...commitLines(result.subjects)] : [];
  return [
    `**Reverted** — ${result.reason}. The polish commits were dropped before they reached this branch; it is exactly what Feature Verify tested.`,
    ...dropped,
  ];
}

export function polishSection(result: RecordedResult): string {
  return ["", POLISH_SENTINEL, "## Polish", "", ...outcomeLines(result), ""].join("\n");
}

export function revertedComment(reason: string, evidence: string | undefined): string {
  return [
    `**sandcastle polish reverted** — ${reason}.`,
    "",
    "The polish commits never left the orchestrator's worktree, so this pull request still holds exactly what Feature Verify tested. Nothing is parked; merge it as is or polish by hand.",
    ...(evidence ? ["", "Last output of the checks:", fencedBlock(boundedTail(evidence, EVIDENCE_LIMIT))] : []),
  ].join("\n");
}

async function polishTarget(deps: PolishDeps, target: PolishTarget): Promise<PolishResult> {
  if (hasPolishSection(target.pullRequest.body)) {
    deps.log(`[polish] ${target.repo}: ${target.pullRequest.url} already carries its polish section`);
    return { kind: "already" };
  }
  let notes: string | undefined;
  const outcome = await landAgentWork({
    harness: deps.harness,
    repo: target.repo,
    stage: "polish",
    prompt: (workspace) =>
      buildPolishPrompt({
        feature: deps.model.feature,
        hubRepo: deps.hubRepo,
        ...(deps.tracker ? { tracker: deps.tracker } : {}),
        parentNumber: deps.model.parentNumber,
        repo: target.repo,
        integrationBranch: deps.model.integrationBranch,
        fixedPoint: polishFixedPoint(),
        pullRequestUrl: target.pullRequest.url,
        checks: workspace.checks,
        notesFile: POLISH_NOTES_FILE,
        skillTool: deps.harness.skillTool ?? true,
      }),
    collect: (workspace) => {
      notes = deps.harness.takeFile(workspace, POLISH_NOTES_FILE);
    },
    onLeftovers: (leftovers) =>
      deps.warn(deps.model.parentNumber, `polish ${target.repo}: discarded uncommitted leftovers before the checks — ${leftovers.join(", ")}`),
  });
  if (outcome.kind === "pushed") return { kind: "polished", checks: outcome.checks, subjects: outcome.subjects, notes };
  if (outcome.kind === "unchanged") return { kind: "unchanged", notes };
  return outcome;
}

const RECORD_ATTEMPTS = 2;

function appendSection(deps: PolishDeps, target: PolishTarget, result: RecordedResult): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      deps.gh.appendToPullRequestBody(target.repo, target.pullRequest, polishSection(result));
      return;
    } catch (cause) {
      if (attempt >= RECORD_ATTEMPTS) throw cause;
    }
  }
}

function record(deps: PolishDeps, target: PolishTarget, result: PolishResult): void {
  if (result.kind === "already") return;
  try {
    appendSection(deps, target, result);
  } catch (cause) {
    deps.warn(
      deps.model.parentNumber,
      `polish section could not be written to ${target.pullRequest.url} (${messageOf(cause)}) — a resumed run will polish it again`,
    );
  }
  if (result.kind !== "reverted") return;
  try {
    deps.gh.commentOnPullRequest(target.repo, target.pullRequest, revertedComment(result.reason, result.evidence));
  } catch (cause) {
    deps.warn(deps.model.parentNumber, `polish revert comment could not be posted on ${target.pullRequest.url}: ${messageOf(cause)}`);
  }
}

function openTargets(deps: PolishDeps): PolishTarget[] {
  return involvedRepos(deps.model).flatMap((repo) => {
    const pullRequest = deps.gh.findPullRequest(repo, deps.model.integrationBranch, integrationBase());
    return pullRequest ? [{ repo, pullRequest }] : [];
  });
}

export async function runPolish(deps: PolishDeps): Promise<PolishStatus> {
  const targets = openTargets(deps);
  if (targets.length === 0) {
    return idlePolish("skipped", `no integration → ${integrationBase()} pull request is open`);
  }
  const pullRequests = targets.map((target) => target.pullRequest.url);
  deps.log(`[polish] polishing ${pullRequests.join(", ")}`);

  const results = await Promise.all(
    targets.map(async (target) => {
      const result = await polishTarget(deps, target);
      record(deps, target, result);
      deps.log(`[polish] ${target.repo}: ${result.kind}`);
      return { target, result };
    }),
  );

  const reverted = results.flatMap(({ target, result }) => (result.kind === "reverted" ? [`${target.repo}: ${result.reason}`] : []));
  for (const reason of reverted) deps.warn(deps.model.parentNumber, `polish reverted — ${reason}`);
  if (reverted.length > 0) return { phase: "reverted", pullRequests, reason: reverted.join("; ") };
  if (results.every(({ result }) => result.kind === "already")) {
    return { phase: "skipped", pullRequests, reason: "every pull request was already polished" };
  }
  return { phase: "green", pullRequests, reason: undefined };
}
