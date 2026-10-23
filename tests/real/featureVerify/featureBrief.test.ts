import { describe, expect, it } from "vitest";
import {
  FEATURE_PARKED_SENTINEL,
  featureBriefsIn,
  featureFixComment,
  featureReworkSection,
  featureReworkStory,
} from "../../../src/real/featureVerify/featureBrief.js";

const REPORT = [
  "## Results",
  "- PASS — login works — 200",
  "- FAIL — lead import — 500 on POST /api/leads",
  "- REQUIRES-STG — sms send",
].join("\n");

function story(): string {
  return featureReworkStory({
    integrationBranch: "integration/toy-demo",
    counts: { pass: 1, fail: 1, requiresStg: 1 },
    report: REPORT,
    services: [{ repo: "api", ref: "origin/integration/toy-demo", baseUrl: "", sourcePath: "" }],
  });
}

describe("featureReworkStory", () => {
  it("tells what happened, which scenarios failed, why it matters and what a fix must achieve", () => {
    const text = story();
    expect(text).toContain("### What happened");
    expect(text).toContain("`api` from `origin/integration/toy-demo`");
    expect(text).toContain("- FAIL — lead import — 500 on POST /api/leads");
    expect(text).not.toMatch(/### Failing scenarios\n[^#]*REQUIRES-STG — sms/);
    expect(text).toContain("### Why it matters");
    expect(text).toContain("### Evidence");
    expect(text).toContain("never stub or fake a provider");
  });
});

describe("featureBriefsIn", () => {
  const round1 = `## Feature Verify\nRED\n${featureReworkSection({ round: 1, limit: 3 }, "story one")}`;
  const fix1 = featureFixComment({ round: 1, limit: 3 }, ["- api: pushed 1 commit(s)"]);
  const round2 = `## Feature Verify\nRED\n${featureReworkSection({ round: 2, limit: 3 }, "story two")}`;

  it("reads every round's brief and its fix result back from the parent comments, oldest first", () => {
    expect(featureBriefsIn(["unrelated", round1, fix1, round2])).toEqual([
      { round: 1, story: "story one", fix: "- api: pushed 1 commit(s)" },
      { round: 2, story: "story two", fix: undefined },
    ]);
  });

  it("starts over after the last park, so a human retry gets a fresh budget", () => {
    expect(featureBriefsIn([round1, fix1, `parked ${FEATURE_PARKED_SENTINEL}`, round2]).map((brief) => brief.round)).toEqual([2]);
  });

  it("ignores a fix result without its brief", () => {
    expect(featureBriefsIn([fix1])).toEqual([]);
  });
});
