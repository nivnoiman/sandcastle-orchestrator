import { scenarioLines, type ScenarioKind, type ScenarioLine } from "./verdict.js";

export type FeatureRecheckMode = "focused" | "full";

export const FEATURE_RECHECK_DEFAULT: FeatureRecheckMode = "focused";
export const CARRIED_OVER_MARK = "[carried over]";
export const CARRIED_OVER_HEADING = "## Carried over from the previous Feature Verify";

export interface PriorScenario {
  name: string;
  key: string;
  kind: ScenarioKind;
  detail: string;
}

export interface FeatureRecheck {
  fixRound: number;
  recheck: PriorScenario[];
  carried: PriorScenario[];
  fixSummary: string | undefined;
}

const NAME_END = /[ \t]+[—–|][ \t]+/;
const HYPHEN_NAME_END = /[ \t]+-[ \t]+/;
const DECORATION = /[*_`~]/g;
const CARRIED_PREFIX = /^\[carried over\][ \t]*/i;

const TOKEN_FOR: Readonly<Record<ScenarioKind, string>> = { pass: "PASS", fail: "FAIL", requiresStg: "REQUIRES-STG" };

function scenarioKey(name: string): string {
  return name.replace(DECORATION, "").replace(/\s+/g, " ").replace(/[.;,]+$/, "").trim().toLowerCase();
}

function priorScenario(scenario: ScenarioLine): PriorScenario | undefined {
  const body = scenario.text;
  const end = NAME_END.exec(body) ?? HYPHEN_NAME_END.exec(body);
  const name = (end ? body.slice(0, end.index) : body).trim();
  const key = scenarioKey(name);
  if (key.length === 0) return undefined;
  const detail = end ? body.slice(end.index + end[0].length).replace(CARRIED_PREFIX, "").trim() : "";
  return { name, key, kind: scenario.kind, detail };
}

export function priorScenarios(report: string): PriorScenario[] {
  return scenarioLines(report)
    .map(priorScenario)
    .filter((scenario): scenario is PriorScenario => scenario !== undefined);
}

function uniqueByKey(scenarios: readonly PriorScenario[]): PriorScenario[] {
  const seen = new Map<string, PriorScenario>();
  for (const scenario of scenarios) {
    const existing = seen.get(scenario.key);
    if (!existing || scenario.kind === "fail") seen.set(scenario.key, scenario);
  }
  return [...seen.values()];
}

export function planRecheck(priorReport: string | undefined, fixRound: number, fixSummary: string | undefined): FeatureRecheck | undefined {
  if (!priorReport) return undefined;
  const scenarios = uniqueByKey(priorScenarios(priorReport));
  const recheck = scenarios.filter((scenario) => scenario.kind === "fail");
  if (recheck.length === 0) return undefined;
  const carried = scenarios.filter((scenario) => scenario.kind !== "fail");
  return { fixRound, recheck, carried, fixSummary };
}

function carriedLine(scenario: PriorScenario): string {
  const detail = scenario.detail ? ` ${scenario.detail}` : "";
  return `- ${TOKEN_FOR[scenario.kind]} — ${scenario.name} — ${CARRIED_OVER_MARK}${detail}`;
}

function unrecheckedFailureLine(scenario: PriorScenario, fixRound: number): string {
  return `- FAIL — ${scenario.name} — failed before fix round ${fixRound} and the re-check did not report it, so it stays FAIL`;
}

export function mergeRecheckReport(focusedReport: string | undefined, recheck: FeatureRecheck): string | undefined {
  if (!focusedReport) return focusedReport;
  const rechecked = priorScenarios(focusedReport);
  if (rechecked.length === 0) return focusedReport;
  const reported = new Set(rechecked.map((scenario) => scenario.key));
  const carried = recheck.carried.filter((scenario) => !reported.has(scenario.key));
  const dropped = recheck.recheck.filter((scenario) => !reported.has(scenario.key));
  return [
    focusedReport.trimEnd(),
    "",
    CARRIED_OVER_HEADING,
    `_Focused re-check after fix round ${recheck.fixRound}: ${rechecked.length} scenario(s) re-checked above, ${carried.length} verdict(s) carried over unchanged below._`,
    "",
    ...dropped.map((scenario) => unrecheckedFailureLine(scenario, recheck.fixRound)),
    ...carried.map(carriedLine),
  ].join("\n");
}
