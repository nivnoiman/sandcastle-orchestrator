import { describe, expect, it } from "vitest";
import type { AuthProbeResult } from "../../src/real/authProbe.js";
import { AUTH_PROBE_BACKOFF_MS, createAuthHoldProbe, scrubProbeError } from "../../src/real/authHold.js";

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

describe("auth recheck", () => {
  function recheckHarness(results: AuthProbeResult[]) {
    let held = true;
    let probes = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = createAuthHoldProbe({
      held: () => held,
      probe: async () => {
        probes += 1;
        await gate;
        return results.shift() ?? rejected();
      },
      onRecovered: () => {
        held = false;
      },
      log: () => undefined,
      now: () => 0,
    });
    return { probe, release, isHeld: () => held, probes: () => probes };
  }

  it("lifts the hold when the probe passes, ignoring the backoff", async () => {
    const test = recheckHarness([rejected(), { ok: true, reason: undefined, detail: undefined }]);
    test.release();

    expect((await test.probe.recheck()).ok).toBe(false);
    expect(test.isHeld()).toBe(true);
    expect((await test.probe.recheck()).ok).toBe(true);
    expect(test.isHeld()).toBe(false);
  });

  it("shares one probe between a double click and a background poll", async () => {
    const test = recheckHarness([{ ok: true, reason: undefined, detail: undefined }]);

    const first = test.probe.recheck();
    const second = test.probe.recheck();
    test.probe.poll();
    test.release();

    expect(await first).toBe(await second);
    expect(test.probes()).toBe(1);
  });

  it("scrubs credentials out of a probe failure", () => {
    const error = scrubProbeError(
      'claude failed: Authorization: Bearer abc.def-ghi_jkl CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secretsecret "accessToken":"tok_1234567890" key ' +
        "A".repeat(40),
      "auth",
    );

    expect(error).not.toMatch(/abc\.def|secretsecret|tok_1234567890|AAAAAAAAAA/);
    expect(error).toContain("claude failed");
    expect(scrubProbeError("login failed. ".repeat(60), undefined)).toHaveLength(501);
    expect(scrubProbeError(undefined, "auth")).toContain("rejected (auth)");
  });
});
