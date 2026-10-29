import { describe, expect, it } from "vitest";
import { buildAttention } from "../../../src/ui/board/attention.js";
import { alertText, isHeld, newlyNeedingAttention, pageTitle, parseHeld } from "../../../src/ui/board/humanAlerts.js";
import { boardProject, uiItem, uiRun, uiState } from "./fixtures.js";

function parked(reason: string) {
  const run = uiRun(10, [uiItem(41, "parked", { stage: "develop", parkReason: reason, pullRequestUrl: "https://github.com/acme/api/pull/9" })]);
  return buildAttention([boardProject("alpha", uiState([run]))], "alpha");
}

describe("human alerts", () => {
  it("carries the park detail a person needs on the parked entry", () => {
    const entry = parked("develop stage failed")[0]!;
    expect(entry.park).toMatchObject({ stage: "develop", reason: "develop stage failed", pullRequestUrl: "https://github.com/acme/api/pull/9" });
    expect(entry.actions.map((action) => action.id)).toEqual(["log", "open-link", "comment", "hold", "requeue"]);
    expect(entry.actions.find((action) => action.id === "open-link")).toMatchObject({ label: "Open PR", href: "https://github.com/acme/api/pull/9" });
  });

  it("announces nothing on a project's first state, then only entries that are new", () => {
    const first = parked("a");
    expect(newlyNeedingAttention(undefined, first)).toEqual([]);
    expect(newlyNeedingAttention(new Set(first.map((entry) => entry.key)), first)).toEqual([]);
    expect(newlyNeedingAttention(new Set(), first).map((entry) => entry.itemNumber)).toEqual([41]);
  });

  it("does not announce uncounted entries such as rate-limit holds", () => {
    const project = boardProject("alpha", uiState([uiRun(10, [uiItem(1, "running")])], { hold: { reason: "rate-limit" as never, until: undefined } }));
    const entries = buildAttention([project], "alpha");
    expect(entries.some((entry) => entry.kind === "rate-hold")).toBe(true);
    expect(newlyNeedingAttention(new Set(), entries)).toEqual([]);
  });

  it("keeps Hold tied to the park reason so a new failure shows again", () => {
    const entry = parked("first")[0]!;
    const held = { [entry.key]: "first" };
    expect(isHeld(held, entry)).toBe(true);
    expect(isHeld(held, parked("second")[0]!)).toBe(false);
  });

  it("reads stored holds defensively and builds the title badge", () => {
    expect(parseHeld(undefined)).toEqual({});
    expect(parseHeld("not json")).toEqual({});
    expect(parseHeld('{"a":"x","b":3}')).toEqual({ a: "x" });
    expect(pageTitle(2, "alpha")).toBe("(2) Sandcastle · alpha");
    expect(pageTitle(0, undefined)).toBe("Sandcastle");
    expect(alertText(parked("boom")[0]!)).toMatchObject({ body: "boom" });
  });
});
