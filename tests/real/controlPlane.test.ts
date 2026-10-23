import { describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/engine.js";
import { controlPlaneHost, type ControlPlaneDeps, type ParentLease } from "../../src/real/controlPlane.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import type { GcReport } from "../../src/real/gc.js";
import { harness, spawnOrder, testItem, testModel, type Harness } from "../fixtures.js";
import { fsWith, testConfig, testLayout } from "./support.js";

const LOCK_PATH = "W:/lock";

function emptyReport(): GcReport {
  return { containers: [], networks: [], volumes: [], worktrees: [], failures: [] };
}

function fakes(overrides: Partial<ControlPlaneDeps> = {}) {
  const events: string[] = [];
  let lockHeld = false;
  const deps: ControlPlaneDeps = {
    runner: new RecordingCommandRunner(),
    fs: fsWith({}),
    layout: testLayout(),
    loadConfig: () => testConfig(),
    acquireLock: () => {
      if (lockHeld) throw new Error("lock already held");
      lockHeld = true;
      events.push("lock");
      return LOCK_PATH;
    },
    releaseLock: (path) => {
      lockHeld = false;
      events.push(`unlock ${path}`);
    },
    collectOrphans: () => {
      events.push("gc");
      return emptyReport();
    },
    probeAuth: () => {
      events.push("probe");
      return Promise.resolve({ ok: true, reason: undefined, detail: undefined });
    },
    onProcessExit: () => () => undefined,
    ...overrides,
  };
  const host = controlPlaneHost({ hubRepo: "example-org/hub", globalCap: 2, log: () => undefined }, deps);
  return { host, events, isLocked: (): boolean => lockHeld };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function waitOnAuth(engine: Engine, itemNumber: number): void {
  engine.handleStageCompletion({ itemNumber, stage: "develop", outcome: "waiting", waitReason: "auth" });
}

function attachedSibling(lease: ParentLease, itemNumber: number): Harness {
  let engine: Engine | undefined;
  const slots = lease.plane.broker.slotsFor({ refill: () => engine?.refill() });
  const sibling = harness(testModel([testItem(itemNumber, "api")]), 1, slots, lease.plane.hold);
  engine = sibling.engine;
  lease.attach(sibling.engine);
  sibling.engine.start();
  return sibling;
}

describe("control plane host", () => {
  it("boots once for concurrent parents and tears down after the last lease", () => {
    const { host, events, isLocked } = fakes();

    const first = host.acquire();
    const second = host.acquire();

    expect(events).toEqual(["lock", "gc"]);
    expect(second.plane).toBe(first.plane);
    first.release();
    expect(isLocked()).toBe(true);
    second.release();
    second.release();
    expect(isLocked()).toBe(false);
    expect(host.active()).toBe(false);
    expect(events).toEqual(["lock", "gc", `unlock ${LOCK_PATH}`]);
  });

  it("boots a fresh plane with a new gc after everything released", () => {
    const { host, events } = fakes();

    const first = host.acquire();
    first.release();
    const again = host.acquire();

    expect(events).toEqual(["lock", "gc", `unlock ${LOCK_PATH}`, "lock", "gc"]);
    expect(again.plane).not.toBe(first.plane);
  });

  it("marks a lease shared only while a sibling holds the plane", () => {
    const { host } = fakes();

    const first = host.acquire();
    const second = host.acquire();
    first.release();
    second.release();
    const fresh = host.acquire();

    expect([first.shared, second.shared, fresh.shared]).toEqual([false, true, false]);
  });

  it("leaves no lock and no plane when boot fails", () => {
    const { host, isLocked } = fakes({
      collectOrphans: () => {
        throw new Error("docker gone");
      },
    });

    expect(() => host.acquire()).toThrow("docker gone");
    expect(isLocked()).toBe(false);
    expect(host.active()).toBe(false);
  });

  it("releases the auth hold on every attached engine when the shared probe recovers", async () => {
    const { host, events } = fakes();
    const lease = host.acquire();
    const first = attachedSibling(lease, 17);
    const second = attachedSibling(host.acquire(), 18);
    await settle();
    waitOnAuth(first.engine, 17);
    waitOnAuth(second.engine, 18);

    lease.plane.pollAuth();
    await settle();

    expect(events.filter((event) => event === "probe")).toHaveLength(1);
    expect(first.engine.authHeld()).toBe(false);
    expect(spawnOrder(first.adapters.log)).toEqual(["spawn develop #17", "spawn develop #17"]);
    expect(spawnOrder(second.adapters.log)).toEqual(["spawn develop #18", "spawn develop #18"]);
  });

  it("probes when an engine only has auth-waiting items after a sibling cleared the hold", async () => {
    const { host, events } = fakes();
    const lease = host.acquire();
    const first = attachedSibling(lease, 17);
    const second = attachedSibling(host.acquire(), 18);
    await settle();
    waitOnAuth(first.engine, 17);
    waitOnAuth(second.engine, 18);
    first.engine.retryItem(17);
    expect(second.engine.authHeld()).toBe(false);

    lease.plane.pollAuth();
    await settle();

    expect(events.filter((event) => event === "probe")).toHaveLength(1);
    expect(spawnOrder(second.adapters.log)).toEqual(["spawn develop #18", "spawn develop #18"]);
  });

  it("applies a new global cap to the live broker and to the next boot", () => {
    const { host } = fakes();
    expect(host.globalCap()).toBe(2);
    const lease = host.acquire();
    host.setGlobalCap(5);
    expect(lease.plane.broker.cap()).toBe(5);
    lease.release();
    host.setGlobalCap(3);
    expect(host.acquire().plane.broker.cap()).toBe(3);
    expect(() => host.setGlobalCap(0)).toThrow(/positive integer/);
    expect(host.globalCap()).toBe(3);
  });
});
