import { describe, expect, it } from "vitest";
import type { StageLabel } from "../../src/engine/adapters.js";
import { resumePlacement } from "../../src/engine/resume.js";
import { collectResumeEvidence } from "../../src/real/resumeEvidence.js";
import { prSectionMarker, reworkBriefSection } from "../../src/real/stageAudit.js";
import type { PullRequestRef } from "../../src/real/ghClient.js";
import { testRunModel, testWorkItem } from "./support.js";

function pullRequest(body: string): PullRequestRef {
  return { number: 634, url: "https://github.com/example-org/api/pull/634", state: "OPEN", isDraft: true, body, title: "feat" };
}

function sources(labels: StageLabel[], pr: PullRequestRef | undefined, branchExists = true) {
  const warnings: string[] = [];
  return {
    warnings,
    sources: {
      stageLabels: () => labels,
      remoteRefExists: () => branchExists,
      findPullRequest: () => pr,
      warn: (itemNumber: number, message: string) => warnings.push(`#${itemNumber} ${message}`),
    },
  };
}

describe("collectResumeEvidence", () => {
  const model = testRunModel([testWorkItem({ number: 211 })]);
  const reviewed = pullRequest(`body\n${prSectionMarker("simplify")}\nok\n${prSectionMarker("review")}\nok`);

  it("places a reviewed item at verify even when a GitHub outage left its label at sc:developing", () => {
    const { sources: live } = sources(["sc:developing"], reviewed);
    const [entry] = collectResumeEvidence(model, live);
    expect(entry?.auditedStageIndex).toBe(3);
    expect(resumePlacement(entry!, "queued")).toEqual({ kind: "resume", stageIndex: 3, wasParked: false });
  });

  it("reads simplify-only and bare pull requests as the next stage in the chain", () => {
    const simplified = collectResumeEvidence(model, sources(["sc:developing"], pullRequest(`x\n${prSectionMarker("simplify")}\n`)).sources);
    expect(simplified[0]?.auditedStageIndex).toBe(2);
    expect(collectResumeEvidence(model, sources(["sc:developing"], pullRequest("x")).sources)[0]?.auditedStageIndex).toBe(1);
    expect(collectResumeEvidence(model, sources(["sc:developing"], undefined).sources)[0]?.auditedStageIndex).toBe(0);
  });

  it("falls back to the audit trail and warns when the labels contradict each other", () => {
    const { sources: live, warnings } = sources(["sc:developing", "sc:in-review"], reviewed);
    const [entry] = collectResumeEvidence(model, live);
    expect(entry?.stageLabels).toEqual([]);
    expect(resumePlacement(entry!, "queued")).toEqual({ kind: "resume", stageIndex: 3, wasParked: false });
    expect(warnings[0]).toMatch(/cannot be resumed from .* placing it from its pull request instead/);
  });

  it("does not start an item a human has not admitted just because a pull request exists", () => {
    const [entry] = collectResumeEvidence(model, sources([], reviewed).sources);
    expect(resumePlacement(entry!, "held")).toEqual({ kind: "recompute" });
  });

  it("skips closed items", () => {
    const done = testRunModel([testWorkItem({ number: 211, admission: "done" })]);
    expect(collectResumeEvidence(done, sources(["sc:done"], undefined).sources)).toEqual([]);
  });
});

describe("collectResumeEvidence in a rework round", () => {
  const model = testRunModel([testWorkItem({ number: 211 })]);
  const brief = { round: 1, source: "verify" as const, story: "red" };
  const firstPass = `body\n${prSectionMarker("simplify")}\nok\n${prSectionMarker("review")}\nok`;

  it("re-runs the round's develop when only its brief is recorded, despite the first pass's sections", () => {
    const [entry] = collectResumeEvidence(model, sources(["sc:developing"], pullRequest(`${firstPass}${reworkBriefSection(brief, 3)}`)).sources);
    expect(entry?.auditedStageIndex).toBe(0);
    expect(entry?.reworkBriefs).toEqual([brief]);
  });

  it("moves on through the round as its own sections land", () => {
    const fixed = `${firstPass}${reworkBriefSection(brief, 3)}\n${prSectionMarker("develop", 1)}\nfixed`;
    expect(collectResumeEvidence(model, sources(["sc:developing"], pullRequest(fixed)).sources)[0]?.auditedStageIndex).toBe(1);
    const reviewed = `${fixed}\n${prSectionMarker("simplify", 1)}\nok\n${prSectionMarker("review", 1)}\nok`;
    expect(collectResumeEvidence(model, sources(["sc:developing"], pullRequest(reviewed)).sources)[0]?.auditedStageIndex).toBe(3);
  });
});
