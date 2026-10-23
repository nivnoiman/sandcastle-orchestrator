import { describe, expect, it } from "vitest";
import { RebaseConflictError } from "../src/engine/adapters.js";
import { harness, spawnOrder, testItem, testModel } from "./fixtures.js";

const CONFLICT_FILE = "src/models/Profile.ts";

function conflict(repo: string, branch: string): RebaseConflictError {
  return new RebaseConflictError(repo, branch, "integration/toy-demo", [CONFLICT_FILE], "CONFLICT (content)");
}

describe("two parallel items that touch the same file", () => {
  it("both reach done without a park: the stage agent resolves, the gate agent resolves what is left", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(61, "api"), testItem(62, "api")]), 2);
    engine.start();

    adapters.failSync = (repo, branch) => (branch.startsWith("feat/62") ? conflict(repo, branch) : undefined);
    complete(61, "develop");
    complete(62, "develop");

    expect(adapters.notes.some((note) => note.includes(CONFLICT_FILE))).toBe(true);

    complete(61, "simplify");
    complete(62, "simplify");
    complete(61, "review");
    complete(62, "review");

    adapters.failSync = undefined;
    complete(61, "verify");

    let gateConflicts = 1;
    adapters.failRebase = (repo, branch) => (gateConflicts-- > 0 ? conflict(repo, branch) : undefined);
    engine.handleStageCompletion({ itemNumber: 62, stage: "verify", outcome: "success", resolved: true });
    complete(62, "verify");

    expect(adapters.comments).toEqual([]);
    expect([...engine.phases().values()]).toEqual(["done", "done"]);
    expect(adapters.log).toContain(`spawn resolve #62 [api] ${CONFLICT_FILE}`);
  });

  it("tells the stage agent which files conflict instead of parking before it starts", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(61, "api")]));
    engine.start();
    adapters.failSync = (repo, branch) => conflict(repo, branch);
    complete(61, "develop");

    expect(engine.phases().get(61)).toBe("running");
    expect(adapters.comments).toEqual([]);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #61", "spawn simplify #61"]);
    expect(adapters.notes.join()).toContain("its agent resolves the conflict as its first task");
  });

  it("parks when the rebase fails for a reason no agent can resolve", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(61, "api")]));
    engine.start();
    adapters.failSync = () => new Error("worktree W:/gone is gone");
    complete(61, "develop");

    expect(engine.phases().get(61)).toBe("parked");
    expect(adapters.comments[0]?.body).toContain("worktree W:/gone is gone");
  });
});
