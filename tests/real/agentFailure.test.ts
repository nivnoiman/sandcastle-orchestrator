import { describe, expect, it } from "vitest";
import {
  agentWaitFrom,
  classifyAgentOutput,
  isAgentWait,
  lastStreamEvent,
} from "../../src/real/agentFailure.js";
import { CommandFailure, failureExcerpt } from "../../src/real/commandRunner.js";

const INIT_EVENT = JSON.stringify({
  type: "system",
  subtype: "init",
  tools: Array.from({ length: 40 }, (_, index) => `tool-${index}`),
  model: "claude-opus-4-1",
});

const RATE_LIMIT_EVENT = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", resetsAt: 1_757_000_000, rateLimitType: "five_hour" },
});

const ALLOWED_EVENT = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1_789_741_800,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
  },
});

const API_RETRY_401 = JSON.stringify({ type: "system", subtype: "api_retry", error_status: 401, error: "authentication_failed" });

const REVOKED_TEXT = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Failed to authenticate. API Error: 401 OAuth access token has been revoked." }] },
});

const RESULT_401 = JSON.stringify({ type: "result", is_error: true, api_error_status: 401 });

describe("classifying what killed a claude -p", () => {
  it("reads the rate_limit_event off the last line, not the init event off the first", () => {
    const failure = classifyAgentOutput(`${INIT_EVENT}\n${RATE_LIMIT_EVENT}`, "");

    expect(failure?.reason).toBe("rate-limit");
    expect(failure?.resumeAt).toBe(1_757_000_000_000);
    expect(failure?.message).toContain("five-hour usage limit");
  });

  it("keeps a millisecond resetsAt as milliseconds", () => {
    const event = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1_757_000_000_000 },
    });

    expect(classifyAgentOutput(event, "")?.resumeAt).toBe(1_757_000_000_000);
  });

  it("recognises an expired OAuth session as an auth wait with no resume time", () => {
    const failure = classifyAgentOutput(INIT_EVENT, "Failed to authenticate: OAuth session expired and could not be refreshed");

    expect(failure?.reason).toBe("auth");
    expect(failure?.resumeAt).toBeUndefined();
  });

  it("reads a revoked OAuth token as auth even when routine allowed limit events are in the stream", () => {
    const failure = classifyAgentOutput(
      [INIT_EVENT, ALLOWED_EVENT, API_RETRY_401, REVOKED_TEXT, ALLOWED_EVENT, RESULT_401].join("\n"),
      "",
    );

    expect(failure?.reason).toBe("auth");
    expect(failure?.resumeAt).toBeUndefined();
  });

  it("reads a bare api_error_status 401 result as auth", () => {
    expect(classifyAgentOutput(`${INIT_EVENT}\n${ALLOWED_EVENT}\n${RESULT_401}`, "")?.reason).toBe("auth");
  });

  it("lets auth win over a rejected limit event in the same stream", () => {
    expect(classifyAgentOutput(`${RATE_LIMIT_EVENT}\n${RESULT_401}`, "")?.reason).toBe("auth");
  });

  it("keeps a rejected limit as a rate limit when an auth phrase only appears in tool output", () => {
    const toolOutput = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "throw new Error('Invalid API key');" }] },
    });

    expect(classifyAgentOutput(`${toolOutput}\n${RATE_LIMIT_EVENT}`, "")?.reason).toBe("rate-limit");
  });

  it("leaves a generic failure with only allowed limit events unclassified", () => {
    const warning = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1_789_741_800 } });
    const stream = [INIT_EVENT, ALLOWED_EVENT, warning, JSON.stringify({ type: "result", is_error: true })].join("\n");

    expect(classifyAgentOutput(stream, "")).toBeUndefined();
  });

  it("takes resumeAt from the rejected event, not a later allowed one", () => {
    const failure = classifyAgentOutput(`${RATE_LIMIT_EVENT}\n${ALLOWED_EVENT}`, "");

    expect(failure?.reason).toBe("rate-limit");
    expect(failure?.resumeAt).toBe(1_757_000_000_000);
  });

  it("leaves an ordinary stage failure unclassified so it still parks", () => {
    expect(classifyAgentOutput(`${INIT_EVENT}\n${JSON.stringify({ type: "result", is_error: true })}`, "")).toBeUndefined();
  });

  it("classifies the CommandFailure a killed claude throws", () => {
    const cause = new CommandFailure("docker", ["exec", "c"], 1, `${INIT_EVENT}\n${RATE_LIMIT_EVENT}`, "");
    const waiting = agentWaitFrom(cause);

    expect(isAgentWait(waiting)).toBe(true);
    expect(waiting?.detail).toContain("rate_limit_event");
  });

  it("puts the last stream event in the failure message instead of the first 400 chars of init", () => {
    const message = new CommandFailure("docker", ["exec", "c"], 1, `${INIT_EVENT}\n${RATE_LIMIT_EVENT}`, "").message;

    expect(message).toContain("rate_limit_event");
    expect(message).not.toContain("tool-0");
  });

  it("keeps short single-line output verbatim", () => {
    expect(failureExcerpt("", "fatal: not a git repository")).toBe("fatal: not a git repository");
  });

  it("finds the last json line of a stream", () => {
    expect(lastStreamEvent(`${INIT_EVENT}\nnot json\n${RATE_LIMIT_EVENT}`)?.["type"]).toBe("rate_limit_event");
  });
});
