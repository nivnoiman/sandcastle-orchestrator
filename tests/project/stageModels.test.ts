import { describe, expect, it } from "vitest";
import { parseAgents, type AgentChoice } from "../../src/project/agentsConfig.js";
import { describeEffective, effectiveAgent, tierOf } from "../../src/project/stageModels.js";
import { resolveStageAgent } from "../../src/real/agents/index.js";

const CLAUDE = { main: "opus", review: "sonnet" };
const NONE = { main: null, review: null };
const CLAUDE_DEFAULT: AgentChoice = { provider: "claude", model: undefined };

describe("effectiveAgent", () => {
  it("inherits the project default and the env model per tier", () => {
    expect(effectiveAgent(undefined, CLAUDE_DEFAULT, "main", CLAUDE)).toEqual({ provider: "claude", providerFrom: "project-default", model: "opus", modelFrom: "provider-default" });
    expect(describeEffective(effectiveAgent(undefined, CLAUDE_DEFAULT, "review", CLAUDE))).toBe("claude · sonnet");
  });

  it("takes the model pinned on agents.default as inherited", () => {
    const effective = effectiveAgent(undefined, { provider: "claude", model: "haiku" }, "main", CLAUDE);
    expect(effective).toMatchObject({ model: "haiku", modelFrom: "project-default" });
  });

  it("a stage with its own provider but no model gets that provider default, not the project default model", () => {
    const effective = effectiveAgent({ provider: "claude", model: undefined }, { provider: "claude", model: "haiku" }, "main", CLAUDE);
    expect(effective).toMatchObject({ providerFrom: "stage", model: "opus", modelFrom: "provider-default" });
  });

  it("reports a stage-set model", () => {
    expect(effectiveAgent({ provider: "codex", model: "gpt-5.5" }, CLAUDE_DEFAULT, "review", CLAUDE)).toEqual({ provider: "codex", providerFrom: "stage", model: "gpt-5.5", modelFrom: "stage" });
  });

  it("never invents a model: codex without one, or claude with unreadable env, is unpinned", () => {
    expect(describeEffective(effectiveAgent({ provider: "codex", model: undefined }, CLAUDE_DEFAULT, "main", CLAUDE))).toBe("codex · provider default (model not pinned)");
    expect(describeEffective(effectiveAgent(undefined, CLAUDE_DEFAULT, "main", NONE))).toBe("claude · provider default (model not pinned)");
  });

  it("agrees with the engine resolveStageAgent on provider and model", () => {
    const agents = parseAgents({ default: { provider: "claude", model: "haiku" }, review: "codex", simplify: { provider: "claude", model: "opus" } });
    const config = {
      agents,
      model: "opus",
      reviewModel: "sonnet",
      stages: [
        { kind: "agent" as const, name: "security", promptPath: "p.md", agent: { provider: "codex" as const, model: "gpt-5.5" } },
        { kind: "agent" as const, name: "docs", promptPath: "d.md", agent: undefined },
      ],
    };
    const own = (stage: string): AgentChoice | undefined => agents.roles[stage as "review"] ?? config.stages.find((candidate) => candidate.name === stage)?.agent;
    for (const stage of ["develop", "simplify", "review", "security", "docs"]) {
      const engine = resolveStageAgent(config, stage);
      const effective = effectiveAgent(own(stage), agents.default, tierOf(stage), CLAUDE);
      expect([stage, effective.provider, effective.model ?? undefined]).toEqual([stage, engine.provider.name, engine.model]);
    }
  });
});
