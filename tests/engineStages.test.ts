import { describe, expect, it } from "vitest";
import type { StageName, StageOutcome } from "../src/engine/adapters.js";
import { Engine } from "../src/engine/engine.js";
import { RecordingAdapters } from "../src/engine/fakes.js";
import { auditedStageIndex, resumePlacement, type ResumeEvidence } from "../src/engine/resume.js";
import { stageLabels } from "../src/engine/stageChain.js";
import { DEFAULT_STAGES, type StageSpec } from "../src/project/stagesConfig.js";
import { evidence, testItem, testModel } from "./fixtures.js";

const CUSTOM_CHAIN: readonly StageSpec[] = [
  { kind: "builtin", name: "develop" },
  { kind: "builtin", name: "simplify" },
  { kind: "builtin", name: "review" },
  { kind: "agent", name: "security", promptPath: "/p/security.md", agent: undefined },
  { kind: "command", name: "e2e", run: { web: "npx playwright test" } },
  { kind: "verify", name: "verify" },
];

function customHarness(items = [testItem(17, "web")], resume?: ResumeEvidence[]) {
  const adapters = new RecordingAdapters();
  const model = testModel(items);
  const options = { workerCap: 1, stages: CUSTOM_CHAIN };
  const engine = resume ? Engine.resume(model, adapters, resume, options) : new Engine(model, adapters, options);
  const complete = (itemNumber: number, stage: StageName, outcome: StageOutcome = "success", extra = {}) => {
    adapters.dropPending(itemNumber);
    engine.handleStageCompletion({ itemNumber, stage, outcome, ...extra });
  };
  return { adapters, engine, complete };
}

describe("a configured stage chain", () => {
  it("runs custom agent and command stages in order, under their own labels", () => {
    const { adapters, engine, complete } = customHarness();
    engine.start();
    for (const stage of ["develop", "simplify", "review"]) complete(17, stage);

    expect(adapters.log).toContain("label #17 sc:security");
    expect(adapters.spawned.at(-1)).toMatchObject({ stage: "security", repo: "web" });
    complete(17, "security");

    expect(adapters.log).toContain("label #17 sc:e2e");
    expect(adapters.commands.at(-1)).toMatchObject({ stage: "e2e", command: "npx playwright test", repo: "web" });
    expect(engine.view()[0]).toMatchObject({ phase: "running", stage: "e2e", stageIndex: 4 });
    complete(17, "e2e");

    expect(adapters.log).toContain("label #17 sc:verifying");
    complete(17, "verify");
    expect(engine.view()[0]).toMatchObject({ phase: "done", stageIndex: CUSTOM_CHAIN.length });
  });

  it("skips a command stage that has no command for the item's repo", () => {
    const { adapters, engine, complete } = customHarness([testItem(17, "api")]);
    engine.start();
    for (const stage of ["develop", "simplify", "review", "security"]) complete(17, stage);

    expect(adapters.commands).toEqual([]);
    expect(adapters.notes).toContain("#17 e2e has no command for api — skipping it");
    expect(engine.view()[0]).toMatchObject({ phase: "running", stage: "verify" });
  });

  it("sends a red command stage back to develop and re-runs the whole configured chain", () => {
    const { adapters, engine, complete } = customHarness();
    engine.start();
    for (const stage of ["develop", "simplify", "review", "security"]) complete(17, stage);
    complete(17, "e2e", "failure", { rework: { source: "e2e", story: "login spec fails" } });

    expect(engine.view()[0]).toMatchObject({ phase: "running", stage: "develop", reworkRound: 1 });
    expect(adapters.comments.at(-1)?.body).toContain("raised by the e2e stage");
    expect(adapters.comments.at(-1)?.body).toContain("develop → simplify → review → security → e2e → verify");

    for (const stage of ["develop", "simplify", "review", "security"]) complete(17, stage);
    expect(adapters.commands.at(-1)).toMatchObject({ stage: "e2e", rework: { round: 1 } });
  });

  it("takes NEEDS-REWORK from a custom agent stage like review", () => {
    const { adapters, engine, complete } = customHarness();
    engine.start();
    for (const stage of ["develop", "simplify", "review"]) complete(17, stage);
    complete(17, "security", "failure", { rework: { source: "security", story: "token logged in plain text" } });

    expect(adapters.spawned.at(-1)).toMatchObject({
      stage: "develop",
      rework: { round: 1, briefs: [{ round: 1, source: "security", story: "token logged in plain text" }] },
    });
  });

  it("parks a custom stage failure without a rework story", () => {
    const { adapters, engine, complete } = customHarness();
    engine.start();
    for (const stage of ["develop", "simplify", "review"]) complete(17, stage);
    complete(17, "security", "failure", { detail: "boom" });

    expect(engine.view()[0]).toMatchObject({ phase: "parked", parkReason: "security stage failed" });
    expect(adapters.log).toContain("add-label #17 sc:needs-human");
  });

  it("resumes an item frozen at a custom stage from its label", () => {
    const { adapters, engine } = customHarness(
      [testItem(17, "web")],
      [evidence({ itemNumber: 17, stageLabels: ["sc:security"], branchExists: true, pullRequestExists: true, auditedStageIndex: 3 })],
    );
    expect(engine.view()[0]).toMatchObject({ phase: "running", stage: "security" });
    expect(adapters.spawned.at(-1)).toMatchObject({ stage: "security" });
  });
});

describe("stage labels", () => {
  it("adds sc:<name> per custom stage to the fixed labels", () => {
    expect(stageLabels(DEFAULT_STAGES)).not.toContain("sc:security");
    expect(stageLabels(CUSTOM_CHAIN).slice(-2)).toEqual(["sc:security", "sc:e2e"]);
  });
});

describe("resume placement over a configured chain", () => {
  const placed = (labels: ResumeEvidence["stageLabels"]) =>
    resumePlacement(evidence({ itemNumber: 17, stageLabels: labels, branchExists: true }), "queued", CUSTOM_CHAIN);

  it("maps custom and built-in labels to their index in the configured chain", () => {
    expect(placed(["sc:security"])).toEqual({ kind: "resume", stageIndex: 3, wasParked: false });
    expect(placed(["sc:e2e"])).toEqual({ kind: "resume", stageIndex: 4, wasParked: false });
    expect(placed(["sc:verifying"])).toEqual({ kind: "resume", stageIndex: 5, wasParked: false });
    expect(placed(["sc:e2e", "sc:needs-human"])).toEqual({ kind: "resume", stageIndex: 4, wasParked: true });
  });

  it("refuses a label for a stage the chain no longer has", () => {
    expect(() => placed(["sc:fuzz"])).toThrow(/"sc:fuzz" is not a stage the chain can resume from/);
    expect(() => resumePlacement(evidence({ itemNumber: 17, stageLabels: ["sc:security"] }), "queued")).toThrow();
  });

  it("follows the pull-request trail through custom sections", () => {
    const sections = (present: string[]) => (_body: string, stage: string) => present.includes(stage);
    expect(auditedStageIndex("body", sections(["simplify", "review"]), 0, CUSTOM_CHAIN)).toBe(3);
    expect(auditedStageIndex("body", sections(["review", "security"]), 0, CUSTOM_CHAIN)).toBe(4);
    expect(auditedStageIndex("body", sections(["security", "e2e"]), 0, CUSTOM_CHAIN)).toBe(5);
    expect(auditedStageIndex("body", sections([]), 0, CUSTOM_CHAIN)).toBe(1);
    expect(auditedStageIndex("body", sections([]), 1, CUSTOM_CHAIN)).toBe(0);
  });

  it("matches today's answers on the default chain", () => {
    const sections = (present: string[]) => (_body: string, stage: string) => present.includes(stage);
    expect(auditedStageIndex("body", sections(["review"]))).toBe(3);
    expect(auditedStageIndex("body", sections(["simplify"]))).toBe(2);
    expect(auditedStageIndex("body", sections([]))).toBe(1);
    expect(auditedStageIndex(undefined, sections([]))).toBe(0);
  });
});
