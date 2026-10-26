import { describe, expect, it } from "vitest";
import { quietInfo } from "../../src/ui/quiet.js";

const START = Date.parse("2026-10-21T09:00:00.000Z");
const view = { phase: "running", phaseSince: new Date(START).toISOString() } as const;
const TIMEOUT = 1200;

function at(secondsAfterStart: number, lastOutputSecond?: number, phase: "running" | "parked" = "running") {
  return quietInfo({
    view: { ...view, phase },
    lastOutputAt: lastOutputSecond === undefined ? undefined : START + lastOutputSecond * 1000,
    nowMs: START + secondsAfterStart * 1000,
    timeoutSeconds: TIMEOUT,
  });
}

describe("quiet threshold", () => {
  it("is off at or below half the idle timeout and on beyond it", () => {
    expect(at(600)).toBeUndefined();
    expect(at(601)).toEqual({ silentSeconds: 601, timeoutSeconds: TIMEOUT });
  });

  it("counts silence from the last output, not from the phase start", () => {
    expect(at(1000, 900)).toBeUndefined();
    expect(at(1600, 900)).toEqual({ silentSeconds: 700, timeoutSeconds: TIMEOUT });
  });

  it("only applies to running items", () => {
    expect(at(5000, undefined, "parked")).toBeUndefined();
  });
});
