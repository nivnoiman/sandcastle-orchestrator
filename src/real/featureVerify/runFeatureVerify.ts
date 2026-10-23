import { fencedBlock } from "../../markdown.js";
import type { RunModel, TargetRepo } from "../../model/runModel.js";
import { hubIssueUrl, type FeatureVerifyPullRequests, type PullRequestRef } from "../ghClient.js";
import { buildFeatureVerifyPrompt } from "../promptBuilder.js";
import { integrationBase } from "../../project/projectConfig.js";
import type { ComposeFacts, ComposeService, VerifyHarness } from "./composeHarness.js";
import { FEATURE_PARKED_SENTINEL, featureReworkSection, featureReworkStory, type FeatureRound } from "./featureBrief.js";
import {
  countsLine,
  readVerdict,
  scenarioLines,
  truncateReport,
  PR_BODY_REPORT_LIMIT,
  type ScenarioCounts,
  type VerifyOutcome,
} from "./verdict.js";
import { messageOf } from "../../messageOf.js";

export type FeatureVerifyPhase = "idle" | "waiting" | "running" | "fixing" | "green" | "red" | "skipped";

export const HUMAN_LABEL = "ready-for-human";
export const PARK_LABEL = "sc:needs-human";

export interface FeatureVerifyStatus {
  phase: FeatureVerifyPhase;
  counts: ScenarioCounts;
  reason: string | undefined;
  pullRequests: string[];
  rework?: FeatureRound | undefined;
}

export interface FeatureVerifyRun extends FeatureVerifyStatus {
  story?: string | undefined;
}

export interface FeatureVerifyIssueOps {
  comment(itemNumber: number, body: string): void;
  addLabel(itemNumber: number, label: string): void;
  removeLabel(itemNumber: number, label: string): void;
}

export type FeatureVerifyGh = FeatureVerifyIssueOps & FeatureVerifyPullRequests;

export interface FeatureVerifyDeps {
  harness: VerifyHarness;
  gh: FeatureVerifyGh;
  model: RunModel;
  hubRepo: string;
  rework?: FeatureRound | undefined;
  log: (message: string) => void;
  warn: (itemNumber: number, message: string) => void;
}

export function idleFeatureVerify(phase: FeatureVerifyPhase = "idle"): FeatureVerifyStatus {
  return { phase, counts: { pass: 0, fail: 0, requiresStg: 0 }, reason: undefined, pullRequests: [] };
}

export function involvedRepos(model: RunModel): TargetRepo[] {
  return [...new Set(model.items.map((item) => item.repo))].sort();
}

export function featurePullRequestTitle(model: RunModel): string {
  return `feat: ${model.feature}`;
}

export function builtFromLines(services: readonly ComposeService[]): string[] {
  if (services.length === 0) return ["- _the environment never came up, so nothing was built_"];
  return services.map((service) => `- \`${service.repo}\` — built from \`${service.ref}\``);
}

export function reportSection(report: string | undefined): string[] {
  if (!report || report.trim().length === 0) return ["_the verify agent wrote no report_"];
  return [fencedBlock(truncateReport(report, PR_BODY_REPORT_LIMIT), "markdown")];
}

export interface FeaturePullRequestBodyInput {
  model: RunModel;
  hubRepo: string;
  environment?: string | undefined;
  outcome: VerifyOutcome;
  report: string;
  services: readonly ComposeService[];
}

export function featurePullRequestBody(input: FeaturePullRequestBodyInput): string {
  const { model, outcome } = input;
  return [
    "## What changed",
    `The "${model.feature}" feature — ${model.items.length} Work Item(s) merged into \`${model.integrationBranch}\` through sandcastle's per-item verify gate.`,
    `Parent orchestration issue: ${hubIssueUrl(input.hubRepo, model.parentNumber)}`,
    "",
    "## How tested",
    `Feature Verify ran once against ${input.environment ?? "a throwaway environment"}.`,
    "",
    "Built from:",
    ...builtFromLines(input.services),
    "",
    `Result: ${countsLine(outcome.counts)}.`,
    "",
    "<details><summary>Feature Verify report</summary>",
    "",
    ...reportSection(input.report),
    "",
    "</details>",
    "",
    "## Residual manual checks",
    requiresStgChecklist(input.report),
    "",
    "---",
    `A human merges this pull request. sandcastle never merges into \`${integrationBase()}\`.`,
  ].join("\n");
}

export function requiresStgChecklist(report: string): string {
  const lines = scenarioLines(report)
    .filter((scenario) => scenario.kind === "requiresStg")
    .map((scenario) => `- [ ] ${scenario.line.replace(/^[ \t]*[-*+][ \t]*/, "")}`);
  return lines.length > 0 ? lines.join("\n") : "_none — no scenario needed an external provider_";
}

interface VerifyCommentOptions {
  model: RunModel;
  hubRepo: string;
  environment?: string | undefined;
  outcome: VerifyOutcome;
  report: string | undefined;
  services: readonly ComposeService[];
  pullRequests: readonly string[];
  prFailures: readonly string[];
  sendBack?: { round: FeatureRound; story: string } | undefined;
  roundsUsed?: number;
}

function verdictTail(options: VerifyCommentOptions): string[] {
  const { model, outcome } = options;
  if (outcome.verdict === "green") {
    return [
      `### Integration → ${integrationBase()} pull requests`,
      ...(options.pullRequests.length > 0
        ? options.pullRequests.map((url) => `- ${url}`)
        : ["_none opened — see the warnings below_"]),
      ...options.prFailures.map((failure) => `- :warning: ${failure}`),
      "",
      "A human merges those pull requests. sandcastle stops here.",
    ];
  }
  if (options.sendBack) return [featureReworkSection(options.sendBack.round, options.sendBack.story)];
  return [
    `This run is parked for human triage: the parent carries \`${PARK_LABEL}\` + \`${HUMAN_LABEL}\` and no \`${model.integrationBranch}\` → \`${integrationBase()}\` pull request was opened.`,
    parkWhy(outcome, options.roundsUsed ?? 0),
    FEATURE_PARKED_SENTINEL,
  ];
}

export function verifyComment(options: VerifyCommentOptions): string {
  const { model, outcome } = options;
  const verdictLine =
    outcome.verdict === "green"
      ? `**Feature Verify: GREEN** — ${countsLine(outcome.counts)}`
      : `**Feature Verify: RED** — ${outcome.reason ?? "the verify stage did not produce a usable result"} (${countsLine(outcome.counts)})`;
  const tail = verdictTail(options);

  return [
    `## Feature Verify — ${model.feature}`,
    "",
    verdictLine,
    "",
    `Environment: ${options.environment ?? "the verify environment never came up"}. Everything was torn down after the run.`,
    "",
    "Built from:",
    ...builtFromLines(options.services),
    "",
    "---",
    "",
    options.report ? truncateReport(options.report) : "_the verify agent wrote no report_",
    "",
    "---",
    "",
    ...tail,
  ].join("\n");
}

function parkWhy(outcome: VerifyOutcome, roundsUsed: number): string {
  if (roundsUsed > 0) return `It stayed red after ${roundsUsed} fix round(s), the limit — a human decides what changes next.`;
  if (outcome.counts.fail === 0) {
    return "No scenario FAILED, so there was nothing to send to a fix round: a missing report, a broken environment or a run that proved nothing needs a human.";
  }
  return "The fix loop is off (limit 0), so a human decides what changes.";
}

interface VerifyRun {
  report: string | undefined;
  environment: string | undefined;
  failure: string | undefined;
  services: readonly ComposeService[];
}

async function collectReport(deps: FeatureVerifyDeps): Promise<VerifyRun> {
  let services: readonly ComposeService[] = [];
  let environment: string | undefined;
  try {
    const facts = await deps.harness.up();
    services = facts.services;
    environment = facts.environment;
    await deps.harness.runAgent(prompt(deps, facts));
    return { report: deps.harness.readReport(), environment, failure: undefined, services };
  } catch (cause) {
    return { report: deps.harness.readReport(), environment, failure: messageOf(cause), services };
  } finally {
    deps.harness.down();
  }
}

function prompt(deps: FeatureVerifyDeps, facts: ComposeFacts): string {
  return buildFeatureVerifyPrompt({
    feature: deps.model.feature,
    hubRepo: deps.hubRepo,
    parentNumber: deps.model.parentNumber,
    parentTitle: deps.model.title,
    parentBody: deps.model.parentBody,
    integrationBranch: deps.model.integrationBranch,
    items: deps.model.items,
    services: facts.services.map((service) => ({
      repo: service.repo,
      baseUrl: service.baseUrl,
      sourcePath: service.sourcePath,
    })),
    mongoUri: facts.mongoUri,
    commands: facts.commands,
    externalProviders: facts.externalProviders,
    reportPath: facts.reportPath,
  });
}

function openIntegrationPullRequest(
  deps: FeatureVerifyDeps,
  repo: TargetRepo,
  outcome: VerifyOutcome,
  report: string,
  services: readonly ComposeService[],
  environment: string | undefined,
): PullRequestRef {
  const existing = deps.gh.findPullRequest(repo, deps.model.integrationBranch, integrationBase());
  if (existing) {
    deps.log(`[feature-verify] ${repo}: ${deps.model.integrationBranch} already has ${existing.url}`);
    return existing;
  }
  return deps.gh.createPullRequest({
    repo,
    branch: deps.model.integrationBranch,
    baseBranch: integrationBase(),
    title: featurePullRequestTitle(deps.model),
    body: featurePullRequestBody({ model: deps.model, hubRepo: deps.hubRepo, environment, outcome, report, services }),
  });
}

export function parkParent(
  deps: { gh: FeatureVerifyIssueOps; warn: (itemNumber: number, message: string) => void },
  parentNumber: number,
  reason: string,
): void {
  deps.gh.addLabel(parentNumber, PARK_LABEL);
  deps.gh.addLabel(parentNumber, HUMAN_LABEL);
  deps.warn(parentNumber, `feature verify RED — ${reason}; parked for human triage`);
}

function settleLabels(deps: FeatureVerifyDeps, outcome: VerifyOutcome): void {
  const { model } = deps;
  if (outcome.verdict === "green") {
    deps.gh.removeLabel(model.parentNumber, PARK_LABEL);
    deps.gh.removeLabel(model.parentNumber, HUMAN_LABEL);
    return;
  }
  parkParent(deps, model.parentNumber, outcome.reason ?? "no usable report");
}

function sendBackRound(deps: FeatureVerifyDeps, outcome: VerifyOutcome, failure: string | undefined): FeatureRound | undefined {
  if (outcome.verdict !== "red" || failure || outcome.counts.fail === 0) return undefined;
  if (!deps.rework || deps.rework.round > deps.rework.limit) return undefined;
  return deps.rework;
}

export async function runFeatureVerify(deps: FeatureVerifyDeps): Promise<FeatureVerifyRun> {
  const { model } = deps;
  deps.log(`[feature-verify] bringing up a throwaway environment for ${model.integrationBranch}`);
  const { report, environment, failure, services } = await collectReport(deps);

  const outcome: VerifyOutcome = failure
    ? { verdict: "red", counts: readVerdict(report).counts, reason: failure }
    : readVerdict(report);

  const pullRequests: string[] = [];
  const prFailures: string[] = [];
  if (outcome.verdict === "green") {
    for (const repo of involvedRepos(model)) {
      try {
        pullRequests.push(openIntegrationPullRequest(deps, repo, outcome, report ?? "", services, environment).url);
      } catch (cause) {
        const detail = `${repo}: could not open ${model.integrationBranch} → ${integrationBase()} — ${messageOf(cause)}`;
        prFailures.push(detail);
        deps.warn(model.parentNumber, detail);
      }
    }
  }

  const round = sendBackRound(deps, outcome, failure);
  const story = round ? featureReworkStory({ integrationBranch: model.integrationBranch, counts: outcome.counts, report: report ?? "", services }) : undefined;
  const sendBack = round && story ? { round, story } : undefined;
  const roundsUsed = deps.rework ? deps.rework.round - 1 : 0;

  try {
    deps.gh.comment(
      model.parentNumber,
      verifyComment({ model, hubRepo: deps.hubRepo, environment, outcome, report, services, pullRequests, prFailures, sendBack, roundsUsed }),
    );
  } catch (cause) {
    deps.warn(model.parentNumber, `feature verify report could not be posted: ${messageOf(cause)}`);
  }

  if (sendBack) {
    deps.log(`[feature-verify] RED — ${countsLine(outcome.counts)}; sending it back for fix round ${sendBack.round.round}/${sendBack.round.limit}`);
    return { phase: "fixing", counts: outcome.counts, reason: outcome.reason, pullRequests, rework: sendBack.round, story: sendBack.story };
  }

  settleLabels(deps, outcome);

  deps.log(
    `[feature-verify] ${outcome.verdict.toUpperCase()} — ${countsLine(outcome.counts)}` +
      (pullRequests.length > 0 ? `; opened ${pullRequests.join(", ")}` : ""),
  );

  return { phase: outcome.verdict, counts: outcome.counts, reason: outcome.reason, pullRequests, rework: deps.rework };
}
