import { describe, expect, it } from "vitest";
import { RebaseConflictError } from "../src/engine/adapters.js";
import type { WorkerSlots } from "../src/engine/engine.js";
import { harness, spawnOrder, testItem, testModel } from "./fixtures.js";

class BudgetSlots implements WorkerSlots {
  outstanding = 0;
  constructor(public budget: number) {}
  tryAcquire(): boolean {
    if (this.outstanding >= this.budget) return false;
    this.outstanding += 1;
    return true;
  }
  release(): void {
    this.outstanding -= 1;
  }
}

function slotted(budget: number, workerCap: number, itemNumbers: number[] = [17, 18, 19]) {
  const slots = new BudgetSlots(budget);
  const model = testModel(itemNumbers.map((number) => testItem(number, "api")));
  return { ...harness(model, workerCap, slots), slots };
}

describe("worker slots", () => {
  it("starts nothing while slots are denied and starts work on refill once granted", () => {
    const { adapters, slots, engine } = slotted(0, 3);
    engine.start();
    expect(adapters.spawned).toEqual([]);

    slots.budget = 1;
    engine.refill();

    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17"]);
  });

  it("runs only as many stages as the shared budget allows", () => {
    const { slots, engine } = slotted(1, 3);
    engine.start();

    expect(engine.running()).toBe(1);
    expect(slots.outstanding).toBe(1);
  });

  it("releases every slot once all items complete", () => {
    const { slots, engine, drainAll } = slotted(2, 3);
    engine.start();
    drainAll();

    expect([...engine.phases().values()].every((phase) => phase === "done")).toBe(true);
    expect(slots.outstanding).toBe(0);
  });

  it("releases the slot of a start the sandbox refused", () => {
    const { adapters, slots, engine } = slotted(3, 3, [17]);
    adapters.failSpawn = () => new Error("sandbox down");
    engine.start();

    expect(engine.phases().get(17)).toBe("parked");
    expect(slots.outstanding).toBe(0);
  });

  it("ignores refill before the run started", () => {
    const { adapters, engine } = slotted(3, 3, [17]);
    engine.refill();

    expect(adapters.spawned).toEqual([]);
    expect(engine.running()).toBe(0);
  });

  it("keeps one slot across the resolve hand-off into verify and releases it once", () => {
    const { adapters, slots, engine, complete } = slotted(3, 3, [17]);
    engine.start();
    complete(17, "develop");
    complete(17, "simplify");
    complete(17, "review");
    let gateConflicts = 1;
    adapters.failRebase = (repo, branch) =>
      gateConflicts-- > 0
        ? new RebaseConflictError(repo, branch, "integration/toy-demo", ["src/a.ts"], "CONFLICT (content)")
        : undefined;
    engine.handleStageCompletion({ itemNumber: 17, stage: "verify", outcome: "success", resolved: true });

    expect(slots.outstanding).toBe(1);
    expect(engine.running()).toBe(1);

    complete(17, "verify");

    expect(engine.phases().get(17)).toBe("done");
    expect(slots.outstanding).toBe(0);
  });

  it("releases the slot of a verify gate that could not rebase", () => {
    const { adapters, slots, engine, complete } = slotted(3, 3, [17]);
    engine.start();
    complete(17, "develop");
    complete(17, "simplify");
    adapters.failRebase = () => new Error("worktree gone");
    complete(17, "review");

    expect(engine.phases().get(17)).toBe("parked");
    expect(slots.outstanding).toBe(0);
  });

  it("releases the slot of a stage that ends waiting", () => {
    const { slots, engine } = slotted(3, 3, [17]);
    engine.start();
    engine.handleStageCompletion({ itemNumber: 17, stage: "develop", outcome: "waiting", waitReason: "auth" });

    expect(engine.phases().get(17)).toBe("waiting");
    expect(slots.outstanding).toBe(0);
  });

  it("releases the slot of a cancelled stage", () => {
    const { slots, engine } = slotted(3, 3, [17]);
    engine.start();

    engine.cancelItem(17);

    expect(slots.outstanding).toBe(0);
  });
});
