import { describe, expect, it } from "vitest";
import { decideAfterExit, MAX_RESTARTS_PER_WINDOW, RESTART_WINDOW_MS } from "../../src/real/supervisor.js";

const NOW = 1_757_000_000_000;

describe("decideAfterExit", () => {
  it("stops supervising when the ui was stopped on purpose", () => {
    expect(decideAfterExit({ code: 0, signal: null }, [], NOW).kind).toBe("stop");
  });

  it("restarts a ui that died, naming how it died, with a growing delay", () => {
    expect(decideAfterExit({ code: null, signal: "SIGKILL" }, [], NOW)).toEqual({
      kind: "restart",
      delayMs: 10_000,
      reason: "the ui killed by SIGKILL",
    });
    expect(decideAfterExit({ code: 1, signal: null }, [NOW - 1000, NOW - 500], NOW)).toMatchObject({
      kind: "restart",
      delayMs: 60_000,
      reason: "the ui exited with code 1",
    });
  });

  it("gives up after a crash loop, but forgets restarts older than the window", () => {
    const loop = Array.from({ length: MAX_RESTARTS_PER_WINDOW }, (_, index) => NOW - index * 60_000);
    expect(decideAfterExit({ code: 1, signal: null }, loop, NOW)).toMatchObject({ kind: "stop" });
    const old = loop.map((at) => at - RESTART_WINDOW_MS);
    expect(decideAfterExit({ code: 1, signal: null }, old, NOW)).toMatchObject({ kind: "restart", delayMs: 10_000 });
  });
});
