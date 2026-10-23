import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RebaseConflictError } from "../src/engine/adapters.js";
import { dryRun } from "../src/engine/dryRunner.js";
import { Engine } from "../src/engine/engine.js";
import { PARK_DETAIL_LIMIT, parkComment } from "../src/engine/parkComment.js";
import { fakePullRequestUrl, RecordingAdapters } from "../src/engine/fakes.js";
import type { RunSnapshot } from "../src/gh/snapshot.js";
import { loadRunModel } from "../src/model/runModel.js";
import { resumePlacement } from "../src/engine/resume.js";
import { evidence, harness, mergeOrder, spawnOrder, testItem, testModel } from "./fixtures.js";

describe("model-order independence and tie-break scope", () => {
  it("marks a dependent blocked even when it precedes its dependency in the model", () => {
    const { adapters, engine } = harness(testModel([testItem(23, "api", [21]), testItem(21, "api")]));
    engine.start();
    expect(engine.phases().get(23)).toBe("blocked");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #21"]);
  });

  it("tie-breaks by dependents that are actually blocked, ignoring done and held ones", () => {
    const { adapters, engine } = harness(
      testModel([
        testItem(41, "api"),
        testItem(42, "api"),
        testItem(43, "api", [41]),
        testItem(44, "api", [42], "done"),
        testItem(45, "api", [42], "held"),
      ]),
    );
    engine.start();
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #41"]);
  });

  it("throws on a dependency missing from the run model", () => {
    expect(() => harness(testModel([testItem(23, "api", [99])])).engine.start()).toThrow(
      "#23 depends on #99, which is not in the run model",
    );
  });
});

describe("label mirror and single-item stage chain", () => {
  it("emits the exact command sequence for one item: branch, labels per transition, spawns, verify, merge, close, done", () => {
    const { adapters, engine, drainAll } = harness(testModel([testItem(17, "api")]));
    engine.start();
    drainAll();
    expect(adapters.log).toEqual([
      "git create-branch [api] integration/toy-demo from dev",
      "label #17 sc:queued",
      "label #17 sc:developing",
      "git create-branch [api] feat/17-slice-17 from integration/toy-demo",
      "spawn develop #17 [api] feat/17-slice-17",
      "label #17 sc:simplifying",
      "git sync [api] feat/17-slice-17 onto integration/toy-demo",
      "spawn simplify #17 [api] feat/17-slice-17",
      "label #17 sc:in-review",
      "git sync [api] feat/17-slice-17 onto integration/toy-demo",
      "spawn review #17 [api] feat/17-slice-17",
      "label #17 sc:verifying",
      "git rebase [api] feat/17-slice-17 onto integration/toy-demo",
      "git check [api] feat/17-slice-17",
      "merge-pr #17",
      "close #17",
      "label #17 sc:done",
    ]);
  });
});

describe("8 items across both repos, cap 2", () => {
  const model = testModel([
    testItem(21, "api"),
    testItem(22, "web"),
    testItem(23, "api", [21]),
    testItem(24, "web", [22]),
    testItem(25, "api", [21]),
    testItem(26, "web", [23, 24]),
    testItem(27, "api", [25]),
    testItem(28, "web", [26, 27]),
  ]);

  it("creates both integration branches and mirrors initial queued/blocked labels", () => {
    const { adapters, engine } = harness(model, 2);
    engine.start();
    expect(adapters.log.slice(0, 10)).toEqual([
      "git create-branch [api] integration/toy-demo from dev",
      "git create-branch [web] integration/toy-demo from dev",
      "label #21 sc:queued",
      "label #22 sc:queued",
      "label #23 sc:blocked",
      "label #24 sc:blocked",
      "label #25 sc:blocked",
      "label #26 sc:blocked",
      "label #27 sc:blocked",
      "label #28 sc:blocked",
    ]);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #21", "spawn develop #22"]);
  });

  it("runs the whole DAG in drain-first order under the cap and merges in dependency order", () => {
    const { adapters, engine, drainAll } = harness(model, 2);
    engine.start();
    drainAll();
    expect(spawnOrder(adapters.log)).toEqual([
      "spawn develop #21",
      "spawn develop #22",
      "spawn simplify #21",
      "spawn simplify #22",
      "spawn review #21",
      "spawn review #22",
      "spawn develop #23",
      "spawn develop #24",
      "spawn simplify #23",
      "spawn simplify #24",
      "spawn review #23",
      "spawn review #24",
      "spawn develop #25",
      "spawn develop #26",
      "spawn simplify #25",
      "spawn simplify #26",
      "spawn review #25",
      "spawn review #26",
      "spawn develop #27",
      "spawn simplify #27",
      "spawn review #27",
      "spawn develop #28",
      "spawn simplify #28",
      "spawn review #28",
    ]);
    expect(mergeOrder(adapters.log)).toEqual([
      "merge-pr #21",
      "merge-pr #22",
      "merge-pr #23",
      "merge-pr #24",
      "merge-pr #25",
      "merge-pr #26",
      "merge-pr #27",
      "merge-pr #28",
    ]);
    expect([...engine.phases().values()].every((phase) => phase === "done")).toBe(true);
  });
});

describe("drain-first", () => {
  it("a waiting simplify of an in-flight item beats starting a new develop", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(31, "api"), testItem(32, "api")]));
    engine.start();
    complete(31, "develop");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #31", "spawn simplify #31"]);
  });

  it("ties between new develops go to the item that unblocks the most dependents", () => {
    const model = testModel([
      testItem(41, "api"),
      testItem(42, "api"),
      testItem(44, "web", [42]),
      testItem(45, "web", [42]),
    ]);
    const { adapters, engine } = harness(model);
    engine.start();
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #42"]);
  });
});

describe("dependencies", () => {
  it("unblocks a dependent only after its dependency merges", () => {
    const model = testModel([testItem(21, "api"), testItem(23, "web", [21])]);
    const { adapters, engine, complete } = harness(model);
    engine.start();
    complete(21, "develop");
    complete(21, "simplify");
    complete(21, "review");
    expect(adapters.log).not.toContain("label #23 sc:queued");
    complete(21, "verify");
    const mergeIndex = adapters.log.indexOf("merge-pr #21");
    const queuedIndex = adapters.log.indexOf("label #23 sc:queued");
    expect(mergeIndex).toBeGreaterThan(-1);
    expect(queuedIndex).toBeGreaterThan(mergeIndex);
    expect(spawnOrder(adapters.log)).toContain("spawn develop #23");
  });

  it("counts admission done as a satisfied dependency", () => {
    const model = testModel([testItem(82, "api", [], "done"), testItem(81, "api", [82])]);
    const { adapters, engine } = harness(model);
    engine.start();
    expect(adapters.log).toContain("label #81 sc:queued");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #81"]);
  });
});

describe("held items", () => {
  it("never schedules a held item and keeps its dependents blocked forever", () => {
    const model = testModel([
      testItem(51, "api"),
      testItem(52, "api", [], "held"),
      testItem(53, "web", [52]),
    ]);
    const { adapters, engine, drainAll } = harness(model);
    engine.start();
    drainAll();
    expect(adapters.log.some((line) => line.includes("#52"))).toBe(false);
    expect(engine.phases().get(51)).toBe("done");
    expect(engine.phases().get(52)).toBe("held");
    expect(engine.phases().get(53)).toBe("blocked");
    expect(adapters.log).toContain("label #53 sc:blocked");
  });
});

describe("park", () => {
  it("parks on stage failure: needs-human label, admission swap, comment; slot freed; dependents stay blocked", () => {
    const model = testModel([
      testItem(61, "api"),
      testItem(62, "web"),
      testItem(63, "api", [61]),
    ]);
    const { adapters, engine, complete, drainAll } = harness(model);
    engine.start();
    complete(61, "develop", "failure");
    expect(adapters.log).toContain("add-label #61 sc:needs-human");
    expect(adapters.log).toContain("swap-labels #61 ready-for-agent→ready-for-human");
    expect(adapters.log.some((line) => line.startsWith('comment #61 "sandcastle parked this item: develop stage failed'))).toBe(true);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #61", "spawn develop #62"]);
    drainAll();
    expect(engine.phases().get(61)).toBe("parked");
    expect(engine.phases().get(62)).toBe("done");
    expect(engine.phases().get(63)).toBe("blocked");
    expect(mergeOrder(adapters.log)).toEqual(["merge-pr #62"]);
  });

  it("parks on verify-gate red without merging or closing", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(71, "api")]));
    engine.start();
    complete(71, "develop");
    complete(71, "simplify");
    complete(71, "review");
    complete(71, "verify", "failure");
    expect(adapters.log).toContain("add-label #71 sc:needs-human");
    expect(adapters.log.some((line) => line.startsWith('comment #71 "sandcastle parked this item: verify gate red'))).toBe(true);
    expect(mergeOrder(adapters.log)).toEqual([]);
    expect(adapters.log).not.toContain("close #71");
    expect(engine.phases().get(71)).toBe("parked");
  });
});

describe("a start that throws stays inside its own item", () => {
  const fiveUnblocked = () =>
    testModel([
      testItem(61, "api"),
      testItem(62, "api"),
      testItem(63, "api"),
      testItem(64, "web"),
      testItem(65, "web"),
    ]);

  it("parks only the item whose branch could not be created and starts the rest", () => {
    const { adapters, engine } = harness(fiveUnblocked(), 5);
    adapters.failCreateItemBranch = (_repo, branch) =>
      branch === "feat/63-slice-63" ? new Error("fatal: a branch named 'feat/63-slice-63' already exists") : undefined;
    engine.start();
    expect(engine.phases().get(63)).toBe("parked");
    expect([61, 62, 64, 65].map((number) => engine.phases().get(number))).toEqual([
      "running", "running", "running", "running",
    ]);
    expect(engine.running()).toBe(4);
    expect(engine.stalled()).toBeUndefined();
    expect(adapters.comments.find((entry) => entry.itemNumber === 63)?.body).toContain("already exists");
  });

  it("parks only the item whose sandbox refused to spawn and starts the rest", () => {
    const { adapters, engine } = harness(fiveUnblocked(), 5);
    adapters.failSpawn = (itemNumber) => (itemNumber === 63 ? new Error("docker daemon is not running") : undefined);
    engine.start();
    expect(engine.phases().get(63)).toBe("parked");
    expect(engine.running()).toBe(4);
    expect(spawnOrder(adapters.log)).toEqual([
      "spawn develop #61", "spawn develop #62", "spawn develop #64", "spawn develop #65",
    ]);
    expect(adapters.comments.find((entry) => entry.itemNumber === 63)?.body).toContain("docker daemon is not running");
  });

  it("freezes the stage label before the branch, so a park at the very start is still resumable", () => {
    const { adapters, engine } = harness(fiveUnblocked(), 5);
    adapters.failCreateItemBranch = (_repo, branch) => (branch === "feat/63-slice-63" ? new Error("already exists") : undefined);
    engine.start();
    const labels = adapters.log.filter((line) => line.includes("#63") && line.includes("label"));
    expect(labels).toEqual([
      "label #63 sc:queued",
      "label #63 sc:developing",
      "add-label #63 sc:needs-human",
      "swap-labels #63 ready-for-agent→ready-for-human",
    ]);
    expect(resumePlacement(evidence({ itemNumber: 63, stageLabels: ["sc:developing", "sc:needs-human"] }), "held")).toEqual({
      kind: "parked",
      stageIndex: 0,
      parkReason: undefined,
    });
  });

  it("does not spin when every unblocked item fails to start", () => {
    const { adapters, engine } = harness(fiveUnblocked(), 5);
    adapters.failCreateItemBranch = () => new Error("no worktree");
    engine.start();
    expect(engine.running()).toBe(0);
    expect([...engine.phases().values()]).toEqual(["parked", "parked", "parked", "parked", "parked"]);
    expect(engine.stalled()).toEqual({ parked: 5, held: 0, blocked: 0 });
  });

  it("keeps the item parked and warns when the hub write for the park fails", () => {
    const { adapters, engine } = harness(fiveUnblocked(), 5);
    adapters.failCreateItemBranch = (_repo, branch) => (branch === "feat/63-slice-63" ? new Error("no worktree") : undefined);
    adapters.failComment = (itemNumber) => (itemNumber === 63 ? new Error("gh: 403") : undefined);
    engine.start();
    expect(engine.phases().get(63)).toBe("parked");
    expect(engine.running()).toBe(4);
    expect(adapters.warnings.some((line) => line.startsWith("#63 parked (") && line.includes("gh: 403"))).toBe(true);
  });
});

describe("park detail", () => {
  function parkedComment(adapters: RecordingAdapters, itemNumber: number): string {
    const found = adapters.comments.find((entry) => entry.itemNumber === itemNumber);
    if (!found) throw new Error(`no comment posted on #${itemNumber}`);
    return found.body;
  }

  it("carries the failing check output into the park comment", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(71, "api")]));
    engine.start();
    complete(71, "develop");
    complete(71, "simplify");
    complete(71, "review");
    complete(71, "verify", "failure", "checks failed (npx tsc): exit 2\n--- last output ---\nsrc/a.ts(3,1): error TS2322");
    const body = parkedComment(adapters, 71);
    expect(body).toContain("verify gate red");
    expect(body).toContain("error TS2322");
    expect(body).toContain("````");
  });

  it("carries an UNFIXABLE settlement reason into the park comment", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(72, "api")]));
    engine.start();
    complete(72, "develop");
    complete(72, "simplify", "failure", "simplify declared the work unfixable in place on https://x/1: the schema is wrong");
    expect(parkedComment(adapters, 72)).toContain("unfixable in place");
  });

  it("keeps the generic park comment when the failure carried no detail", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(73, "api")]));
    engine.start();
    complete(73, "develop", "failure");
    expect(parkedComment(adapters, 73)).toBe(
      "sandcastle parked this item: develop stage failed. " +
        "Dependents stay blocked; flip ready-for-human back to ready-for-agent to re-queue.",
    );
  });

  it("bounds a runaway detail to the tail of the output", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(74, "api")]));
    engine.start();
    complete(74, "develop", "failure", `${"x".repeat(PARK_DETAIL_LIMIT * 2)}THE-END`);
    const body = parkedComment(adapters, 74);
    expect(body).toContain("THE-END");
    expect(body).toContain("…truncated…");
    expect(body.length).toBeLessThan(PARK_DETAIL_LIMIT + 400);
  });

  it("opens a longer fence than the longest backtick run inside the detail", () => {
    const detail = "before\n`````\nnot a fence\n`````\nafter";
    const body = parkComment("verify gate red", detail);
    expect(body).toContain("``````\nbefore");
    expect(body.endsWith("\n``````")).toBe(true);
    expect(body.split("``````")).toHaveLength(3);
  });

  it("keeps the default four-backtick fence when the detail has no long backtick run", () => {
    const body = parkComment("verify gate red", "a `single` backtick pair");
    expect(body).toContain("````\na `single` backtick pair\n````");
  });

  it("truncates on a code-point boundary instead of splitting a surrogate pair", () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const kept = "y".repeat(PARK_DETAIL_LIMIT - 1);
    const body = parkComment("verify gate red", `${"x".repeat(200)}🧱${kept}`);
    expect(body).toContain("…truncated…");
    expect(body).not.toContain("🧱");
    expect(loneSurrogate.test(body)).toBe(false);
    expect(body.endsWith(`${kept}\n\`\`\`\``)).toBe(true);
  });
});

describe("rebase conflict at the gate", () => {
  it("hands the conflict to a resolve agent instead of parking on it", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(81, "api"), testItem(82, "api", [81])]));
    adapters.failRebase = (repo, branch) =>
      new RebaseConflictError(repo, branch, "integration/toy-demo", ["src/a.ts", "src/b.ts"], "CONFLICT (content): merge conflict in src/a.ts");
    engine.start();
    complete(81, "develop");
    complete(81, "simplify");
    complete(81, "review");

    expect(adapters.log).toContain("spawn resolve #81 [api] src/a.ts, src/b.ts");
    expect(engine.phases().get(81)).toBe("running");
    expect(adapters.comments).toEqual([]);
  });

  it("re-runs the gate once the resolve agent lands the branch back on the integration branch", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(81, "api")]));
    let conflicts = 1;
    adapters.failRebase = (repo, branch) =>
      conflicts-- > 0
        ? new RebaseConflictError(repo, branch, "integration/toy-demo", ["src/a.ts"], "CONFLICT")
        : undefined;
    engine.start();
    complete(81, "develop");
    complete(81, "simplify");
    complete(81, "review");

    engine.handleStageCompletion({ itemNumber: 81, stage: "verify", outcome: "success", resolved: true });
    expect(adapters.log).toContain("git check [api] feat/81-slice-81");

    complete(81, "verify");
    expect(engine.phases().get(81)).toBe("done");
    expect(mergeOrder(adapters.log)).toEqual(["merge-pr #81"]);
    expect(adapters.comments).toEqual([]);
  });

  it("parks with the conflicting files when the resolve pass fails, and never resolves twice", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(81, "api"), testItem(82, "api", [81])]));
    adapters.failRebase = (repo, branch) =>
      new RebaseConflictError(repo, branch, "integration/toy-demo", ["src/a.ts", "src/b.ts"], "CONFLICT (content)");
    engine.start();
    complete(81, "develop");
    complete(81, "simplify");
    complete(81, "review");
    complete(81, "verify", "failure", "the resolve pass left feat/81 off the tip of origin/integration/toy-demo");

    const body = adapters.comments.find((entry) => entry.itemNumber === 81)?.body ?? "";
    expect(body).toContain("survived the resolve pass");
    expect(body).toContain("- src/a.ts");
    expect(body).toContain("- src/b.ts");
    expect(engine.phases().get(81)).toBe("parked");
    expect(adapters.log.filter((line) => line.startsWith("spawn resolve"))).toHaveLength(1);
    expect(mergeOrder(adapters.log)).toEqual([]);
    expect(engine.phases().get(82)).toBe("blocked");
  });

  it("frees the worker slot when the resolve pass fails, so the next item still runs", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(83, "api"), testItem(84, "web")]));
    adapters.failRebase = (repo, branch) => new RebaseConflictError(repo, branch, "integration/toy-demo", ["src/a.ts"], "boom");
    engine.start();
    complete(83, "develop");
    complete(83, "simplify");
    complete(83, "review");
    complete(83, "verify", "failure");
    expect(spawnOrder(adapters.log)).toEqual([
      "spawn develop #83",
      "spawn simplify #83",
      "spawn review #83",
      "spawn resolve #83",
      "spawn develop #84",
    ]);
  });

  it("words a non-conflict rebase failure as a rebase failure, not a conflict", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(85, "api")]));
    adapters.failRebase = () => new Error("worktree W:/gone is gone");
    engine.start();
    complete(85, "develop");
    complete(85, "simplify");
    complete(85, "review");
    const body = adapters.comments.find((entry) => entry.itemNumber === 85)?.body ?? "";
    expect(body).toContain("rebase onto integration/toy-demo failed");
    expect(body).toContain("worktree W:/gone is gone");
  });
});

describe("merge and close", () => {
  it("closes the sub-issue with the merged pull request url", () => {
    const { adapters, engine, drainAll } = harness(testModel([testItem(91, "api")]));
    engine.start();
    drainAll();
    expect(adapters.closed).toEqual([{ itemNumber: 91, mergedPullRequestUrl: fakePullRequestUrl(91) }]);
  });

  it("never closes a parked item", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(92, "api")]));
    engine.start();
    complete(92, "develop", "failure");
    expect(adapters.closed).toEqual([]);
  });

  it("parks the item when the merge itself throws, and frees the slot for the next one", () => {
    const model = testModel([testItem(93, "api"), testItem(94, "web"), testItem(95, "api", [93])]);
    const { adapters, engine, drainAll } = harness(model);
    adapters.failMerge = (itemNumber) =>
      itemNumber === 93 ? new Error("pull request #7 is not mergeable: base branch was modified") : undefined;
    engine.start();
    drainAll();
    expect(engine.phases().get(93)).toBe("parked");
    expect(engine.phases().get(95)).toBe("blocked");
    expect(adapters.closed.map((entry) => entry.itemNumber)).toEqual([94]);
    expect(adapters.log).toContain("add-label #93 sc:needs-human");
    const body = adapters.comments.find((entry) => entry.itemNumber === 93)?.body ?? "";
    expect(body).toContain("merge into integration/toy-demo failed");
    expect(body).toContain("base branch was modified");
    expect(spawnOrder(adapters.log)).toContain("spawn develop #94");
    expect(engine.phases().get(94)).toBe("done");
  });

  it("keeps a merged item done when closing the sub-issue throws, and warns with the merged url", () => {
    const { adapters, engine, drainAll } = harness(testModel([testItem(96, "api"), testItem(97, "api", [96])]));
    adapters.failClose = (itemNumber) => (itemNumber === 96 ? new Error("gh: API rate limit exceeded") : undefined);
    engine.start();
    drainAll();
    expect(engine.phases().get(96)).toBe("done");
    expect(adapters.log).toContain("label #96 sc:done");
    expect(adapters.warnings).toEqual([
      `#96 merged ${fakePullRequestUrl(96)} but closing #96 on the hub failed: gh: API rate limit exceeded` +
        " — the work is integrated, close #96 by hand",
    ]);
    expect(engine.phases().get(97)).toBe("done");
  });
});

describe("complete", () => {
  it("is false before the run starts and while work is in flight", () => {
    const { engine, complete } = harness(testModel([testItem(101, "api")]));
    expect(engine.complete()).toBe(false);
    engine.start();
    expect(engine.complete()).toBe(false);
    complete(101, "develop");
    expect(engine.complete()).toBe(false);
  });

  it("is true once every item is done", () => {
    const { engine, drainAll } = harness(testModel([testItem(102, "api"), testItem(103, "web")]));
    engine.start();
    drainAll();
    expect(engine.complete()).toBe(true);
  });

  it("stays false while a park leaves its dependents blocked, so the run keeps polling for the label flip", () => {
    const { engine, complete } = harness(testModel([testItem(104, "api"), testItem(105, "api", [104])]));
    engine.start();
    complete(104, "develop", "failure");
    expect(engine.phases().get(105)).toBe("blocked");
    expect(engine.complete()).toBe(false);
  });

  it("stays false while everything is held", () => {
    const { engine } = harness(testModel([testItem(106, "api", [], "held")]));
    engine.start();
    expect(engine.complete()).toBe(false);
  });
});

describe("stalled", () => {
  it("is undefined before the run starts, while work advances, and once the run completes", () => {
    const { engine, complete, drainAll } = harness(testModel([testItem(111, "api")]));
    expect(engine.stalled()).toBeUndefined();
    engine.start();
    expect(engine.stalled()).toBeUndefined();
    complete(111, "develop");
    expect(engine.stalled()).toBeUndefined();
    drainAll();
    expect(engine.stalled()).toBeUndefined();
  });

  it("counts what the humans are holding once nothing can advance", () => {
    const { engine, complete } = harness(
      testModel([
        testItem(112, "api"),
        testItem(113, "api", [112]),
        testItem(114, "web", [], "held"),
      ]),
    );
    engine.start();
    complete(112, "develop", "failure");
    expect(engine.stalled()).toEqual({ parked: 1, held: 1, blocked: 1 });
  });

  it("goes back to undefined the moment a parked item is re-admitted", () => {
    const { engine, complete } = harness(testModel([testItem(115, "api")]));
    engine.start();
    complete(115, "develop", "failure");
    expect(engine.stalled()).toEqual({ parked: 1, held: 0, blocked: 0 });
    engine.applySnapshot(testModel([testItem(115, "api")]));
    expect(engine.stalled()).toBeUndefined();
    expect(engine.phases().get(115)).toBe("running");
  });
});

describe("fail-fast", () => {
  it("rejects a completion for an unknown item", () => {
    const { engine } = harness(testModel([testItem(17, "api")]));
    engine.start();
    expect(() => engine.handleStageCompletion({ itemNumber: 99, stage: "develop", outcome: "success" })).toThrow(
      "unknown item #99",
    );
  });

  it("rejects a completion for an item that is not running", () => {
    const { engine } = harness(testModel([testItem(17, "api"), testItem(18, "api", [17])]));
    engine.start();
    expect(() => engine.handleStageCompletion({ itemNumber: 18, stage: "develop", outcome: "success" })).toThrow(
      'phase is "blocked"',
    );
  });

  it("rejects a completion for the wrong stage", () => {
    const { engine } = harness(testModel([testItem(17, "api")]));
    engine.start();
    expect(() => engine.handleStageCompletion({ itemNumber: 17, stage: "review", outcome: "success" })).toThrow(
      '"develop" is running',
    );
  });

  it("rejects a non-positive worker cap", () => {
    expect(() => new Engine(testModel([testItem(17, "api")]), new RecordingAdapters(), { workerCap: 0 })).toThrow(
      "workerCap must be a positive integer",
    );
  });

  it("rejects a second start", () => {
    const { engine } = harness(testModel([testItem(17, "api")]));
    engine.start();
    expect(() => engine.start()).toThrow("already started");
  });
});

describe("dry-run fixture", () => {
  it("loads examples/demo/demo-run.json, validates it, and unfolds the whole run to done", () => {
    const raw = readFileSync(new URL("../examples/demo/demo-run.json", import.meta.url), "utf8");
    const snapshot = JSON.parse(raw) as RunSnapshot;
    const result = loadRunModel(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { lines, phases } = dryRun(result.model, 2);
    expect([...phases.values()].every((phase) => phase === "done")).toBe(true);
    expect(lines.filter((line) => line.startsWith("merge-pr ")).length).toBe(8);
  });
});
