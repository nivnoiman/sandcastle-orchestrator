import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine.js";
import { RecordingAdapters } from "../../src/engine/fakes.js";
import type { AuthRecheck } from "../../src/real/authHold.js";
import { UiController, type StartSessionRequest } from "../../src/ui/controller.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { item, parent, snapshot } from "../fixtures.js";

const PARENT = 10;
const WAITING = 11;
const PARKED = 12;

let server: UiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function heldRun(probe: () => Promise<AuthRecheck>) {
  let engine: Engine | undefined;
  const controller = new UiController({
    mode: "real",
    hubRepo: "example-org/hub",
    startCap: 2,
    listParents: () => Promise.resolve([]),
    loadSnapshot: () =>
      Promise.resolve(snapshot({ parent: parent({ number: PARENT }), subIssues: [item({ number: WAITING }), item({ number: PARKED })] })),
    startSession: (request: StartSessionRequest) => {
      engine = new Engine(request.model, new RecordingAdapters(), { workerCap: 2 });
      engine.start();
      engine.handleStageCompletion({ itemNumber: WAITING, stage: "develop", outcome: "waiting", waitReason: "auth" });
      engine.handleStageCompletion({ itemNumber: PARKED, stage: "develop", outcome: "failure", detail: "tests red" });
      const lift = async (): Promise<AuthRecheck> => {
        const result = await probe();
        if (result.ok) engine?.releaseAuthHold();
        return result;
      };
      return { engine, recheckAuth: lift, tick: () => undefined, stop: () => undefined };
    },
    now: () => new Date("2026-10-21T09:00:00.000Z"),
  });
  return { controller, engine: (): Engine => engine ?? (() => { throw new Error("no run"); })() };
}

const PASS: AuthRecheck = { ok: true, error: undefined };

describe("auth recheck", () => {
  it("lifts the hold, resumes waiting items and leaves parked ones alone", async () => {
    const { controller, engine } = heldRun(() => Promise.resolve(PASS));
    await controller.startRun({ parent: PARENT, cap: 2 });
    expect(controller.state().hold?.reason).toBe("auth");

    const result = await controller.recheckAuth(PARENT);

    expect(result.ok).toBe(true);
    expect(controller.state().hold).toBeUndefined();
    expect(engine().phases().get(WAITING)).not.toBe("waiting");
    expect(engine().phases().get(PARKED)).toBe("parked");
  });

  it("keeps the hold on failure and surfaces the probe error in the state", async () => {
    const { controller, engine } = heldRun(() => Promise.resolve({ ok: false, error: "OAuth session expired" }));
    await controller.startRun({ parent: PARENT, cap: 2 });

    const result = await controller.recheckAuth(PARENT);

    expect(result).toEqual({ ok: false, error: "OAuth session expired" });
    const state = controller.state();
    expect(state.hold).toEqual({ reason: "auth", until: undefined, probe: { running: false, error: "OAuth session expired" } });
    expect(state.runs[0]?.hold?.probe?.error).toBe("OAuth session expired");
    expect(engine().phases().get(WAITING)).toBe("waiting");
  });

  it("runs one probe for a double click and shows it running meanwhile", async () => {
    let probes = 0;
    let finish: (result: AuthRecheck) => void = () => undefined;
    const { controller } = heldRun(() => {
      probes += 1;
      return new Promise<AuthRecheck>((resolve) => {
        finish = resolve;
      });
    });
    await controller.startRun({ parent: PARENT, cap: 2 });

    const first = controller.recheckAuth(PARENT);
    const second = controller.recheckAuth(PARENT);
    expect(controller.state().hold?.probe?.running).toBe(true);
    finish(PASS);

    expect(await first).toBe(await second);
    expect(probes).toBe(1);
    expect(controller.state().hold).toBeUndefined();
  });

  it("scrubs credentials from a probe that throws", async () => {
    const { controller } = heldRun(() => Promise.reject(new Error("boom CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefgh")));
    await controller.startRun({ parent: PARENT, cap: 2 });

    const result = await controller.recheckAuth(PARENT);

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("sk-ant");
    expect(JSON.stringify(controller.state())).not.toContain("sk-ant");
  });

  it("refuses a run that is not held on credentials", async () => {
    const { controller, engine } = heldRun(() => Promise.resolve(PASS));
    await controller.startRun({ parent: PARENT, cap: 2 });
    engine().releaseAuthHold();

    await expect(controller.recheckAuth(PARENT)).rejects.toThrow("not held on agent credentials");
  });

  it("answers POST /api/runs/:parent/auth/recheck only with the sandcastle header", async () => {
    const { controller } = heldRun(() => Promise.resolve(PASS));
    await controller.startRun({ parent: PARENT, cap: 2 });
    server = await startUiServer(controller, 0);
    const url = `${server.url}/api/runs/${PARENT}/auth/recheck`;

    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    const ok = await fetch(url, { method: "POST", headers: { "x-sandcastle": "1" } });
    expect(await ok.json()).toEqual({ ok: true, result: { ok: true } });
    expect((await fetch(url, { method: "POST", headers: { "x-sandcastle": "1" } })).status).toBe(409);
  });
});
