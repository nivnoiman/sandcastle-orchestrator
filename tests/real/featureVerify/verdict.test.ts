import { describe, expect, it } from "vitest";
import { readVerdict, REPORT_COMMENT_LIMIT, scenarioLines, truncateReport } from "../../../src/real/featureVerify/verdict.js";

const GREEN_REPORT = [
  "## Test plan",
  "- login works — covers #17",
  "",
  "## Results",
  "- PASS — login works — 200 with a token",
  "- REQUIRES-STG — sms send — the SMS gateway is not in this environment",
].join("\n");

describe("verdict", () => {
  it("is green when at least one scenario passed and none failed", () => {
    const outcome = readVerdict(GREEN_REPORT);
    expect(outcome.verdict).toBe("green");
    expect(outcome.counts).toEqual({ pass: 1, fail: 0, requiresStg: 1 });
    expect(outcome.reason).toBeUndefined();
  });

  it("is red on a single FAIL, whatever else passed", () => {
    const outcome = readVerdict(`${GREEN_REPORT}\n- FAIL — lead import — 500 on POST /api/leads`);
    expect(outcome.verdict).toBe("red");
    expect(outcome.counts.fail).toBe(1);
    expect(outcome.reason).toContain("1 scenario(s) FAILED");
  });

  it("is red when no report was written at all", () => {
    expect(readVerdict(undefined).verdict).toBe("red");
    expect(readVerdict("   ").reason).toContain("no report");
  });

  it("is red when the report proves nothing, so prose alone can never open a pull request", () => {
    const outcome = readVerdict("## Results\nEverything looked fine to me.");
    expect(outcome.verdict).toBe("red");
    expect(outcome.reason).toContain("no scenario lines");
  });

  it("reads verdict tokens case-insensitively and off `*` bullets", () => {
    expect(readVerdict("* pass — a\n* Requires-STG — b").counts).toEqual({ pass: 1, fail: 0, requiresStg: 1 });
  });

  it("never reads a verdict token from the middle of a sentence", () => {
    expect(readVerdict("- the login scenario would FAIL on staging").counts.fail).toBe(0);
  });

  it("is red when every scenario needs staging — nothing was actually proven here", () => {
    const outcome = readVerdict("- REQUIRES-STG — payment renewal");
    expect(outcome.verdict).toBe("red");
    expect(outcome.reason).toContain("no automated scenario passed");
  });
});

describe("verdict grammar", () => {
  it("reads the past-tense verdicts a model actually writes", () => {
    expect(readVerdict("- PASSED — a\n- FAILED — b").counts).toEqual({ pass: 1, fail: 1, requiresStg: 0 });
  });

  it("cannot be turned green by writing FAILED instead of FAIL", () => {
    const outcome = readVerdict("- PASS — a\n- PASS — b\n- PASS — c\n- PASS — d\n- FAILED — e");
    expect(outcome.verdict).toBe("red");
    expect(outcome.counts.fail).toBe(1);
  });

  it("reads verdicts through bold and underscore decoration", () => {
    expect(readVerdict("- **PASS** — a\n- __FAIL__ — b\n- `REQUIRES-STG` — c").counts).toEqual({
      pass: 1,
      fail: 1,
      requiresStg: 1,
    });
  });

  it("accepts the common requires-STG spellings", () => {
    expect(readVerdict("- PASS — a\n- REQUIRES_STG — b\n- STG-ONLY — c\n- REQUIRES-STAGING — d").counts.requiresStg).toBe(3);
  });

  it("accepts `:` and `-` as the scenario separator, and a bare verdict line", () => {
    expect(readVerdict("- PASS: a\n- FAIL - b\n- REQUIRES-STG").counts).toEqual({ pass: 1, fail: 1, requiresStg: 1 });
  });

  it("counts a shouted verdict it does not recognise as a failure, never as a pass", () => {
    const outcome = readVerdict("- PASS — a\n- SKIPPED — b");
    expect(outcome.verdict).toBe("red");
    expect(outcome.counts.fail).toBe(1);
    expect(outcome.reason).toContain("SKIPPED");
  });

  it("leaves ordinary test-plan bullets out of the count", () => {
    expect(readVerdict(["- login works — covers #17", "- PASS — login works"].join("\n")).counts).toEqual({
      pass: 1,
      fail: 0,
      requiresStg: 0,
    });
  });

  it("hands back the whole line so the requires-STG checklist can quote it", () => {
    const lines = scenarioLines("- **REQUIRES-STG** — payment renewal — check a real charge");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe("requiresStg");
    expect(lines[0]?.line).toContain("payment renewal");
  });
});

describe("report truncation", () => {
  it("leaves a normal report alone", () => {
    expect(truncateReport(GREEN_REPORT)).toBe(GREEN_REPORT);
  });

  it("trims a report that would not fit in a github comment and says so", () => {
    const truncated = truncateReport("x".repeat(REPORT_COMMENT_LIMIT + 10));
    expect(truncated.length).toBeLessThan(REPORT_COMMENT_LIMIT + 200);
    expect(truncated).toContain("report truncated");
  });

  it("never cuts a surrogate pair in half", () => {
    const truncated = truncateReport(`${"a".repeat(9)}😀 tail`, 10);
    expect(truncated).toContain("aaaaaaaaa");
    expect(truncated).not.toContain("\ud83d");
  });
});
