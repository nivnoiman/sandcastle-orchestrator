import { describe, expect, it } from "vitest";
import { TRANSIENT_BACKOFF_MS, transientBackoffMs, transientSignature } from "../src/engine/transient.js";
import { harness, spawnOrder, testItem, testModel } from "./fixtures.js";

const NOW = 1_757_000_000_000;
const REFUSED = "API Error: Unable to connect to API (ConnectionRefused)";

describe("transientSignature", () => {
  it("recognises network, GitHub and Claude API outages", () => {
    expect(transientSignature(REFUSED)).toBe("API Error: Unable to connect to API");
    expect(transientSignature("npm error code ECONNRESET")).toBe("ECONNRESET");
    expect(transientSignature("fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com")).toBe(
      "Could not resolve host",
    );
    expect(transientSignature("error connecting to api.github.com")).toBe("error connecting to api.github.com");
    expect(transientSignature("The requested URL returned error: 503")).toBe("The requested URL returned error: 503");
  });

  it("leaves real failures alone", () => {
    expect(transientSignature("error TS2345: Argument of type 'string'")).toBeUndefined();
    expect(transientSignature("CONFLICT (content): Merge conflict in src/a.ts")).toBeUndefined();
    expect(transientSignature("The requested URL returned error: 403")).toBeUndefined();
    expect(transientSignature(undefined)).toBeUndefined();
  });

  it("backs off 2, 5, 10, 20 then 30 minutes", () => {
    expect([1, 2, 3, 4, 5].map(transientBackoffMs)).toEqual([2, 5, 10, 20, 30].map((minutes) => minutes * 60_000));
  });
});

describe("a transient failure mid-run", () => {
  it("waits and re-runs the same stage after the backoff instead of parking", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api")]));
    engine.start();
    engine.handleStageCompletion({ itemNumber: 17, stage: "develop", outcome: "waiting", waitReason: "transient", detail: REFUSED });

    expect(engine.phases().get(17)).toBe("waiting");
    expect(adapters.comments).toEqual([]);
    expect(adapters.log).not.toContain("add-label #17 sc:needs-human");

    engine.tick(NOW);
    engine.tick(NOW + transientBackoffMs(1) - 1);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17"]);

    engine.tick(NOW + transientBackoffMs(1));
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn develop #17"]);
  });

  it("does not hold the rest of the run while one item waits out a transient failure", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api"), testItem(18, "api")]), 1);
    engine.start();
    engine.handleStageCompletion({ itemNumber: 17, stage: "develop", outcome: "waiting", waitReason: "transient", detail: REFUSED });
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn develop #18"]);
    expect(engine.holdState()).toBeUndefined();
  });

  it("parks with the original reason once the retries are spent", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api")]));
    engine.start();
    let now = NOW;
    for (let retry = 0; retry <= TRANSIENT_BACKOFF_MS.length; retry += 1) {
      engine.handleStageCompletion({ itemNumber: 17, stage: "develop", outcome: "waiting", waitReason: "transient", detail: REFUSED });
      if (retry === TRANSIENT_BACKOFF_MS.length) break;
      engine.tick(now);
      now += TRANSIENT_BACKOFF_MS[retry]!;
      engine.tick(now);
    }
    expect(engine.phases().get(17)).toBe("parked");
    expect(adapters.comments.map((comment) => comment.body).join("\n")).toMatch(/still failing after 5 transient retries/);
  });

  it("gives a stage a fresh retry budget once a stage succeeds", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    let now = NOW;
    for (let retry = 0; retry < TRANSIENT_BACKOFF_MS.length; retry += 1) {
      engine.handleStageCompletion({ itemNumber: 17, stage: "develop", outcome: "waiting", waitReason: "transient", detail: REFUSED });
      engine.tick(now);
      now += TRANSIENT_BACKOFF_MS[retry]!;
      engine.tick(now);
    }
    complete(17, "develop");
    engine.handleStageCompletion({ itemNumber: 17, stage: "simplify", outcome: "waiting", waitReason: "transient", detail: REFUSED });
    expect(engine.phases().get(17)).toBe("waiting");
    expect(adapters.comments).toEqual([]);
  });

  it("waits instead of parking when the branch cannot be created because GitHub is unreachable", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api")]));
    adapters.failCreateItemBranch = () => new Error("fatal: unable to access 'https://github.com/': Could not resolve host: github.com");
    engine.start();
    expect(engine.phases().get(17)).toBe("waiting");
    expect(adapters.notes.join("\n")).toMatch(/creating .* failed: Could not resolve host — retry 1\/5 after 2m/);
    adapters.failCreateItemBranch = undefined;
    engine.tick(NOW);
    engine.tick(NOW + transientBackoffMs(1));
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17"]);
  });

  it("still parks a rebase that fails for a real reason", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    adapters.failSync = () => new Error("fatal: needs a single revision");
    complete(17, "develop");
    expect(engine.phases().get(17)).toBe("parked");
  });
});
