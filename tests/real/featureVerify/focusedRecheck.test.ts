import { describe, expect, it } from "vitest";
import {
  CARRIED_OVER_HEADING,
  CARRIED_OVER_MARK,
  mergeRecheckReport,
  planRecheck,
  priorScenarios,
} from "../../../src/real/featureVerify/focusedRecheck.js";
import { readVerdict } from "../../../src/real/featureVerify/verdict.js";

const PRIOR = [
  "## Test plan",
  "- login works — covers #17",
  "",
  "## Results",
  "- PASS — login works — 200 with a token",
  "- **FAIL** — `import leads` — 500 on POST /leads",
  "- REQUIRES-STG — sms send — the SMS gateway is not reachable here",
  "- PASS: export csv - file has 3 rows",
  "- SKIPPED — dark mode — not run",
].join("\n");

describe("priorScenarios", () => {
  it("reads name, verdict and evidence from every scenario line, through decoration and separators", () => {
    expect(priorScenarios(PRIOR).map(({ name, kind, detail }) => ({ name, kind, detail }))).toEqual([
      { name: "login works", kind: "pass", detail: "200 with a token" },
      { name: "`import leads`", kind: "fail", detail: "500 on POST /leads" },
      { name: "sms send", kind: "requiresStg", detail: "the SMS gateway is not reachable here" },
      { name: "export csv", kind: "pass", detail: "file has 3 rows" },
      { name: "dark mode", kind: "fail", detail: "not run" },
    ]);
  });

  it("matches names regardless of case, decoration and spacing", () => {
    const [first] = priorScenarios("- FAIL — **Import   Leads**. — x");
    const [second] = priorScenarios(PRIOR).filter((scenario) => scenario.kind === "fail");
    expect(first?.key).toBe(second?.key);
  });
});

describe("planRecheck", () => {
  it("re-checks every FAIL (including unreadable verdicts) and carries PASS and REQUIRES-STG over", () => {
    const plan = planRecheck(PRIOR, 1, "- `api`: pushed 1 commit(s)");
    expect(plan?.recheck.map((scenario) => scenario.key)).toEqual(["import leads", "dark mode"]);
    expect(plan?.carried.map((scenario) => scenario.key)).toEqual(["login works", "sms send", "export csv"]);
    expect(plan?.fixRound).toBe(1);
    expect(plan?.fixSummary).toContain("pushed 1 commit");
  });

  it("falls back to a full review when there is no report, no scenario lines or no FAIL", () => {
    expect(planRecheck(undefined, 1, undefined)).toBeUndefined();
    expect(planRecheck("just prose", 1, undefined)).toBeUndefined();
    expect(planRecheck("- PASS — a — ok", 1, undefined)).toBeUndefined();
  });

  it("re-checks a scenario that appears twice when either line failed", () => {
    const plan = planRecheck("- PASS — a — ok\n- FAIL — a — broke", 1, undefined);
    expect(plan?.recheck.map((scenario) => scenario.key)).toEqual(["a"]);
    expect(plan?.carried).toEqual([]);
  });
});

describe("mergeRecheckReport", () => {
  const plan = planRecheck(PRIOR, 1, undefined)!;

  it("appends carried-over verdicts, marked, so the counts cover the whole feature", () => {
    const focused = ["## Results", "- PASS — import leads — 201", "- PASS — dark mode — toggles"].join("\n");
    const merged = mergeRecheckReport(focused, plan)!;
    expect(merged).toContain(CARRIED_OVER_HEADING);
    expect(merged).toContain(`- PASS — login works — ${CARRIED_OVER_MARK} 200 with a token`);
    expect(readVerdict(merged)).toEqual({ verdict: "green", counts: { pass: 4, fail: 0, requiresStg: 1 }, reason: undefined });
  });

  it("lets a re-checked scenario replace its carried-over verdict", () => {
    const focused = ["- PASS — import leads — 201", "- PASS — dark mode — ok", "- FAIL — login works — now 401"].join("\n");
    const merged = mergeRecheckReport(focused, plan)!;
    expect(merged).not.toContain("200 with a token");
    expect(readVerdict(merged).counts).toEqual({ pass: 3, fail: 1, requiresStg: 1 });
  });

  it("keeps a failure the re-check did not report as FAIL", () => {
    const merged = mergeRecheckReport("- PASS — import leads — 201", plan)!;
    expect(merged).toContain("- FAIL — dark mode — failed before fix round 1");
    expect(readVerdict(merged).counts).toEqual({ pass: 3, fail: 1, requiresStg: 1 });
  });

  it("leaves a missing or unparseable focused report alone so the verdict stays red", () => {
    expect(mergeRecheckReport(undefined, plan)).toBeUndefined();
    expect(mergeRecheckReport("the agent crashed", plan)).toBe("the agent crashed");
  });

  it("does not stack carried-over marks across rounds", () => {
    const merged = mergeRecheckReport("- FAIL — import leads — still 500\n- PASS — dark mode — ok", plan)!;
    const second = planRecheck(merged, 2, undefined)!;
    const again = mergeRecheckReport("- PASS — import leads — 201", second)!;
    expect(again).toContain(`- PASS — login works — ${CARRIED_OVER_MARK} 200 with a token`);
    expect(again.split(CARRIED_OVER_MARK).length - 1).toBe(4);
    expect(readVerdict(again).counts).toEqual({ pass: 4, fail: 0, requiresStg: 1 });
  });
});
