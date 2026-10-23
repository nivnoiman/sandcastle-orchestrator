import { boundedHead } from "../../markdown.js";

export type VerifyVerdict = "green" | "red";

export type ScenarioKind = "pass" | "fail" | "requiresStg";

export interface ScenarioCounts {
  pass: number;
  fail: number;
  requiresStg: number;
}

export interface ScenarioLine {
  line: string;
  kind: ScenarioKind;
  token: string;
  recognized: boolean;
}

export interface VerifyOutcome {
  verdict: VerifyVerdict;
  counts: ScenarioCounts;
  reason: string | undefined;
}

export const REPORT_COMMENT_LIMIT = 55000;
export const PR_BODY_REPORT_LIMIT = 6000;

const VERDICT_TOKENS: Readonly<Record<string, ScenarioKind>> = {
  PASS: "pass",
  PASSED: "pass",
  FAIL: "fail",
  FAILED: "fail",
  "REQUIRES-STG": "requiresStg",
  "REQUIRES-STAGING": "requiresStg",
  REQUIRESSTG: "requiresStg",
  "STG-ONLY": "requiresStg",
  STGONLY: "requiresStg",
};

const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const EMPHASIS = /^[*_`~]+/;
const LEADING_TOKEN = /^([A-Za-z][A-Za-z0-9_-]*)/;
const SEPARATOR = /^(?:[—–:|,]|-(?:[ \t]|$))/;
const SHOUTED = /^[A-Z][A-Z0-9_-]+$/;

function normalizeToken(token: string): string {
  return token.toUpperCase().replace(/_/g, "-");
}

export function readScenarioLine(raw: string): ScenarioLine | undefined {
  const bullet = BULLET.exec(raw);
  if (!bullet) return undefined;
  const body = bullet[1]!.replace(EMPHASIS, "");
  const token = LEADING_TOKEN.exec(body)?.[1];
  if (!token) return undefined;
  const tail = body.slice(token.length).replace(EMPHASIS, "").trimStart();
  if (tail.length > 0 && !SEPARATOR.test(tail)) return undefined;

  const normalized = normalizeToken(token);
  const known = VERDICT_TOKENS[normalized];
  if (known) return { line: raw, kind: known, token: normalized, recognized: true };
  if (!SHOUTED.test(token)) return undefined;
  return { line: raw, kind: "fail", token: normalized, recognized: false };
}

export function scenarioLines(report: string): ScenarioLine[] {
  return report
    .split(/\r?\n/)
    .map((line) => readScenarioLine(line))
    .filter((scenario): scenario is ScenarioLine => scenario !== undefined);
}

export function countScenarios(report: string): ScenarioCounts {
  const counts: ScenarioCounts = { pass: 0, fail: 0, requiresStg: 0 };
  for (const scenario of scenarioLines(report)) counts[scenario.kind] += 1;
  return counts;
}

function unrecognizedTokens(report: string): string[] {
  return [...new Set(scenarioLines(report).filter((scenario) => !scenario.recognized).map((scenario) => scenario.token))];
}

function failureReason(report: string, counts: ScenarioCounts): string {
  const unrecognized = unrecognizedTokens(report);
  const suffix =
    unrecognized.length > 0
      ? ` — ${unrecognized.join(", ")} is not a verdict sandcastle recognises, and an unreadable verdict counts as failed`
      : "";
  return `${counts.fail} scenario(s) FAILED${suffix}`;
}

export function readVerdict(report: string | undefined): VerifyOutcome {
  const empty: ScenarioCounts = { pass: 0, fail: 0, requiresStg: 0 };
  if (report === undefined || report.trim().length === 0) {
    return { verdict: "red", counts: empty, reason: "the feature verify agent produced no report" };
  }
  const counts = countScenarios(report);
  const total = counts.pass + counts.fail + counts.requiresStg;
  if (total === 0) {
    return {
      verdict: "red",
      counts,
      reason: "the report has no scenario lines in the required `- PASS|FAIL|REQUIRES-STG — <scenario>` form, so nothing is proven",
    };
  }
  if (counts.fail > 0) {
    return { verdict: "red", counts, reason: failureReason(report, counts) };
  }
  if (counts.pass === 0) {
    return {
      verdict: "red",
      counts,
      reason: `no automated scenario passed — all ${counts.requiresStg} scenario(s) were deferred to staging, so this environment proved nothing`,
    };
  }
  return { verdict: "green", counts, reason: undefined };
}

export function countsLine(counts: ScenarioCounts): string {
  return `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.requiresStg} requires-STG`;
}

export function truncateReport(report: string, limit: number = REPORT_COMMENT_LIMIT): string {
  return boundedHead(report, limit, `_(report truncated — it exceeded ${limit} characters)_`);
}
