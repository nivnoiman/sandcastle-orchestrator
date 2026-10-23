import { boundedTail, fencedBlock } from "../../markdown.js";
import type { ComposeService } from "./composeHarness.js";
import { scenarioLines, type ScenarioCounts } from "./verdict.js";

export const FEATURE_PARKED_SENTINEL = "<!-- sandcastle:feature-parked -->";
const FEATURE_REWORK_SENTINEL = /<!-- sandcastle:feature-rework=(\d+) -->/;
const FEATURE_FIX_SENTINEL = /<!-- sandcastle:feature-fix=(\d+) -->/;
const STORY_REPORT_LIMIT = 6000;

export interface FeatureRound {
  round: number;
  limit: number;
}

export interface FeatureFixBrief {
  round: number;
  story: string;
  fix: string | undefined;
}

export function featureReworkSentinel(round: number): string {
  return `<!-- sandcastle:feature-rework=${round} -->`;
}

export function featureFixSentinel(round: number): string {
  return `<!-- sandcastle:feature-fix=${round} -->`;
}

export function featureRoundTitle(round: FeatureRound): string {
  return `fix round ${round.round}/${round.limit}`;
}

export interface FeatureStoryInput {
  integrationBranch: string;
  counts: ScenarioCounts;
  report: string;
  services: readonly ComposeService[];
}

export function featureReworkStory(input: FeatureStoryInput): string {
  const failing = scenarioLines(input.report)
    .filter((scenario) => scenario.kind === "fail")
    .map((scenario) => scenario.line.trim());
  const built = input.services.map((service) => `\`${service.repo}\` from \`${service.ref}\``).join(", ");
  return [
    "### What happened",
    `Feature Verify built ${built || "the integration branch"} in a throwaway environment, derived scenarios from the parent spec and every sub-issue's acceptance criteria, and ran them: ${input.counts.pass} PASS, ${input.counts.fail} FAIL, ${input.counts.requiresStg} REQUIRES-STG.`,
    "",
    "### Failing scenarios",
    ...failing,
    "",
    "### Why it matters",
    `No \`${input.integrationBranch}\` → \`dev\` pull request opens while a scenario fails. Every Work Item already passed its own verify gate, so these failures are cross-slice: they live where the slices meet.`,
    "",
    "### Evidence — the Feature Verify report",
    fencedBlock(boundedTail(input.report, STORY_REPORT_LIMIT), "markdown"),
    "",
    "### What a fix must achieve",
    "Every FAIL scenario above passes on the integration branch and every PASS scenario keeps passing. REQUIRES-STG scenarios are out of scope: never stub or fake a provider. Fix the code, not the scenario.",
  ].join("\n");
}

export function featureReworkSection(round: FeatureRound, story: string): string {
  return [
    `### Sent back — ${featureRoundTitle(round)}`,
    "sandcastle hands this report to one fix agent per involved repo on the integration branch, re-runs the merge checks, pushes what stays green and runs Feature Verify again.",
    "",
    featureReworkSentinel(round.round),
    story.trim(),
  ].join("\n");
}

export function featureFixComment(round: FeatureRound, lines: readonly string[]): string {
  return [`## Feature Verify ${featureRoundTitle(round)} — result`, "", featureFixSentinel(round.round), ...lines].join("\n");
}

function textAfter(body: string, pattern: RegExp): { round: number; text: string } | undefined {
  const match = pattern.exec(body);
  if (!match) return undefined;
  return { round: Number(match[1]), text: body.slice(match.index + match[0].length).trim() };
}

export function featureBriefsIn(comments: readonly string[]): FeatureFixBrief[] {
  const lastPark = comments.reduce((found, body, index) => (body.includes(FEATURE_PARKED_SENTINEL) ? index : found), -1);
  const briefs: FeatureFixBrief[] = [];
  for (const body of comments.slice(lastPark + 1)) {
    const rework = textAfter(body, FEATURE_REWORK_SENTINEL);
    if (rework) {
      briefs.push({ round: rework.round, story: rework.text, fix: undefined });
      continue;
    }
    const fix = textAfter(body, FEATURE_FIX_SENTINEL);
    const brief = fix ? [...briefs].reverse().find((candidate) => candidate.round === fix.round) : undefined;
    if (fix && brief) brief.fix = fix.text;
  }
  return briefs;
}
