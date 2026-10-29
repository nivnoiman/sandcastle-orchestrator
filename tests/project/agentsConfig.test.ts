import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS, parseAgents } from "../../src/project/agentsConfig.js";

describe("parseAgents", () => {
  it("defaults every role to claude when agents is absent", () => {
    expect(parseAgents(undefined)).toEqual(DEFAULT_AGENTS);
  });

  it("takes provider names and { provider, model } entries per role", () => {
    expect(parseAgents({ default: "claude", review: "codex", polish: { provider: "codex", model: "gpt-5.5-codex" } })).toEqual({
      default: { provider: "claude", model: undefined },
      roles: {
        review: { provider: "codex", model: undefined },
        polish: { provider: "codex", model: "gpt-5.5-codex" },
      },
    });
  });

  it("accepts cursor with a model", () => {
    expect(parseAgents({ review: { provider: "cursor", model: "gpt-5" } }).roles.review).toEqual({ provider: "cursor", model: "gpt-5" });
  });

  it("lets default switch provider", () => {
    expect(parseAgents({ default: "codex" }).default).toEqual({ provider: "codex", model: undefined });
  });

  it.each([
    [{ default: "gemini" }, /agents.default must be one of "claude", "codex", "cursor"/],
    [{ reviewer: "codex" }, /agents.reviewer is not an agent role/],
    [{ review: { provider: "codex", model: "gpt; rm -rf /" } }, /agents.review.model must be a plain model name/],
    [{ review: { provider: "codex", effort: "high" } }, /agents.review.effort is not a setting/],
    [{ review: 3 }, /agents.review must be a provider name/],
    [["claude"], /agents must be an object/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseAgents(raw)).toThrow(message);
  });
});
