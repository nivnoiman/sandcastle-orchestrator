import type { StageName, StageOutcome } from "../src/engine/adapters.js";
import { Engine, type RunHold, type WorkerSlots } from "../src/engine/engine.js";
import { RecordingAdapters } from "../src/engine/fakes.js";
import type { ResumeEvidence } from "../src/engine/resume.js";
import type { IssueSnapshot, RunSnapshot, WorkItemSnapshot } from "../src/gh/snapshot.js";
import type { Admission, RunModel, TargetRepo, WorkItem } from "../src/model/runModel.js";

export const VALID_FENCE = [
  "Some prose above.",
  "",
  "```yaml",
  "sandcastle: v1",
  "feature: toy-demo",
  "required_reading:",
  "  api:",
  "    - CLAUDE.md",
  "load_bearing_memories:",
  "  - feedback_no_code_comments",
  "```",
].join("\n");

export function parent(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 16,
    title: "demo: toy feature",
    state: "OPEN",
    labels: ["sandcastle"],
    body: VALID_FENCE,
    ...overrides,
  };
}

export function item(overrides: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return {
    number: 17,
    title: "toy: api slice A",
    state: "OPEN",
    labels: ["repo:api", "ready-for-agent"],
    body: "## What to build\nToy.",
    blockedBy: [],
    ...overrides,
  };
}

export function testItem(
  number: number,
  repo: TargetRepo,
  dependsOn: number[] = [],
  admission: Admission = "queued",
): WorkItem {
  return { number, title: `slice ${number}`, repo, dependsOn, admission, extraMemories: [], body: "" };
}

export function testModel(items: WorkItem[]): RunModel {
  return {
    parentNumber: 1,
    title: "demo",
    parentBody: VALID_FENCE,
    feature: "toy-demo",
    integrationBranch: "integration/toy-demo",
    requiredReading: {},
    loadBearingMemories: [],
    items,
  };
}

export interface Harness {
  adapters: RecordingAdapters;
  engine: Engine;
  complete: (itemNumber: number, stage: StageName, outcome?: StageOutcome, detail?: string) => void;
  drainAll: () => void;
}

function driver(engine: Engine, adapters: RecordingAdapters): Harness {
  const complete = (itemNumber: number, stage: StageName, outcome: StageOutcome = "success", detail?: string) => {
    const index = adapters.pending.findIndex((entry) => entry.itemNumber === itemNumber && entry.stage === stage);
    if (index !== -1) adapters.pending.splice(index, 1);
    engine.handleStageCompletion({ itemNumber, stage, outcome, detail });
  };
  const drainAll = () => {
    while (adapters.pending.length > 0) {
      const next = adapters.takeNextPending();
      engine.handleStageCompletion({ ...next, outcome: "success" });
    }
  };
  return { adapters, engine, complete, drainAll };
}

export function harness(model: RunModel, workerCap = 1, slots?: WorkerSlots, hold?: RunHold): Harness {
  const adapters = new RecordingAdapters();
  return driver(new Engine(model, adapters, { workerCap, slots, hold }), adapters);
}

export function resumedHarness(model: RunModel, evidence: ResumeEvidence[], workerCap = 1): Harness {
  const adapters = new RecordingAdapters();
  return driver(Engine.resume(model, adapters, evidence, { workerCap }), adapters);
}

export function evidence(overrides: Partial<ResumeEvidence> & { itemNumber: number }): ResumeEvidence {
  return {
    stageLabels: ["sc:queued"],
    branchExists: false,
    pullRequestExists: false,
    pullRequestMerged: false,
    auditedStageIndex: 0,
    ...overrides,
  };
}

export function spawnOrder(log: string[]): string[] {
  return log.filter((line) => line.startsWith("spawn ")).map((line) => line.split(" [")[0] ?? line);
}

export function mergeOrder(log: string[]): string[] {
  return log.filter((line) => line.startsWith("merge-pr "));
}

export function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    repo: "example-org/hub",
    parent: parent(),
    subIssues: [
      item(),
      item({ number: 18, title: "toy: api slice B", blockedBy: [17] }),
      item({
        number: 19,
        title: "toy: web slice C",
        labels: ["repo:web"],
        blockedBy: [18],
      }),
    ],
    ...overrides,
  };
}
