import { describe, expect, it } from "vitest";
import { attentionBadge, ATTENTION_KINDS, buildAttention } from "../../../src/ui/board/attention.js";
import { boardProject, READY_PARENT, uiItem, uiRun, uiState } from "./fixtures.js";
import { idlePolish } from "../../../src/ui/state.js";

function everythingWrong() {
  const run = uiRun(
    10,
    [uiItem(1, "parked", { stage: "review", parkReason: "review failed" }), uiItem(2, "running", { stage: "develop", quiet: { silentSeconds: 700, timeoutSeconds: 1200 } })],
    {
      stalled: { parked: 1, held: 0, blocked: 0 },
      featureVerify: { phase: "red", counts: { pass: 1, fail: 2, requiresStg: 0 }, reason: undefined, pullRequests: [], rework: { round: 2, limit: 2 } as never },
      polish: { ...idlePolish(), phase: "reverted", reason: "snapshot drift" },
      hold: { reason: "auth", until: undefined },
    },
  );
  return boardProject("alpha", uiState([run], { hold: { reason: "rate-limit" as never, until: "2026-08-15T10:00:00.000Z" } }), { parents: [READY_PARENT] });
}

describe("Needs Attention ordering", () => {
  it("lists the kinds in the fixed order for one project", () => {
    const died = boardProject("beta", undefined, { status: "died" });
    const entries = buildAttention([everythingWrong(), died], "alpha");
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toEqual(["auth-hold", "parked", "verify-red", "stall", "quiet", "polish-reverted", "integration-ready", "rate-hold", "server-died"]);
    expect(entries.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ATTENTION_KINDS).toHaveLength(9);
  });

  it("puts the current project first and keeps other projects tagged", () => {
    const entries = buildAttention([everythingWrong(), boardProject("beta", undefined, { status: "died" })], "beta");
    expect(entries[0]).toMatchObject({ projectId: "beta", kind: "server-died" });
    expect(entries.slice(1).every((entry) => entry.projectId === "alpha")).toBe(true);
    expect(entries[1]?.projectName).toBe("alpha");
  });

  it("orders parked items by run then item number within a kind", () => {
    const state = uiState([
      uiRun(20, [uiItem(7, "parked", { stage: "develop" })]),
      uiRun(10, [uiItem(9, "parked", { stage: "develop" }), uiItem(3, "parked", { stage: "develop" })]),
    ]);
    const parked = buildAttention([boardProject("a", state)], "a").filter((entry) => entry.kind === "parked");
    expect(parked.map((entry) => `${entry.runNumber}/${entry.itemNumber}`)).toEqual(["10/3", "10/9", "20/7"]);
  });

  it("counts everything but rate-limit Holds in the red badge and shows Integrations ready in purple", () => {
    const entries = buildAttention([everythingWrong(), boardProject("beta", undefined, { status: "died" })], "alpha");
    expect(attentionBadge(entries, "alpha")).toEqual({ red: 6, purple: 1 });
    expect(attentionBadge(entries, "beta")).toEqual({ red: 1, purple: 0 });
    expect(entries.find((entry) => entry.kind === "rate-hold")).toMatchObject({ counted: false, tone: "amber" });
    expect(entries.find((entry) => entry.kind === "integration-ready")).toMatchObject({ tone: "purple" });
  });

  it("holds back an Integration whose run has not cleared verify and polish yet", () => {
    const run = uiRun(90, [uiItem(1, "done")]);
    const waiting = boardProject("a", uiState([run]), { parents: [READY_PARENT] });
    expect(buildAttention([waiting], "a").some((entry) => entry.kind === "integration-ready")).toBe(false);
    const cleared = uiRun(90, [uiItem(1, "done")], {
      featureVerify: { phase: "green", counts: { pass: 3, fail: 0, requiresStg: 0 }, reason: undefined, pullRequests: ["https://github.com/acme/api/pull/5"] },
      polish: { ...idlePolish(), phase: "green" },
    });
    const ready = buildAttention([boardProject("a", uiState([cleared]), { parents: [READY_PARENT] })], "a").find((entry) => entry.kind === "integration-ready");
    expect(ready?.actions[0]?.href).toBe("https://github.com/acme/api/pull/5");
  });
});
