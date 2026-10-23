import { describe, expect, it } from "vitest";
import { AGENT_STAGES } from "../../src/engine/adapters.js";
import {
  hasPrSection,
  hasTestFirstCommit,
  isFreshEyesStage,
  needsReworkStory,
  reworkBriefSection,
  reworkBriefsIn,
  orphanedStageSection,
  prSectionHeading,
  prSectionMarker,
  prSectionSentinel,
  STAGE_COMMIT_TAG,
  taggedCommitSubjects,
  unfixableReason,
} from "../../src/real/stageAudit.js";

describe("stage vocabulary", () => {
  it("tags each stage's commits so the pull request commit list reads as the chain", () => {
    expect(AGENT_STAGES.map((stage) => STAGE_COMMIT_TAG[stage])).toEqual([
      "feat:",
      "refactor(simplify):",
      "fix(review):",
    ]);
  });

  it("treats every stage after develop as a fresh-eyes stage", () => {
    expect(isFreshEyesStage("develop")).toBe(false);
    expect(isFreshEyesStage("review")).toBe(true);
    expect(isFreshEyesStage("simplify")).toBe(true);
  });

  it("names one pull-request section per fresh-eyes stage", () => {
    expect(prSectionHeading("review")).toBe("## Review");
    expect(prSectionHeading("simplify")).toBe("## Simplify");
  });

  it("marks completion with an html-comment sentinel above the human-readable heading", () => {
    expect(prSectionSentinel("review")).toBe("<!-- sandcastle:review -->");
    expect(prSectionSentinel("simplify")).toBe("<!-- sandcastle:simplify -->");
    expect(prSectionMarker("review")).toBe("<!-- sandcastle:review -->\n## Review");
  });
});

describe("hasPrSection", () => {
  const body = "## What changed\n- things\n\n<!-- sandcastle:review -->\n## Review\n\n### Fixed\n- a thing\n";

  it("finds the section by its sentinel", () => {
    expect(hasPrSection(body, "review")).toBe(true);
    expect(hasPrSection(body, "simplify")).toBe(false);
  });

  it("ignores a bare heading the agent happened to write in its prose or a code fence", () => {
    expect(hasPrSection("## Review\n\n- fixed a thing", "review")).toBe(false);
    expect(hasPrSection("```md\n## Review\n```", "review")).toBe(false);
    expect(hasPrSection("the ## Review section is coming later", "review")).toBe(false);
  });

  it("still finds the sentinel in a CRLF body", () => {
    expect(hasPrSection("## What changed\r\n\r\n<!-- sandcastle:simplify -->\r\n## Simplify\r\n- inlined it", "simplify")).toBe(true);
  });
});

describe("unfixableReason", () => {
  it("reads the reason off an UNFIXABLE line inside the stage's own section", () => {
    const body = "## What changed\n\n<!-- sandcastle:review -->\n## Review\n\nUNFIXABLE: the schema needs a migration first\n";
    expect(unfixableReason(body, "review")).toBe("the schema needs a migration first");
  });

  it("is undefined when the section is absent or reports normally", () => {
    expect(unfixableReason("## What changed", "review")).toBeUndefined();
    expect(unfixableReason("<!-- sandcastle:review -->\n## Review\n\nno findings", "review")).toBeUndefined();
  });

  it("does not read another stage's UNFIXABLE line", () => {
    const body = "<!-- sandcastle:review -->\n## Review\n\nno findings\n\n<!-- sandcastle:simplify -->\n## Simplify\n\nUNFIXABLE: needs a redesign\n";
    expect(unfixableReason(body, "review")).toBeUndefined();
    expect(unfixableReason(body, "simplify")).toBe("needs a redesign");
  });

  it("still fails the stage when the agent gave no reason", () => {
    expect(unfixableReason("<!-- sandcastle:review -->\n## Review\nUNFIXABLE:", "review")).toBe("no reason given");
  });
});

describe("taggedCommitSubjects", () => {
  const subjects = [
    "feat: toy slice",
    "fix(review): guard the null",
    "fix(review): rename the thing",
    "refactor(simplify): reuse the existing helper",
  ];

  it("keeps only the commits carrying the stage's tag", () => {
    expect(taggedCommitSubjects(subjects, "develop")).toEqual(["feat: toy slice"]);
    expect(taggedCommitSubjects(subjects, "review")).toEqual(["fix(review): guard the null", "fix(review): rename the thing"]);
    expect(taggedCommitSubjects(subjects, "simplify")).toEqual(["refactor(simplify): reuse the existing helper"]);
  });

  it("is empty for an empty branch", () => {
    expect(taggedCommitSubjects([], "review")).toEqual([]);
  });
});

describe("orphanedStageSection", () => {
  const section = orphanedStageSection("review", ["fix(review): guard the null"]);

  it("carries the sentinel so the stub reads as the completed section", () => {
    expect(hasPrSection(section, "review")).toBe(true);
    expect(section).toContain("## Review");
  });

  it("says the stage wrote no section and lists the commits it did leave", () => {
    expect(section).toContain("completed without writing its section");
    expect(section).toContain("`fix(review): guard the null`");
  });
});

describe("rework rounds on the pull request", () => {
  it("keeps the first pass's sentinels byte-for-byte and gives each round its own", () => {
    expect(prSectionSentinel("review")).toBe("<!-- sandcastle:review -->");
    expect(prSectionSentinel("review", 2)).toBe("<!-- sandcastle:review rework=2 -->");
    expect(prSectionHeading("simplify", 1)).toBe("## Simplify (rework 1)");
    expect(prSectionHeading("develop", 1)).toBe("## Rework 1 — fix");
  });

  it("does not read a later round's section as the first pass, or the reverse", () => {
    const body = `x\n${prSectionMarker("review", 1)}\nok`;
    expect(hasPrSection(body, "review")).toBe(false);
    expect(hasPrSection(body, "review", 1)).toBe(true);
    expect(hasPrSection(`x\n${prSectionMarker("review")}\nok`, "review", 1)).toBe(false);
  });

  it("reads the review's rework story up to the next section", () => {
    const body = [
      prSectionMarker("review", 1),
      "- fixed a typo",
      "NEEDS-REWORK: the approach is wrong",
      "### Why it matters",
      "AC 2 fails",
      prSectionMarker("simplify", 2),
    ].join("\n");
    expect(needsReworkStory(body, 1)).toBe("the approach is wrong\n### Why it matters\nAC 2 fails");
    expect(needsReworkStory(body)).toBeUndefined();
    expect(needsReworkStory(`${prSectionMarker("review")}\nNEEDS-REWORK:`)).toMatch(/wrote no story/);
  });

  it("round-trips every brief through the pull-request body, oldest first", () => {
    const briefs = [
      { round: 2, source: "verify" as const, story: "### What happened\nred" },
      { round: 1, source: "review" as const, story: "never persists" },
    ];
    const body = `## What changed${briefs.map((brief) => reworkBriefSection(brief, 3)).join("")}`;
    expect(reworkBriefsIn(body)).toEqual([briefs[1], briefs[0]]);
    expect(reworkBriefsIn("## What changed")).toEqual([]);
  });

  it("detects test-first commits with or without a scope", () => {
    expect(hasTestFirstCommit(["feat: x", "test(toggle): proves it"])).toBe(true);
    expect(hasTestFirstCommit(["feat: x", "tests: nope"])).toBe(false);
  });
});
