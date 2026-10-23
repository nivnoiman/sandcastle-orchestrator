import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentIdleTimeoutError,
  CommandFailure,
  isAgentIdleTimeout,
  runWithIdleTimeout,
  silenceAfterTick,
} from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runWithIdleTimeout", () => {
  it("returns the result of a command that finishes inside its budget", async () => {
    const runner = new RecordingCommandRunner();
    runner.respond("echo", "done");
    await expect(runWithIdleTimeout(runner, { command: "echo", args: ["hi"] }, 60)).resolves.toEqual({
      stdout: "done",
      stderr: "",
    });
  });

  it("kills a silent command and names it an agent idle timeout", async () => {
    vi.useFakeTimers();
    const runner = new RecordingCommandRunner();
    runner.hold("claude");
    const pending = runWithIdleTimeout(runner, { command: "claude", args: ["-p"] }, 60);
    const settled = expect(pending).rejects.toBeInstanceOf(AgentIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(runner.held[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(runner.held[0]?.killed).toBe(true);
  });

  it("lets output restart the idle clock so a long but chatty agent survives", async () => {
    vi.useFakeTimers();
    const runner = new RecordingCommandRunner();
    runner.hold("claude");
    const pending = runWithIdleTimeout(runner, { command: "claude", args: ["-p"] }, 60);
    const held = runner.held[0];
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(50_000);
      held?.emit('{"type":"assistant"}');
    }
    held?.finish({ stdout: "ok" });
    await expect(pending).resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(held?.killed).toBe(false);
  });

  it("does not count a machine sleep as silence, so waking up does not kill the stage", async () => {
    vi.useFakeTimers();
    const runner = new RecordingCommandRunner();
    runner.hold("jest");
    const pending = runWithIdleTimeout(runner, { command: "jest", args: [] }, 60);
    const held = runner.held[0];
    await vi.advanceTimersByTimeAsync(30_000);
    vi.setSystemTime(Date.now() + 7 * 3600_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(held?.killed).toBe(false);
    held?.emit("PASS tests/unit/a.test.ts");
    held?.finish({ stdout: "ok" });
    await expect(pending).resolves.toEqual({ stdout: "ok", stderr: "" });
  });

  it("still kills a command that stays silent after the machine wakes", async () => {
    vi.useFakeTimers();
    const runner = new RecordingCommandRunner();
    runner.hold("jest");
    const pending = runWithIdleTimeout(runner, { command: "jest", args: [] }, 60);
    const settled = expect(pending).rejects.toBeInstanceOf(AgentIdleTimeoutError);
    vi.setSystemTime(Date.now() + 7 * 3600_000);
    await vi.advanceTimersByTimeAsync(76_000);
    await settled;
    expect(runner.held[0]?.killed).toBe(true);
  });

  it("counts a suspend gap as one tick of silence and a normal tick as its real length", () => {
    expect(silenceAfterTick(30_000, 15_000, 15_000)).toBe(45_000);
    expect(silenceAfterTick(30_000, 7 * 3600_000, 15_000)).toBe(45_000);
    expect(silenceAfterTick(30_000, -5_000, 15_000)).toBe(30_000);
  });

  it("does not disguise a real command failure as an idle timeout", async () => {
    const runner = new RecordingCommandRunner();
    runner.fail("claude", new CommandFailure("claude", ["-p"], 1, "", "no such model"));
    await expect(runWithIdleTimeout(runner, { command: "claude", args: ["-p"] }, 60)).rejects.toThrow(/no such model/);
  });

  it("rejects a nonsensical idle budget", async () => {
    const runner = new RecordingCommandRunner();
    await expect(runWithIdleTimeout(runner, { command: "claude", args: [] }, 0)).rejects.toThrow(/positive number/);
  });

  it("forwards the prompt on stdin", async () => {
    const runner = new RecordingCommandRunner();
    await runWithIdleTimeout(runner, { command: "claude", args: ["-p"], input: "do the thing" }, 60);
    expect(runner.calls[0]?.input).toBe("do the thing");
  });
});

describe("isAgentIdleTimeout", () => {
  it("recognises the error class and its marker property", () => {
    expect(isAgentIdleTimeout(new AgentIdleTimeoutError(600, "claude"))).toBe(true);
    expect(isAgentIdleTimeout(Object.assign(new Error("wrapped"), { agentIdleTimeout: true }))).toBe(true);
    expect(isAgentIdleTimeout(new Error("docker: no such container"))).toBe(false);
  });

  it("never sniffs messages, so check output mentioning an idle timeout cannot trigger salvage", () => {
    expect(isAgentIdleTimeout(new Error("AgentIdleTimeoutError: whatever"))).toBe(false);
    expect(isAgentIdleTimeout(new Error("FAIL src/a.test.ts — idle timeout waiting for socket"))).toBe(false);
    expect(isAgentIdleTimeout(new Error("agent produced no output"))).toBe(false);
    expect(isAgentIdleTimeout("idle timeout")).toBe(false);
  });
});

describe("CommandFailure", () => {
  it("redacts env-shaped argv entries so a token never reaches a warn line", () => {
    const failure = new CommandFailure(
      "docker",
      ["run", "-e", "GH_TOKEN=ghp_supersecret", "-e", "ANTHROPIC_API_KEY=sk-ant-secret", "--filter", "ancestor=img"],
      125,
      "",
      "boom",
    );
    expect(failure.message).toContain("GH_TOKEN=***");
    expect(failure.message).toContain("ANTHROPIC_API_KEY=***");
    expect(failure.message).not.toContain("ghp_supersecret");
    expect(failure.message).not.toContain("sk-ant-secret");
    expect(failure.message).toContain("ancestor=img");
    expect(failure.args).toContain("GH_TOKEN=ghp_supersecret");
  });
});
