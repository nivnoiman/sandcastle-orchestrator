import { REWORK_SOURCES, type AgentStage, type ReworkBrief, type ReworkSource } from "../engine/adapters.js";
import { reworkHeading } from "../engine/rework.js";

export type FreshEyesStage = Exclude<AgentStage, "develop">;

export const STAGE_COMMIT_TAG: Record<AgentStage, string> = {
  develop: "feat:",
  simplify: "refactor(simplify):",
  review: "fix(review):",
};

export const REWORK_COMMIT_TAG = "fix(rework):";

const STAGE_SECTION_TITLE: Record<FreshEyesStage, string> = {
  simplify: "Simplify",
  review: "Review",
};

const SENTINEL_PREFIX = "<!-- sandcastle:";
const UNFIXABLE_PREFIX = "UNFIXABLE:";
const NEEDS_REWORK_PREFIX = "NEEDS-REWORK:";
const REWORK_BRIEF_SENTINEL = /<!-- sandcastle:rework=(\d+) -->/g;
const REWORK_BRIEF_HEADING = /^## Rework \d+\/\d+ — sent back by (\S+)\s*$/;

export function isFreshEyesStage(stage: AgentStage): stage is FreshEyesStage {
  return stage !== "develop";
}

export function prSectionSentinel(stage: AgentStage, round = 0): string {
  return round === 0 ? `${SENTINEL_PREFIX}${stage} -->` : `${SENTINEL_PREFIX}${stage} rework=${round} -->`;
}

export function prSectionHeading(stage: AgentStage, round = 0): string {
  if (!isFreshEyesStage(stage)) return `## Rework ${round} — fix`;
  const title = STAGE_SECTION_TITLE[stage];
  return round === 0 ? `## ${title}` : `## ${title} (rework ${round})`;
}

export function prSectionMarker(stage: AgentStage, round = 0): string {
  return `${prSectionSentinel(stage, round)}\n${prSectionHeading(stage, round)}`;
}

function sectionAfter(body: string, sentinel: string): string | undefined {
  const start = body.indexOf(sentinel);
  if (start < 0) return undefined;
  const rest = body.slice(start + sentinel.length);
  const nextSection = rest.indexOf(SENTINEL_PREFIX);
  return nextSection < 0 ? rest : rest.slice(0, nextSection);
}

function prSectionText(body: string, stage: AgentStage, round: number): string | undefined {
  return sectionAfter(body, prSectionSentinel(stage, round));
}

export function hasPrSection(body: string, stage: AgentStage, round = 0): boolean {
  return prSectionText(body, stage, round) !== undefined;
}

export function unfixableReason(body: string, stage: FreshEyesStage, round = 0): string | undefined {
  const section = prSectionText(body, stage, round);
  if (section === undefined) return undefined;
  const declaration = section.split(/\r?\n/).find((line) => line.trimStart().startsWith(UNFIXABLE_PREFIX));
  if (!declaration) return undefined;
  return declaration.trim().slice(UNFIXABLE_PREFIX.length).trim() || "no reason given";
}

export function needsReworkStory(body: string, round = 0): string | undefined {
  const section = prSectionText(body, "review", round);
  if (section === undefined) return undefined;
  const lines = section.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimStart().startsWith(NEEDS_REWORK_PREFIX));
  if (start < 0) return undefined;
  const firstLine = lines[start]!.trimStart().slice(NEEDS_REWORK_PREFIX.length).trim();
  const story = [firstLine, ...lines.slice(start + 1)].join("\n").trim();
  return story || "the review agent asked for rework but wrote no story";
}

export function reworkBriefSentinel(round: number): string {
  return `${SENTINEL_PREFIX}rework=${round} -->`;
}

export function reworkBriefSection(brief: ReworkBrief, limit: number): string {
  return ["", reworkBriefSentinel(brief.round), reworkHeading(brief, limit), "", brief.story.trim(), ""].join("\n");
}

function isReworkSource(value: string): value is ReworkSource {
  return (REWORK_SOURCES as readonly string[]).includes(value);
}

export function reworkBriefsIn(body: string): ReworkBrief[] {
  const briefs: ReworkBrief[] = [];
  for (const match of body.matchAll(REWORK_BRIEF_SENTINEL)) {
    const round = Number(match[1]);
    const text = sectionAfter(body, match[0]) ?? "";
    const [heading = "", ...storyLines] = text.replace(/^\r?\n/, "").split(/\r?\n/);
    const source = REWORK_BRIEF_HEADING.exec(heading.trim())?.[1];
    if (!source || !isReworkSource(source)) continue;
    briefs.push({ round, source, story: storyLines.join("\n").trim() });
  }
  return briefs.sort((a, b) => a.round - b.round);
}

export function taggedCommitSubjects(subjects: readonly string[], stage: AgentStage): string[] {
  const tag = STAGE_COMMIT_TAG[stage];
  return subjects.filter((subject) => subject.startsWith(tag));
}

export function orphanedStageSection(stage: AgentStage, subjects: readonly string[], round = 0): string {
  return [
    "",
    prSectionMarker(stage, round),
    "",
    `_The ${stage} stage completed without writing its section; the orchestrator recorded it. Detected commits:_`,
    ...subjects.map((subject) => `- \`${subject}\``),
    "",
  ].join("\n");
}

const TEST_FIRST_COMMIT = /^test(\([^)]*\))?:\s/;

export function hasTestFirstCommit(subjects: readonly string[]): boolean {
  return subjects.some((subject) => TEST_FIRST_COMMIT.test(subject));
}
