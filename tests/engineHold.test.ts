import { describe, expect, it } from "vitest";
import { RunHold, type Engine } from "../src/engine/engine.js";
import { harness, spawnOrder, testItem, testModel } from "./fixtures.js";

const WINDOW_OPENS = 1_757_000_000_000;
const CREDENTIALS_BACK = "agent credentials work again";

function waitOut(engine: Engine, itemNumber: number, resumeAt?: number): void {
  engine.handleStageCompletion({
    itemNumber,
    stage: "develop",
    outcome: "waiting",
    waitReason: resumeAt === undefined ? "auth" : "rate-limit",
    ...(resumeAt === undefined ? {} : { resumeAt }),
  });
}

function siblings() {
  const hold = new RunHold();
  const first = harness(testModel([testItem(17, "api")]), 1, undefined, hold);
  const second = harness(testModel([testItem(18, "api")]), 1, undefined, hold);
  return { hold, first, second };
}

describe("a hold shared across engines", () => {
  it("stops a sibling from starting stages and shows on its hold state", () => {
    const { first, second } = siblings();
    first.engine.start();
    waitOut(first.engine, 17);

    second.engine.start();

    expect(second.adapters.spawned).toEqual([]);
    expect(second.engine.authHeld()).toBe(true);
    expect(second.engine.holdState()).toEqual({ reason: "auth", until: undefined });
  });

  it("resumes every engine's auth-waiting items even after a sibling cleared the hold", () => {
    const { first, second } = siblings();
    first.engine.start();
    second.engine.start();
    waitOut(first.engine, 17);
    waitOut(second.engine, 18);

    first.engine.releaseAuthHold();
    second.engine.releaseAuthHold();

    expect(spawnOrder(first.adapters.log)).toEqual(["spawn develop #17", "spawn develop #17"]);
    expect(spawnOrder(second.adapters.log)).toEqual(["spawn develop #18", "spawn develop #18"]);
    expect(second.adapters.notes.some((note) => note.includes(CREDENTIALS_BACK))).toBe(true);
    expect(second.engine.authHeld()).toBe(false);
  });

  it("stays quiet on a sibling that had nothing waiting on credentials", () => {
    const { first, second } = siblings();
    first.engine.start();
    waitOut(first.engine, 17);
    second.engine.start();

    first.engine.releaseAuthHold();
    second.engine.releaseAuthHold();

    expect(second.adapters.notes.some((note) => note.includes(CREDENTIALS_BACK))).toBe(false);
    expect(spawnOrder(second.adapters.log)).toEqual(["spawn develop #18"]);
  });

  it("resumes a sibling's rate-limited items on its own tick after another engine released the window", () => {
    const { hold, first, second } = siblings();
    first.engine.start();
    second.engine.start();
    waitOut(first.engine, 17, WINDOW_OPENS);
    waitOut(second.engine, 18, WINDOW_OPENS);

    first.engine.tick(WINDOW_OPENS);
    expect(hold.reason).toBeUndefined();
    second.engine.tick(WINDOW_OPENS);

    expect(spawnOrder(first.adapters.log)).toEqual(["spawn develop #17", "spawn develop #17"]);
    expect(spawnOrder(second.adapters.log)).toEqual(["spawn develop #18", "spawn develop #18"]);
  });

  it("keeps the latest window any engine reported", () => {
    const { first, second } = siblings();
    first.engine.start();
    second.engine.start();
    waitOut(first.engine, 17, WINDOW_OPENS + 60_000);
    waitOut(second.engine, 18, WINDOW_OPENS);

    second.engine.tick(WINDOW_OPENS);

    expect(second.engine.holdState()).toEqual({ reason: "rate-limit", until: WINDOW_OPENS + 60_000 });
    expect(spawnOrder(second.adapters.log)).toEqual(["spawn develop #18"]);
  });
});
