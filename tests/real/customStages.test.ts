import { describe, expect, it } from "vitest";
import { reworkComment } from "../../src/engine/rework.js";
import type { StageSpec } from "../../src/project/stagesConfig.js";
import { agentsInUse, claudeProvider, codexProvider, resolveStageAgent } from "../../src/real/agents/index.js";
import { parseAttemptId } from "../../src/real/attemptLog.js";
import { isOrchestratorContainer, stageContainerName } from "../../src/real/docker.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import { RealGhClient } from "../../src/real/ghClient.js";
import { buildSalvagePrompt, buildStagePrompt, renderStageInstructions, type StagePromptContext } from "../../src/real/promptBuilder.js";
import { planReset } from "../../src/real/reset.js";
import {
  needsReworkStory,
  prSectionMarker,
  reworkBriefSection,
  reworkBriefsIn,
  stageCommitTag,
  unfixableReason,
} from "../../src/real/stageAudit.js";
import { fsWith, testConfig, testLayout, testRunModel, testWorkItem } from "./support.js";

const SECURITY: StageSpec = { kind: "agent", name: "security", promptPath: "/p/security.md", agent: undefined };
const E2E: StageSpec = { kind: "command", name: "e2e", run: "npx playwright test" };

function context(overrides: Partial<StagePromptContext> = {}): StagePromptContext {
  return {
    stage: "security",
    stageInstructions: "Audit the diff for leaked secrets and missing authz checks.",
    item: testWorkItem(),
    branch: "feat/17-toy-slice",
    integrationBranch: "integration/toy-demo",
    requiredReading: ["CLAUDE.md"],
    memories: [],
    hubRepo: "example-org/hub",
    parentNumber: 16,
    feature: "toy-demo",
    ...overrides,
  };
}

describe("custom agent stage prompt", () => {
  const prompt = buildStagePrompt(context());

  it("frames the owner's instructions with the issue spec and the fresh-eyes contract", () => {
    expect(prompt).toMatch(/^Run the security stage on the implementation of sub-issue example-org\/hub#17/);
    expect(prompt).toContain("<stage-instructions>\nAudit the diff for leaked secrets and missing authz checks.\n</stage-instructions>");
    expect(prompt).toContain("<issue-spec>");
    expect(prompt).toContain("**1. Read the stage instructions.**");
    expect(prompt).not.toContain("SKILL.md");
  });

  it("asks for the stage's own marker, commit tag, NEEDS-REWORK and UNFIXABLE", () => {
    expect(prompt).toContain("<!-- sandcastle:security -->\n## security");
    expect(prompt).toContain("`fix(security): <brief description>`");
    expect(prompt).toContain("NEEDS-REWORK:");
    expect(prompt).toContain("UNFIXABLE:");
  });

  it("uses the round's marker in a rework round", () => {
    const rework = { round: 2, limit: 3, briefs: [{ round: 2, source: "e2e", story: "login spec red" }] };
    expect(buildStagePrompt(context({ rework }))).toContain("<!-- sandcastle:security rework=2 -->\n## security (rework 2)");
  });

  it("has a salvage variant that closes out the custom stage", () => {
    const salvage = buildSalvagePrompt(context());
    expect(salvage).toContain("Salvage pass for the security stage");
    expect(salvage).toContain("<!-- sandcastle:security -->");
  });

  it("refuses to build a custom stage prompt without its instructions", () => {
    expect(() => buildStagePrompt(context({ stageInstructions: undefined }))).toThrow(/carries no stage instructions/);
  });

  it("keeps simplify free of the NEEDS-REWORK rule", () => {
    expect(buildStagePrompt(context({ stage: "simplify", stageInstructions: undefined }))).not.toContain("NEEDS-REWORK:");
  });
});

describe("renderStageInstructions", () => {
  it("fills every placeholder from the stage context", () => {
    const text = "{{issue}} #{{issueNumber}} {{title}} [{{repo}}] {{branch}} -> {{integrationBranch}} {{feature}} {{stage}} r{{ round }}";
    expect(renderStageInstructions(text, context(), "x")).toBe(
      "example-org/hub#17 #17 feat: toy slice [api] feat/17-toy-slice -> integration/toy-demo toy-demo security r0",
    );
  });

  it("fails on a placeholder it does not know", () => {
    expect(() => renderStageInstructions("{{token}}", context(), "stage security prompt")).toThrow(
      /stage security prompt has unknown placeholder \{\{token\}\}/,
    );
  });
});

describe("custom stage audit trail", () => {
  it("tags custom stage commits as fix(<name>): and keeps the built-in tags", () => {
    expect(stageCommitTag("security")).toBe("fix(security):");
    expect(stageCommitTag("review")).toBe("fix(review):");
    expect(stageCommitTag("develop")).toBe("feat:");
  });

  it("reads NEEDS-REWORK and UNFIXABLE from a custom stage's section", () => {
    const body = `${prSectionMarker("security")}\n\nNEEDS-REWORK:\n### What is wrong\ntoken logged`;
    expect(needsReworkStory(body, 0, "security")).toBe("### What is wrong\ntoken logged");
    expect(needsReworkStory(body)).toBeUndefined();
    expect(unfixableReason(`${prSectionMarker("security")}\nUNFIXABLE: needs a vault`, "security")).toBe("needs a vault");
  });

  it("reads back rework briefs a custom stage raised", () => {
    const body = reworkBriefSection({ round: 1, source: "e2e", story: "login spec red" }, 3);
    expect(reworkBriefsIn(body)).toEqual([{ round: 1, source: "e2e", story: "login spec red" }]);
  });

  it("names the configured chain in the rework comment", () => {
    expect(reworkComment({ round: 1, source: "e2e", story: "red" }, 3, ["develop", "e2e", "verify"])).toContain(
      "It re-runs develop → e2e → verify",
    );
    expect(reworkComment({ round: 1, source: "verify", story: "red" }, 3)).toContain("It re-runs develop → simplify → review → verify");
  });
});

describe("custom stage agents", () => {
  it("resolves a custom agent stage from its own entry, else agents.default with the review model", () => {
    const own = { ...SECURITY, agent: { provider: "codex" as const, model: "gpt-5.5-codex" } };
    expect(resolveStageAgent(testConfig({ stages: [own] }), "security")).toEqual({ provider: codexProvider, model: "gpt-5.5-codex" });
    expect(resolveStageAgent(testConfig({ stages: [SECURITY] }), "security")).toEqual({ provider: claudeProvider, model: "sonnet" });
    expect(resolveStageAgent(testConfig(), "review")).toEqual({ provider: claudeProvider, model: "sonnet" });
    expect(() => resolveStageAgent(testConfig({ stages: [E2E] }), "e2e")).toThrow(/"e2e" is not an agent stage/);
  });

  it("covers a custom stage's provider in the auth probe and preflight", () => {
    const codexSecurity = { ...SECURITY, agent: { provider: "codex" as const, model: undefined } };
    expect(agentsInUse(testConfig({ stages: [codexSecurity, E2E] })).map((agent) => agent.provider.name)).toEqual(["claude", "codex"]);
  });
});

describe("custom stage labels and names", () => {
  function ghHarness(labels = ["sc:in-review"]) {
    const runner = new RecordingCommandRunner();
    runner.respond("issue view", JSON.stringify({ labels: labels.map((name) => ({ name })) }));
    const gh = new RealGhClient({
      runner,
      hubRepo: "example-org/hub",
      locate: () => ({ repo: "api", branch: "feat/17-toy-slice" }),
      log: () => undefined,
      warn: () => undefined,
    });
    return { runner, gh };
  }

  it("creates a custom stage label on the hub once, before the first edit that adds it", () => {
    const { runner, gh } = ghHarness();
    gh.setStageLabel(17, "sc:security");
    gh.setStageLabel(18, "sc:security");
    const creates = runner.lines.filter((line) => line.includes("label create"));
    expect(creates).toEqual([
      "gh label create sc:security --repo example-org/hub --force --color 5319E7 --description sandcastle custom stage security",
    ]);
    expect(runner.lines.indexOf(creates[0]!)).toBeLessThan(runner.lines.findIndex((line) => line.includes("issue edit 17")));
    expect(runner.find("issue edit 17")?.line).toContain("--add-label sc:security --remove-label sc:in-review");
  });

  it("never creates the fixed labels", () => {
    const { runner, gh } = ghHarness();
    gh.setStageLabel(17, "sc:verifying");
    expect(runner.lines.some((line) => line.includes("label create"))).toBe(false);
  });

  it("reads custom sc:* labels back for crash-resume", () => {
    const { gh } = ghHarness(["sc:e2e", "repo:api"]);
    expect(gh.stageLabels(17)).toEqual(["sc:e2e"]);
  });

  it("strips custom stage labels on reset, after the fixed ones", () => {
    const plan = planReset({
      runner: new RecordingCommandRunner(),
      fs: fsWith({}),
      layout: testLayout(),
      model: testRunModel(),
      hubRepo: "example-org/hub",
      issues: [{ number: 17, state: "OPEN", labels: ["sc:e2e", "sc:needs-human", "repo:api"] }],
      isAlive: () => false,
      log: () => undefined,
    });
    expect(plan.labels).toEqual([{ itemNumber: 17, remove: ["sc:needs-human", "sc:e2e"], swapToAgent: false }]);
  });

  it("accepts kebab stage names in container names and attempt ids", () => {
    expect(isOrchestratorContainer(stageContainerName("x-check", 17, "abc1"))).toBe(true);
    expect(parseAttemptId("17-x-check-3")).toEqual({ itemNumber: 17, stage: "x-check", attempt: 3 });
    expect(parseAttemptId("17-review-2")).toEqual({ itemNumber: 17, stage: "review", attempt: 2 });
  });
});
