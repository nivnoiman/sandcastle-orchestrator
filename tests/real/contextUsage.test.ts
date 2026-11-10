import { describe, expect, it } from "vitest";
import { AttemptLogStore } from "../../src/real/attemptLog.js";
import { ContextTracker, contextWindow, uiUsage } from "../../src/real/contextUsage.js";
import { MemoryFileSystem } from "../../src/real/fileSystem.js";
import { testLayout } from "./support.js";

const turn = (input: number, cacheRead: number, cacheCreate: number, extra: Record<string, unknown> = {}, model = "claude-opus-4-5-20251101") =>
  `${JSON.stringify({ type: "assistant", message: { model, content: [], usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: 9 } }, ...extra })}\n`;

describe("context usage extraction", () => {
  it("sums input + cache read + cache creation of the latest main-thread turn", () => {
    const tracker = new ContextTracker();
    tracker.push(turn(10, 1000, 500));
    tracker.push(turn(20, 140_000, 2_000));
    expect(tracker.reading()).toEqual({ tokens: 142_020, model: "claude-opus-4-5-20251101", reportedWindow: undefined });
  });

  it("ignores subagent turns, other providers and junk", () => {
    const tracker = new ContextTracker();
    tracker.push(turn(5, 100, 0));
    tracker.push(turn(999_999, 0, 0, { parent_tool_use_id: "toolu_1" }));
    tracker.push('{"type":"turn.completed","usage":{"input_tokens":50000,"output_tokens":3}}\n{"usage": broken\nplain\n');
    expect(tracker.reading()?.tokens).toBe(105);
    expect(new ContextTracker().reading()).toBeUndefined();
  });

  it("reassembles a line split across chunks", () => {
    const tracker = new ContextTracker();
    const line = turn(1, 2, 3);
    tracker.push(line.slice(0, 40));
    expect(tracker.reading()).toBeUndefined();
    tracker.push(line.slice(40));
    expect(tracker.reading()?.tokens).toBe(6);
  });

  it("takes the window the CLI reports in the result event", () => {
    const tracker = new ContextTracker();
    tracker.push(turn(1, 150_000, 0));
    tracker.push(`${JSON.stringify({ type: "result", modelUsage: { "claude-opus-4-5": { contextWindow: 1_000_000, inputTokens: 5 } } })}\n`);
    expect(uiUsage(tracker.reading(), "opus")).toEqual({ tokens: 150_001, window: 1_000_000, percent: 15 });
  });
});

describe("context percentage and window", () => {
  const reading = (tokens: number, model?: string) => ({ tokens, model, reportedWindow: undefined });

  it("computes the percentage against a known window", () => {
    expect(uiUsage(reading(142_000, "claude-sonnet-4-5"), undefined)).toEqual({ tokens: 142_000, window: 200_000, percent: 71 });
  });

  it("honours a [1m] configured model", () => {
    expect(contextWindow(reading(300_000, "claude-opus-4-5"), "opus[1m]")).toBe(1_000_000);
  });

  it.each([
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-5-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-sonnet-5-5", 1_000_000],
    ["claude-haiku-5-5", undefined],
    ["claude-fable-5-1", 1_000_000],
    ["claude-opus-4-6", 200_000],
    ["claude-opus-4-5-20251101", 200_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-haiku-4-5-20251001", 200_000],
  ])("knows the window of %s", (model, window) => {
    expect(contextWindow(reading(1000, model), undefined)).toBe(window);
  });

  it("shows 1M for a live opus-4-8 turn instead of the old 200K", () => {
    expect(uiUsage(reading(74_292, "claude-opus-4-8"), "opus")).toEqual({ tokens: 74_292, window: 1_000_000, percent: 7 });
  });

  it("shows tokens only when the window is unknown, never a fake limit", () => {
    expect(uiUsage(reading(42_000, "claude-future-9"), undefined)).toEqual({ tokens: 42_000, window: undefined, percent: undefined });
    expect(uiUsage(reading(42_000), "mystery")).toEqual({ tokens: 42_000, window: undefined, percent: undefined });
  });

  it("drops a window the tokens already exceed", () => {
    expect(uiUsage(reading(250_000, "claude-opus-4-5"), undefined)?.window).toBeUndefined();
  });

  it("yields nothing without a reading", () => {
    expect(uiUsage(undefined, "opus")).toBeUndefined();
  });
});

describe("attempt log context", () => {
  it("tracks the newest attempt live and keeps it after finish", () => {
    const logs = new AttemptLogStore({ fs: new MemoryFileSystem(), layout: testLayout(), parentNumber: 9 });
    const first = logs.begin(7, "develop");
    first.write(turn(1, 100, 0));
    expect(logs.contextOf(7, "develop")?.tokens).toBe(101);
    first.write(turn(1, 300, 0));
    first.finish("success");
    expect(logs.contextOf(7)?.tokens).toBe(301);
    const second = logs.begin(7, "develop");
    expect(logs.contextOf(7, "develop")).toBeUndefined();
    second.write(turn(1, 10, 0));
    expect(logs.contextOf(7, "develop")?.tokens).toBe(11);
    expect(logs.contextOf(7, "review")).toBeUndefined();
  });
});
