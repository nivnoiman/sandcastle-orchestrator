import { describe, expect, it } from "vitest";
import type { AuthProbeResult } from "../../src/real/authProbe.js";
import { AUTH_PROBE_BACKOFF_MS, createAuthHoldProbe } from "../../src/real/authHold.js";

function rejected(): AuthProbeResult {
  return { ok: false, reason: "auth", detail: "OAuth session expired" };
}

function harness(results: AuthProbeResult[]) {
  const calls: number[] = [];
  const lines: string[] = [];
  let held = true;
  let clock = 0;
  const probe = createAuthHoldProbe({
    held: () => held,
    probe: () => {
      calls.push(clock);
      return Promise.resolve(results.shift() ?? rejected());
    },
    onRecovered: () => {
      held = false;
    },
    log: (message) => lines.push(message),
    now: () => clock,
  });
  return {
    calls,
    lines,
    isHeld: (): boolean => held,
    async pollAt(at: number): Promise<void> {
      clock = at;
      probe.poll();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("auth hold probe", () => {
  it("backs off further after every rejection instead of probing every poll", async () => {
    const test = harness([]);

    await test.pollAt(0);
    await test.pollAt(30_000);
    await test.pollAt(AUTH_PROBE_BACKOFF_MS[0]);
    await test.pollAt(AUTH_PROBE_BACKOFF_MS[0] + 30_000);

    expect(test.calls).toEqual([0, AUTH_PROBE_BACKOFF_MS[0]]);
    expect(test.lines.at(-1)).toContain("probing again in 2m");
  });

  it("releases the hold and forgets the backoff once the credentials work", async () => {
    const test = harness([rejected(), { ok: true, reason: undefined, detail: undefined }]);

    await test.pollAt(0);
    await test.pollAt(AUTH_PROBE_BACKOFF_MS[0]);

    expect(test.isHeld()).toBe(false);
    expect(test.calls).toHaveLength(2);
  });

  it("does not probe while the run is not held", async () => {
    const test = harness([{ ok: true, reason: undefined, detail: undefined }]);
    await test.pollAt(0);

    await test.pollAt(3_600_000);

    expect(test.calls).toEqual([0]);
  });
});
