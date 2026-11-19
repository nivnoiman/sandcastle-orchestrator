import { describe, expect, it } from "vitest";
import { RunHold } from "../../src/engine/hold.js";
import { AgentWaitError } from "../../src/real/agentFailure.js";
import { createHoldGate, HoldStoppedError, type HoldingWait } from "../../src/real/holdGate.js";

const AUTH = new AgentWaitError("auth", undefined, "Not logged in · Please run /login") as HoldingWait;

function gate(poll: (hold: RunHold) => void, stopped: () => boolean = () => false) {
  const hold = new RunHold();
  const logs: string[] = [];
  const awaitHold = createHoldGate({
    hold,
    poll: () => poll(hold),
    sleep: async () => undefined,
    intervalMs: 0,
    stopped,
    log: (message) => logs.push(message),
  });
  return { hold, logs, awaitHold };
}

describe("createHoldGate", () => {
  it("gives up with a HoldStoppedError when the run stops while held", async () => {
    let polls = 0;
    const { hold, awaitHold } = gate(() => {
      polls += 1;
    }, () => polls >= 2);
    await expect(awaitHold(AUTH, "polish api")).rejects.toBeInstanceOf(HoldStoppedError);
    expect(hold.reason).toBe("auth");
  });

  it("logs a failing poll and keeps waiting until the Hold lifts", async () => {
    let polls = 0;
    const { hold, logs, awaitHold } = gate((held) => {
      polls += 1;
      if (polls === 1) throw new Error("probe exploded");
      held.release();
    });
    await awaitHold(AUTH, "polish api");
    expect(hold.reason).toBeUndefined();
    expect(logs.some((line) => line.includes("polling the Hold failed: probe exploded"))).toBe(true);
  });
});
