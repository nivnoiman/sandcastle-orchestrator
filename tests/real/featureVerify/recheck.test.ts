import { describe, expect, it } from "vitest";
import { RecheckLedger, selectVerifyMode } from "../../../src/real/featureVerify/recheck.js";

const GREEN = { sha: "base", passed: true };
const diffOf = (patch: string | undefined) => () => patch;

describe("selectVerifyMode", () => {
  it("runs the full command without a recheck, a previous verify, a green last round or a known head", () => {
    expect(selectVerifyMode({ recheck: undefined, last: GREEN, head: "next", diffSince: diffOf("x") }).kind).toBe("full");
    expect(selectVerifyMode({ recheck: "r", last: undefined, head: "next", diffSince: diffOf("x") }).kind).toBe("full");
    expect(selectVerifyMode({ recheck: "r", last: { sha: "base", passed: false }, head: "next", diffSince: diffOf("x") }).kind).toBe("full");
    expect(selectVerifyMode({ recheck: "r", last: GREEN, head: undefined, diffSince: diffOf("x") }).kind).toBe("full");
  });

  it("runs the full command when the base is not reachable", () => {
    expect(selectVerifyMode({ recheck: "r", last: GREEN, head: "next", diffSince: diffOf(undefined) })).toEqual({
      kind: "full",
      reason: "last verified base is not reachable",
    });
  });

  it("skips a repo whose head or content did not change", () => {
    expect(selectVerifyMode({ recheck: "r", last: GREEN, head: "base", diffSince: diffOf("x") })).toEqual({ kind: "skip", base: "base" });
    expect(selectVerifyMode({ recheck: "r", last: GREEN, head: "next", diffSince: diffOf("") })).toEqual({ kind: "skip", base: "base" });
  });

  it("runs the affected command with the diff since the last green commit", () => {
    expect(selectVerifyMode({ recheck: "r", last: GREEN, head: "next", diffSince: diffOf("patch") })).toEqual({
      kind: "affected",
      base: "base",
      patch: "patch",
      command: "r",
    });
  });
});

describe("RecheckLedger", () => {
  it("forgets a repo whose head is unknown", () => {
    const ledger = new RecheckLedger();
    ledger.record("api", "sha", true);
    ledger.record("api", undefined, true);
    expect(ledger.last("api")).toBeUndefined();
  });
});
