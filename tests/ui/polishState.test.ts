import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine.js";
import { RecordingAdapters } from "../../src/engine/fakes.js";
import { idlePolish, type PolishStatus } from "../../src/real/polish/runPolish.js";
import { UiController, type Session } from "../../src/ui/controller.js";
import { snapshot, testItem, testModel } from "../fixtures.js";
import { openPage, pageState } from "./pageHarness.js";

const PR_URL = "https://github.com/example-org/api/pull/1";

function boot() {
  let status: PolishStatus = idlePolish();
  const engine = new Engine(testModel([testItem(17, "api")]), new RecordingAdapters(), { workerCap: 1 });
  const session: Session = { engine, polish: () => status, tick: () => undefined, stop: () => undefined };
  const controller = new UiController({
    mode: "real",
    hubRepo: "example-org/hub",
    startCap: 1,
    listParents: () => Promise.resolve([]),
    loadSnapshot: () => Promise.resolve(snapshot()),
    startSession: () => session,
    now: () => new Date("2026-10-21T09:00:00.000Z"),
  });
  return { controller, set: (next: PolishStatus) => (status = next) };
}

describe("polish in the ui state", () => {
  it("is idle before any run starts", () => {
    expect(boot().controller.state().polish.phase).toBe("idle");
  });

  it("notes each phase change in the feed once, and a revert as a warning", async () => {
    const { controller, set } = boot();
    await controller.startRun({ parent: 16, cap: 1 });
    set(idlePolish("running"));
    controller.tick();
    controller.tick();
    set({ phase: "reverted", pullRequests: [PR_URL], reason: "api: checks red" });
    controller.tick();

    const lines = controller.state().feed.filter((line) => line.message.startsWith("polish"));
    expect(lines.map((line) => line.message)).toEqual(["polish: running", "polish: reverted — api: checks red"]);
    expect(lines[1]?.kind).toBe("warn");
    expect(controller.state().polish.pullRequests).toEqual([PR_URL]);
  });
});

describe("polish chip", () => {
  it("is hidden while polish is idle and shows the phase once it runs", async () => {
    const page = await openPage({ state: pageState() });
    expect(page.el("polish").hidden).toBe(true);
    await page.emitState(pageState({ polish: { phase: "green", pullRequests: [PR_URL], reason: undefined } }));
    expect(page.el("polish").hidden).toBe(false);
    expect(page.el("polish").textContent).toBe("polish: green");
    expect(page.el("polish").className).toBe("chip polish-green");
  });
});
