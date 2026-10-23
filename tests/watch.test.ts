import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { RecordingAdapters } from "../src/engine/fakes.js";
import type { RunSnapshot } from "../src/gh/snapshot.js";
import { loadRunModel, type RunModel } from "../src/model/runModel.js";
import { WatchLoop } from "../src/watch/pollDriver.js";
import {
  evidence,
  harness,
  item,
  mergeOrder,
  resumedHarness,
  snapshot,
  spawnOrder,
  testItem,
  testModel,
} from "./fixtures.js";

function branchCreations(log: string[]): string[] {
  return log.filter((line) => line.startsWith("git create-branch "));
}

function since(log: string[], marker: number): string[] {
  return log.slice(marker);
}

function modelFrom(runSnapshot: RunSnapshot): RunModel {
  const result = loadRunModel(runSnapshot);
  if (!result.ok) throw new Error(`fixture snapshot is invalid: ${result.errors.join("; ")}`);
  return result.model;
}

describe("additive-safe sync", () => {
  it("queues a brand-new item and mirrors its label within one applySnapshot", () => {
    const { adapters, engine } = harness(testModel([testItem(21, "api")]));
    engine.start();
    const marker = adapters.log.length;
    engine.applySnapshot(testModel([testItem(21, "api"), testItem(22, "web")]));
    expect(since(adapters.log, marker)).toContain("label #22 sc:queued");
    expect(engine.phases().get(22)).toBe("queued");
  });

  it("re-wires a queued item when its dependencies change", () => {
    const { adapters, engine } = harness(testModel([testItem(21, "api"), testItem(22, "web")]));
    engine.start();
    expect(engine.phases().get(22)).toBe("queued");
    const marker = adapters.log.length;
    engine.applySnapshot(testModel([testItem(21, "api"), testItem(22, "web", [21])]));
    expect(engine.phases().get(22)).toBe("blocked");
    expect(since(adapters.log, marker)).toEqual(["label #22 sc:blocked"]);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #21"]);
  });

  it("unblocks a blocked item when the edit removes its dependency", () => {
    const { adapters, engine } = harness(testModel([testItem(21, "api"), testItem(22, "web", [21])]), 2);
    engine.start();
    expect(engine.phases().get(22)).toBe("blocked");
    engine.applySnapshot(testModel([testItem(21, "api"), testItem(22, "web")]));
    expect(adapters.log).toContain("label #22 sc:queued");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #21", "spawn develop #22"]);
  });

  it("drops a queued item that left the model and a blocked item that was closed", () => {
    const { engine } = harness(
      testModel([testItem(21, "api"), testItem(22, "web"), testItem(23, "api", [21])]),
    );
    engine.start();
    engine.applySnapshot(testModel([testItem(21, "api"), testItem(23, "api", [21], "done")]));
    expect(engine.phases().has(22)).toBe(false);
    expect(engine.phases().get(23)).toBe("done");
  });

  it("never re-wires a running item: it keeps running and the change surfaces as a warning", () => {
    const { adapters, engine } = harness(testModel([testItem(21, "api"), testItem(22, "web")]));
    engine.start();
    const marker = adapters.log.length;
    engine.applySnapshot(
      testModel([{ ...testItem(21, "api", [22]), title: "renamed" }, testItem(22, "web")]),
    );
    expect(engine.phases().get(21)).toBe("running");
    expect(adapters.warnings).toEqual(["#21 changed while running (title, dependsOn); sandcastle ignored the change"]);
    expect(since(adapters.log, marker).filter((line) => line.startsWith("label "))).toEqual([]);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #21"]);
  });

  it("keeps a running item that left the model and warns instead of killing it", () => {
    const { adapters, engine, drainAll } = harness(testModel([testItem(21, "api")]));
    engine.start();
    engine.applySnapshot(testModel([]));
    expect(engine.phases().get(21)).toBe("running");
    expect(adapters.warnings).toEqual([
      "#21 left the run model while running; sandcastle kept it — cancel it by hand to stop it",
    ]);
    drainAll();
    expect(mergeOrder(adapters.log)).toEqual(["merge-pr #21"]);
  });

  it("counts a dependency that completed and then left the model as satisfied", () => {
    const { adapters, engine, drainAll } = harness(testModel([testItem(21, "api"), testItem(23, "api", [21])]));
    engine.start();
    drainAll();
    expect(engine.phases().get(21)).toBe("done");
    engine.applySnapshot(testModel([testItem(23, "api", [21]), testItem(24, "web", [21])]));
    expect(adapters.log).toContain("label #24 sc:queued");
    expect(engine.phases().get(24)).toBe("running");
    expect(spawnOrder(adapters.log)).toContain("spawn develop #24");
  });

  it("rejects a snapshot of another parent, a renamed integration branch, or a run that never started", () => {
    const { engine } = harness(testModel([testItem(21, "api")]));
    expect(() => engine.applySnapshot(testModel([testItem(21, "api")]))).toThrow("before the run started");
    engine.start();
    expect(() => engine.applySnapshot({ ...testModel([]), parentNumber: 2 })).toThrow("snapshot is for parent #2");
    expect(() => engine.applySnapshot({ ...testModel([]), integrationBranch: "integration/other" })).toThrow(
      "integration branch changed mid-run",
    );
  });
});

describe("admission hold and release", () => {
  it("releases a held item within one applySnapshot when ready-for-agent appears", () => {
    const { adapters, engine } = harness(
      testModel([testItem(51, "api"), testItem(52, "web", [], "held")]),
      2,
    );
    engine.start();
    expect(engine.phases().get(52)).toBe("held");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #51"]);
    engine.applySnapshot(testModel([testItem(51, "api"), testItem(52, "web")]));
    expect(adapters.log).toContain("label #52 sc:queued");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #51", "spawn develop #52"]);
  });

  it("un-admits a queued item that lost ready-for-agent before it started", () => {
    const { adapters, engine, drainAll } = harness(testModel([testItem(61, "api"), testItem(62, "web")]));
    engine.start();
    engine.applySnapshot(testModel([testItem(61, "api"), testItem(62, "web", [], "held")]));
    expect(engine.phases().get(62)).toBe("held");
    drainAll();
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #61", "spawn simplify #61", "spawn review #61"]);
    expect(engine.phases().get(62)).toBe("held");
  });

  it("does not un-admit a running item: it warns and keeps going", () => {
    const { adapters, engine, drainAll } = harness(testModel([testItem(61, "api")]));
    engine.start();
    engine.applySnapshot(testModel([testItem(61, "api", [], "held")]));
    expect(engine.phases().get(61)).toBe("running");
    expect(adapters.warnings).toEqual(["#61 changed while running (admission); sandcastle ignored the change"]);
    drainAll();
    expect(engine.phases().get(61)).toBe("done");
  });
});

describe("park and resume", () => {
  it("resumes a parked item at the stage it died, on the branch it already has", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(71, "api")]));
    engine.start();
    complete(71, "develop");
    complete(71, "simplify", "failure");
    expect(engine.phases().get(71)).toBe("parked");
    expect(adapters.log).toContain("add-label #71 sc:needs-human");
    expect(adapters.log).toContain("swap-labels #71 ready-for-agent→ready-for-human");
    const marker = adapters.log.length;
    engine.applySnapshot(testModel([testItem(71, "api")]));
    expect(since(adapters.log, marker)).toEqual([
      "remove-label #71 sc:needs-human",
      "git sync [api] feat/71-slice-71 onto integration/toy-demo",
      "spawn simplify #71 [api] feat/71-slice-71",
    ]);
    expect(branchCreations(adapters.log)).toEqual([
      "git create-branch [api] integration/toy-demo from dev",
      "git create-branch [api] feat/71-slice-71 from integration/toy-demo",
    ]);
  });

  it("leaves a parked item parked while the ball is still with the human", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(71, "api")]));
    engine.start();
    complete(71, "develop", "failure");
    const marker = adapters.log.length;
    engine.applySnapshot(testModel([testItem(71, "api", [], "held")]));
    expect(engine.phases().get(71)).toBe("parked");
    expect(since(adapters.log, marker)).toEqual([]);
  });

  it("treats a parked item closed by hand as done and unblocks its dependents", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(71, "api"), testItem(72, "web", [71])]));
    engine.start();
    complete(71, "develop", "failure");
    engine.applySnapshot(testModel([testItem(71, "api", [], "done"), testItem(72, "web", [71])]));
    expect(engine.phases().get(71)).toBe("done");
    expect(adapters.log).toContain("label #72 sc:queued");
    expect(spawnOrder(adapters.log)).toContain("spawn develop #72");
  });
});

describe("label mirror", () => {
  it("clears the stale sc:queued label when a queued item goes back on hold", () => {
    const { adapters, engine } = harness(testModel([testItem(61, "api"), testItem(62, "web")]));
    engine.start();
    const marker = adapters.log.length;
    engine.applySnapshot(testModel([testItem(61, "api"), testItem(62, "web", [], "held")]));
    expect(engine.phases().get(62)).toBe("held");
    expect(since(adapters.log, marker)).toEqual(["remove-label #62 sc:queued"]);
  });

  it("gives a new held item no label and emits sc:queued once when it is released", () => {
    const { adapters, engine } = harness(testModel([testItem(21, "api")]));
    engine.start();
    const marker = adapters.log.length;
    engine.applySnapshot(testModel([testItem(21, "api"), testItem(22, "web", [], "held")]));
    expect(since(adapters.log, marker)).toEqual([]);
    engine.applySnapshot(testModel([testItem(21, "api"), testItem(22, "web")]));
    engine.applySnapshot(testModel([testItem(21, "api"), testItem(22, "web")]));
    expect(since(adapters.log, marker).filter((line) => line.includes("#22"))).toEqual(["label #22 sc:queued"]);
  });

  it("removes the sc:* label of a blocked item before dropping it from the run", () => {
    const { adapters, engine } = harness(testModel([testItem(21, "api"), testItem(23, "api", [21])]));
    engine.start();
    const marker = adapters.log.length;
    engine.applySnapshot(testModel([testItem(21, "api")]));
    expect(engine.phases().has(23)).toBe(false);
    expect(since(adapters.log, marker)).toEqual(["remove-label #23 sc:blocked"]);
  });
});

describe("warning dedupe", () => {
  it("warns once per delta while a running item keeps diverging", () => {
    const { adapters, engine } = harness(testModel([testItem(21, "api"), testItem(22, "web")]));
    engine.start();
    const renamed = { ...testItem(21, "api"), title: "renamed" };
    engine.applySnapshot(testModel([renamed, testItem(22, "web")]));
    engine.applySnapshot(testModel([renamed, testItem(22, "web")]));
    expect(adapters.warnings).toEqual(["#21 changed while running (title); sandcastle ignored the change"]);
    engine.applySnapshot(testModel([{ ...renamed, dependsOn: [22] }, testItem(22, "web")]));
    expect(adapters.warnings).toEqual([
      "#21 changed while running (title); sandcastle ignored the change",
      "#21 changed while running (title, dependsOn); sandcastle ignored the change",
    ]);
  });

  it("warns once about a running item that left the model, not on every tick", () => {
    const { adapters, engine } = harness(testModel([testItem(21, "api")]));
    engine.start();
    engine.applySnapshot(testModel([]));
    engine.applySnapshot(testModel([]));
    expect(adapters.warnings).toEqual([
      "#21 left the run model while running; sandcastle kept it — cancel it by hand to stop it",
    ]);
  });

  it("compares extra memories element-wise, not as a joined string", () => {
    const { adapters, engine } = harness(testModel([{ ...testItem(21, "api"), extraMemories: ["a,b"] }]));
    engine.start();
    engine.applySnapshot(testModel([{ ...testItem(21, "api"), extraMemories: ["a", "b"] }]));
    expect(adapters.warnings).toEqual(["#21 changed while running (extraMemories); sandcastle ignored the change"]);
  });
});

describe("branch slug", () => {
  it("re-derives the branch of an item that was retitled before it started", () => {
    const { adapters, engine, drainAll } = harness(testModel([testItem(21, "api"), testItem(22, "web")]));
    engine.start();
    engine.applySnapshot(
      testModel([testItem(21, "api"), { ...testItem(22, "web"), title: "renamed slice" }]),
    );
    drainAll();
    expect(branchCreations(adapters.log)).toContain(
      "git create-branch [web] feat/22-renamed-slice from integration/toy-demo",
    );
    expect(spawnOrder(adapters.log)).toContain("spawn develop #22");
    expect(adapters.log.some((line) => line.includes("feat/22-slice-22"))).toBe(false);
  });

  it("never re-derives the branch of an item that already has one", () => {
    const { adapters, engine, drainAll } = resumedHarness(
      testModel([testItem(17, "api"), testItem(18, "api", [17])]),
      [
        evidence({ itemNumber: 17, stageLabels: ["sc:queued"] }),
        evidence({ itemNumber: 18, stageLabels: ["sc:blocked"], branchExists: true }),
      ],
    );
    engine.applySnapshot(
      testModel([testItem(17, "api"), { ...testItem(18, "api", [17]), title: "renamed" }]),
    );
    drainAll();
    expect(adapters.log).toContain("spawn develop #18 [api] feat/18-slice-18");
    expect(adapters.log.some((line) => line.includes("feat/18-renamed"))).toBe(false);
  });
});

describe("crash resume from labels and pull-request evidence", () => {
  const model = testModel([
    testItem(17, "api", [], "done"),
    testItem(18, "api", [17]),
    testItem(19, "web", [18]),
  ]);

  it("rebuilds mid-chain state and continues at the frozen stage, re-attaching the GC-removed worktree to the existing branch", () => {
    const { adapters, engine, drainAll } = resumedHarness(model, [
      evidence({ itemNumber: 17, stageLabels: ["sc:done"], branchExists: true, pullRequestExists: true }),
      evidence({ itemNumber: 18, stageLabels: ["sc:simplifying"], branchExists: true, pullRequestExists: true }),
      evidence({ itemNumber: 19, stageLabels: ["sc:blocked"] }),
    ]);
    expect(adapters.log).toEqual([
      "label #19 sc:blocked",
      "label #18 sc:simplifying",
      "git create-branch [api] feat/18-slice-18 from integration/toy-demo",
      "git sync [api] feat/18-slice-18 onto integration/toy-demo",
      "spawn simplify #18 [api] feat/18-slice-18",
    ]);
    drainAll();
    expect(spawnOrder(adapters.log)).toEqual([
      "spawn simplify #18",
      "spawn review #18",
      "spawn develop #19",
      "spawn simplify #19",
      "spawn review #19",
    ]);
    expect(mergeOrder(adapters.log)).toEqual(["merge-pr #18", "merge-pr #19"]);
    expect([...engine.phases().values()].every((phase) => phase === "done")).toBe(true);
  });

  it("re-runs the stage the frozen label names, accepting simplify-then-verify for a verify-time crash", () => {
    const { adapters } = resumedHarness(testModel([testItem(18, "api")]), [
      evidence({ itemNumber: 18, stageLabels: ["sc:in-review"], branchExists: true, pullRequestExists: true }),
    ]);
    expect(spawnOrder(adapters.log)).toEqual(["spawn review #18"]);
  });

  it("keeps a parked item parked, and resumes it when the human already flipped the label back", () => {
    const parked = resumedHarness(testModel([testItem(18, "api", [], "held")]), [
      evidence({ itemNumber: 18, stageLabels: ["sc:in-review", "sc:needs-human"], branchExists: true }),
    ]);
    expect(parked.engine.phases().get(18)).toBe("parked");
    expect(parked.adapters.log).toEqual([]);

    const flipped = resumedHarness(testModel([testItem(18, "api")]), [
      evidence({ itemNumber: 18, stageLabels: ["sc:in-review", "sc:needs-human"], branchExists: true }),
    ]);
    expect(spawnOrder(flipped.adapters.log)).toEqual(["spawn review #18"]);
  });

  it("clears sc:needs-human when the human already flipped a parked item back before the crash", () => {
    const { adapters } = resumedHarness(testModel([testItem(18, "api")]), [
      evidence({ itemNumber: 18, stageLabels: ["sc:in-review", "sc:needs-human"], branchExists: true }),
    ]);
    expect(adapters.log).toContain("remove-label #18 sc:needs-human");
  });

  it("leaves sc:needs-human alone for a resume that was never parked", () => {
    const { adapters } = resumedHarness(testModel([testItem(18, "api")]), [
      evidence({ itemNumber: 18, stageLabels: ["sc:simplifying"], branchExists: true }),
    ]);
    expect(adapters.log.some((line) => line.includes("sc:needs-human"))).toBe(false);
  });

  it("recomputes sc:queued and sc:blocked from the live dependency graph", () => {
    const { adapters, engine } = resumedHarness(testModel([testItem(17, "api", [], "done"), testItem(18, "api", [17])]), [
      evidence({ itemNumber: 17, stageLabels: ["sc:done"] }),
      evidence({ itemNumber: 18, stageLabels: ["sc:blocked"] }),
    ]);
    expect(engine.phases().get(18)).toBe("running");
    expect(adapters.log).toContain("label #18 sc:queued");
    expect(branchCreations(adapters.log)).toEqual(["git create-branch [api] feat/18-slice-18 from integration/toy-demo"]);
  });

  it("treats a merged pull request as done even though the squash merge deleted its branch", () => {
    const { adapters, engine } = resumedHarness(
      testModel([testItem(18, "api"), testItem(19, "web", [18])]),
      [
        evidence({
          itemNumber: 18,
          stageLabels: ["sc:in-review"],
          branchExists: false,
          pullRequestExists: true,
          pullRequestMerged: true,
        }),
        evidence({ itemNumber: 19, stageLabels: ["sc:blocked"] }),
      ],
    );
    expect(engine.phases().get(18)).toBe("done");
    expect(adapters.log).toContain("label #18 sc:done");
    expect(mergeOrder(adapters.log)).toEqual([]);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #19"]);
  });

  it("parks a stranded item whose branch is gone but whose pull request never merged", () => {
    const { adapters, engine } = resumedHarness(testModel([testItem(18, "api")]), [
      evidence({ itemNumber: 18, stageLabels: ["sc:developing"], branchExists: false, pullRequestExists: true }),
    ]);
    expect(engine.phases().get(18)).toBe("parked");
    expect(adapters.log).toContain("add-label #18 sc:needs-human");
    expect(spawnOrder(adapters.log)).toEqual([]);
    const body = adapters.comments.find((entry) => entry.itemNumber === 18)?.body ?? "";
    expect(body).toContain("its branch is gone from git but its pull request never merged");
  });

  it("re-runs only the verify gate for a reviewed item whose label a GitHub outage left at sc:developing", () => {
    const { adapters } = resumedHarness(testModel([testItem(18, "api")]), [
      evidence({ itemNumber: 18, stageLabels: ["sc:developing"], branchExists: true, pullRequestExists: true, auditedStageIndex: 3 }),
    ]);
    expect(spawnOrder(adapters.log)).toEqual([]);
    const gitLines = adapters.log.filter((line) => line.startsWith("git "));
    expect(gitLines[0]).toBe("git create-branch [api] feat/18-slice-18 from integration/toy-demo");
    expect(gitLines[1]).toMatch(/^git rebase \[api\] feat\/18-slice-18/);
    expect(gitLines[2]).toBe("git check [api] feat/18-slice-18");
  });

  it("fails fast on evidence that cannot be true", () => {
    const single = testModel([testItem(18, "api")]);
    expect(() =>
      resumedHarness(single, [evidence({ itemNumber: 18, stageLabels: ["sc:needs-human"] })]),
    ).toThrow("sc:needs-human without the frozen stage label");
    expect(() =>
      resumedHarness(single, [evidence({ itemNumber: 18, stageLabels: ["sc:developing", "sc:simplifying"] })]),
    ).toThrow("conflicting stage labels");
    expect(() => resumedHarness(single, [evidence({ itemNumber: 99 })])).toThrow("not in the run model");
    expect(() =>
      resumedHarness(single, [evidence({ itemNumber: 18 }), evidence({ itemNumber: 18 })]),
    ).toThrow("duplicate resume evidence for #18");
  });
});

describe("poll driver", () => {
  const allAdmitted = snapshot({
    subIssues: [
      item(),
      item({ number: 18, title: "toy: api slice B", blockedBy: [17] }),
      item({
        number: 19,
        title: "toy: web slice C",
        labels: ["repo:web", "ready-for-agent"],
        blockedBy: [18],
      }),
    ],
  });
  const oneItem = snapshot({ subIssues: [item()] });

  function watchedEngine(first: RunSnapshot) {
    const adapters = new RecordingAdapters();
    const engine = new Engine(modelFrom(first), adapters, { workerCap: 1 });
    engine.start();
    return { adapters, engine };
  }

  it("applies a mid-run fixture mutation on the next tick", async () => {
    const before = snapshot();
    const { adapters, engine } = watchedEngine(before);
    const after = snapshot({
      subIssues: [...before.subIssues, item({ number: 20, title: "toy: api slice D" })],
    });
    const loop = new WatchLoop({
      fetchSnapshot: async () => after,
      engine,
      intervalMs: 30_000,
      sleep: async () => undefined,
    });
    await loop.tick();
    expect(adapters.log).toContain("label #20 sc:queued");
    expect(engine.phases().get(20)).toBe("queued");
  });

  it("reports a snapshot that stopped satisfying the publish contract instead of applying it", async () => {
    const { adapters, engine } = watchedEngine(snapshot());
    const broken = snapshot({ subIssues: [item({ labels: ["ready-for-agent"] })] });
    const reported: string[][] = [];
    const loop = new WatchLoop({
      fetchSnapshot: async () => broken,
      engine,
      intervalMs: 30_000,
      onInvalidSnapshot: (errors) => reported.push(errors),
    });
    const marker = adapters.log.length;
    await loop.tick();
    expect(reported[0]?.join("\n")).toContain("expected exactly one repo:* label");
    expect(adapters.log.slice(marker)).toEqual([]);
  });

  it("throws on an invalid snapshot when no handler is supplied", async () => {
    const { engine } = watchedEngine(snapshot());
    const loop = new WatchLoop({
      fetchSnapshot: async () => snapshot({ parent: { ...snapshot().parent, labels: [] } }),
      engine,
      intervalMs: 30_000,
    });
    await expect(loop.tick()).rejects.toThrow("no longer satisfies the publish contract");
  });

  it("polls on the injected interval until stopped, with no timers of its own", async () => {
    const { engine } = watchedEngine(snapshot());
    let fetches = 0;
    const sleeps: number[] = [];
    const loop = new WatchLoop({
      fetchSnapshot: async () => {
        fetches += 1;
        return snapshot();
      },
      engine,
      intervalMs: 45_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) loop.stop();
      },
    });
    await loop.run();
    expect(fetches).toBe(2);
    expect(sleeps).toEqual([45_000, 45_000]);
  });

  it("routes a rejecting fetch to onError and keeps polling", async () => {
    const { engine } = watchedEngine(snapshot());
    const errors: string[] = [];
    const sleeps: number[] = [];
    let fetches = 0;
    const loop = new WatchLoop({
      fetchSnapshot: async () => {
        fetches += 1;
        if (fetches === 1) throw new Error("gh unreachable");
        return snapshot();
      },
      engine,
      intervalMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) loop.stop();
      },
      onError: (error) => errors.push(error.message),
    });
    await loop.run();
    expect(errors).toEqual(["gh unreachable"]);
    expect(fetches).toBe(2);
  });

  it("routes a throwing applySnapshot to onError instead of ending the run", async () => {
    const errors: string[] = [];
    const sleeps: number[] = [];
    const loop = new WatchLoop({
      fetchSnapshot: async () => snapshot(),
      engine: {
        applySnapshot: () => {
          throw new Error("engine blew up");
        },
      },
      intervalMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) loop.stop();
      },
      onError: (error) => errors.push(error.message),
    });
    await loop.run();
    expect(errors).toEqual(["engine blew up", "engine blew up"]);
  });

  it("skips a tick that starts while another one is still in flight", async () => {
    const { engine } = watchedEngine(snapshot());
    let fetches = 0;
    let release: (() => void) | undefined;
    const loop = new WatchLoop({
      fetchSnapshot: async () => {
        fetches += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return snapshot();
      },
      engine,
      intervalMs: 1_000,
    });
    const inFlight = loop.tick();
    await loop.tick();
    expect(fetches).toBe(1);
    release?.();
    await inFlight;
    expect(fetches).toBe(1);
  });

  it("rejects a non-positive poll interval", () => {
    const { engine } = watchedEngine(snapshot());
    expect(() => new WatchLoop({ fetchSnapshot: async () => snapshot(), engine, intervalMs: 0 })).toThrow(
      "intervalMs must be a positive integer",
    );
  });

  it("returns as soon as stopWhen says the run is over instead of polling forever", async () => {
    const { engine } = watchedEngine(snapshot());
    let settled = false;
    let fetches = 0;
    const sleeps: number[] = [];
    const loop = new WatchLoop({
      fetchSnapshot: async () => {
        fetches += 1;
        return snapshot();
      },
      engine,
      intervalMs: 45_000,
      stopWhen: () => settled,
      sleep: async (ms) => {
        sleeps.push(ms);
        settled = true;
      },
    });
    await loop.run();
    expect(fetches).toBe(1);
    expect(sleeps).toEqual([45_000]);
  });

  it("returns without sleeping when the run is already over after the first poll", async () => {
    const { engine } = watchedEngine(snapshot());
    const sleeps: number[] = [];
    const loop = new WatchLoop({
      fetchSnapshot: async () => snapshot(),
      engine,
      intervalMs: 45_000,
      stopWhen: () => true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await loop.run();
    expect(sleeps).toEqual([]);
  });

  it("keeps polling while the engine has work in flight", async () => {
    const { engine } = watchedEngine(snapshot());
    const sleeps: number[] = [];
    const loop = new WatchLoop({
      fetchSnapshot: async () => snapshot(),
      engine,
      intervalMs: 1_000,
      stopWhen: () => engine.complete(),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) loop.stop();
      },
    });
    await loop.run();
    expect(engine.complete()).toBe(false);
    expect(sleeps).toHaveLength(3);
  });

  it("drives a whole run to done and stops", async () => {
    const adapters = new RecordingAdapters();
    const engine = new Engine(modelFrom(allAdmitted), adapters, { workerCap: 1 });
    engine.start();
    const loop = new WatchLoop({
      fetchSnapshot: async () => allAdmitted,
      engine,
      intervalMs: 1_000,
      stopWhen: () => engine.complete(),
      sleep: async () => {
        const next = adapters.pending.shift();
        if (next) engine.handleStageCompletion({ ...next, outcome: "success" });
      },
    });
    await loop.run();
    expect(engine.complete()).toBe(true);
    expect(mergeOrder(adapters.log)).toEqual(["merge-pr #17", "merge-pr #18", "merge-pr #19"]);
    expect(adapters.closed.map((entry) => entry.itemNumber)).toEqual([17, 18, 19]);
  });

  it("keeps polling instead of exiting while a held item could still be admitted", async () => {
    const adapters = new RecordingAdapters();
    const engine = new Engine(modelFrom(snapshot()), adapters, { workerCap: 1 });
    engine.start();
    const sleeps: number[] = [];
    const loop = new WatchLoop({
      fetchSnapshot: async () => snapshot(),
      engine,
      intervalMs: 1_000,
      stopWhen: () => engine.complete(),
      sleep: async (ms) => {
        sleeps.push(ms);
        const next = adapters.pending.shift();
        if (next) engine.handleStageCompletion({ ...next, outcome: "success" });
        if (sleeps.length === 20) loop.stop();
      },
    });
    await loop.run();
    expect(engine.phases().get(17)).toBe("done");
    expect(engine.phases().get(18)).toBe("done");
    expect(engine.phases().get(19)).toBe("held");
    expect(engine.complete()).toBe(false);
    expect(engine.stalled()).toEqual({ parked: 0, held: 1, blocked: 0 });
    expect(sleeps).toHaveLength(20);
  });

  it("keeps polling while a parked item waits for its label flip, then finishes once it is re-admitted", async () => {
    const adapters = new RecordingAdapters();
    const engine = new Engine(modelFrom(oneItem), adapters, { workerCap: 1 });
    engine.start();
    let polls = 0;
    const loop = new WatchLoop({
      fetchSnapshot: async () => {
        polls += 1;
        return oneItem;
      },
      engine,
      intervalMs: 1_000,
      stopWhen: () => engine.complete(),
      sleep: async () => {
        const next = adapters.pending.shift();
        if (!next) return;
        const outcome = polls === 1 && next.stage === "develop" ? "failure" : "success";
        engine.handleStageCompletion({ ...next, outcome });
      },
    });
    await loop.run();
    expect(polls).toBeGreaterThan(1);
    expect(engine.complete()).toBe(true);
    expect(mergeOrder(adapters.log)).toEqual(["merge-pr #17"]);
  });
});
