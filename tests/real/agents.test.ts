import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgents } from "../../src/project/agentsConfig.js";
import { agentWaitFrom } from "../../src/real/agentFailure.js";
import {
  agentsInUse,
  claudeProvider,
  codexProvider,
  defaultAgent,
  describeAgent,
  resolveAgent,
  snapshotCredential,
  syncBackCredential,
} from "../../src/real/agents/index.js";
import {
  classifyCodexOutput,
  CODEX_REFRESH_AFTER_MS,
  codexCommand,
  codexHomeMounts,
  codexHydrateCommand,
  codexResetAt,
  isStaleCodexLogin,
} from "../../src/real/agents/codex.js";
import { classifyCursorOutput, cursorAuthEnv, cursorCommand, cursorHomeMounts, cursorHydrateCommand } from "../../src/real/agents/cursor.js";
import { cursorProvider } from "../../src/real/agents/index.js";
import { transcriptTurns } from "../../src/ui/board/transcript.js";
import { ensureFreshLogin, REFRESH_GATE_RETRY_MS } from "../../src/real/authProbe.js";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { buildPolishPrompt } from "../../src/real/promptBuilder.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import { containerEnv } from "../../src/real/sandboxRunner.js";
import { containerEgressHosts } from "../../src/real/preflight.js";
import { fsWith, HOME, testConfig, testLayout } from "./support.js";

const MIXED = testConfig({
  agents: parseAgents({ default: "claude", review: "codex", polish: { provider: "codex", model: "gpt-5.5-codex" } }),
  codexApiKey: "sk-codex",
  anthropicApiKey: "sk-ant",
});
const CHATGPT_LOGIN_ONLY = { ...MIXED, codexApiKey: undefined };
const NOW = Date.UTC(2026, 9, 23, 14, 0);
const AUTH_JSON = join(HOME, ".codex", "auth.json");

function codexFailure(stdout: string, stderr = ""): CommandFailure {
  return new CommandFailure("docker", ["exec", "c", "codex"], 1, stdout, stderr);
}

function login(lastRefresh: string): string {
  return JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" }, last_refresh: lastRefresh });
}

describe("resolveAgent", () => {
  it("keeps today's claude models when nothing is configured", () => {
    const config = testConfig();
    expect(resolveAgent(config, "develop")).toEqual({ provider: claudeProvider, model: "opus" });
    expect(resolveAgent(config, "resolve").model).toBe("opus");
    expect(resolveAgent(config, "feature-fix").model).toBe("opus");
    for (const role of ["simplify", "review", "feature-verify", "polish"] as const) expect(resolveAgent(config, role).model).toBe("sonnet");
  });

  it("routes overridden roles to their provider and leaves codex on its own default model", () => {
    expect(resolveAgent(MIXED, "review")).toEqual({ provider: codexProvider, model: undefined });
    expect(resolveAgent(MIXED, "polish")).toEqual({ provider: codexProvider, model: "gpt-5.5-codex" });
    expect(resolveAgent(MIXED, "develop").provider).toBe(claudeProvider);
  });

  it("lists each provider in use once, default first", () => {
    expect(agentsInUse(MIXED).map((agent) => agent.provider.name)).toEqual(["claude", "codex"]);
    expect(agentsInUse(testConfig()).map((agent) => agent.provider.name)).toEqual(["claude"]);
    expect(defaultAgent(MIXED)).toEqual({ provider: claudeProvider, model: "opus" });
  });

  it("probes a claude role under a codex default with the model that role runs", () => {
    const config = testConfig({ agents: parseAgents({ default: "codex", review: "claude" }) });
    expect(agentsInUse(config)).toEqual([
      { provider: codexProvider, model: undefined },
      { provider: claudeProvider, model: "sonnet" },
    ]);
  });

  it("describes claude by model only, so its log lines do not change", () => {
    expect(describeAgent(resolveAgent(MIXED, "develop"))).toBe("opus");
    expect(describeAgent(resolveAgent(MIXED, "review"))).toBe("codex default model");
    expect(describeAgent(resolveAgent(MIXED, "polish"))).toBe("codex gpt-5.5-codex");
  });
});

describe("provider isolation", () => {
  it("gives a container only its own provider's credentials", () => {
    const claude = containerEnv(MIXED, "/gitdir", claudeProvider);
    const codex = containerEnv(MIXED, "/gitdir", codexProvider);
    expect(claude["ANTHROPIC_API_KEY"]).toBe("sk-ant");
    expect(claude["CODEX_API_KEY"]).toBeUndefined();
    expect(codex["CODEX_API_KEY"]).toBe("sk-codex");
    expect(codex["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("never mounts the claude login into a codex container — only the shared skills and commands", () => {
    const layout = testLayout();
    const mounts = codexHomeMounts(layout);
    expect(mounts.every((mount) => mount.readonly)).toBe(true);
    expect(mounts.map((mount) => mount.hostPath)).toEqual([
      join(HOME, ".codex"),
      join(layout.claudeDir, "skills"),
      join(layout.claudeDir, "commands"),
    ]);
  });

  it("probes egress to every provider in use", () => {
    expect(containerEgressHosts(testConfig())).toEqual(["api.anthropic.com", "api.github.com"]);
    expect(containerEgressHosts(MIXED)).toEqual(["api.anthropic.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "api.github.com"]);
  });
});

describe("codex command and home", () => {
  it("runs codex exec headless on stdin with JSON events, model only when configured", () => {
    expect(codexCommand(undefined)).toBe(
      "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral -",
    );
    expect(codexCommand("gpt-5.5-codex")).toContain("--model gpt-5.5-codex -");
    expect(() => codexCommand("x; rm -rf /")).toThrow(/unquotable model name/);
  });

  it("hydrates a private codex home, file-backed auth and the shared skills where codex discovers them", () => {
    const command = codexHydrateCommand();
    expect(command).toContain("install -m 600 /home/agent/.codex-host/auth.json /home/agent/.codex/auth.json");
    expect(command).toContain(`cli_auth_credentials_store = "file"`);
    expect(command).toContain("ln -s /home/agent/.claude/skills /home/agent/.agents/skills");
    expect(command).toContain("test -f /home/agent/.claude/skills/tdd/SKILL.md");
    expect(command).not.toContain(".credentials.json");
    expect(command).not.toContain("config.toml /home");
  });
});

describe("cursor provider", () => {
  it("runs cursor-agent headless with stream-json, prompt substituted from stdin, model only when configured", () => {
    expect(cursorCommand(undefined)).toBe('cursor-agent -p --force --trust --output-format stream-json "$(cat)"');
    expect(cursorCommand("gpt-5")).toContain('--model gpt-5 "$(cat)"');
    expect(() => cursorCommand("x; rm -rf /")).toThrow(/unquotable model name/);
  });

  it("forwards only CURSOR_API_KEY, mounts only skills and commands, never another login", () => {
    const layout = testLayout();
    expect(cursorAuthEnv({ cursorApiKey: "key" })).toEqual({ CURSOR_API_KEY: "key" });
    expect(cursorAuthEnv({ cursorApiKey: undefined })).toEqual({});
    expect(cursorHomeMounts(layout).map((mount) => mount.hostPath)).toEqual([join(layout.claudeDir, "skills"), join(layout.claudeDir, "commands")]);
    const env = containerEnv(testConfig({ cursorApiKey: "key", anthropicApiKey: "sk-ant" }), "/gitdir", cursorProvider);
    expect(env["CURSOR_API_KEY"]).toBe("key");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(cursorHydrateCommand()).toContain("test -f /home/agent/.claude/skills/tdd/SKILL.md");
  });

  it("classifies auth and rate-limit failures from the result event or stderr, ignoring tool output", () => {
    const result = (text: string) => JSON.stringify({ type: "result", subtype: "error", is_error: true, result: text });
    expect(classifyCursorOutput(result("Unauthorized: invalid API key"), "")?.reason).toBe("auth");
    expect(classifyCursorOutput("", "ConnectError: [resource_exhausted] Error")?.reason).toBe("rate-limit");
    expect(classifyCursorOutput(result("429 Too Many Requests"), "")?.reason).toBe("rate-limit");
    const toolOutput = JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { readToolCall: { result: { success: { content: "rate limit 429 docs" } } } } });
    expect(classifyCursorOutput(toolOutput, "")).toBeUndefined();
  });

  it("describes cursor tool_call events in the board transcript", () => {
    const started = JSON.stringify({ type: "tool_call", subtype: "started", call_id: "c", tool_call: { readToolCall: { args: { path: "a.md" } } } });
    const done = JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "c", tool_call: { readToolCall: { args: { path: "a.md" }, result: { success: {} } } } });
    expect(transcriptTurns(`${started}
${done}`)).toEqual([
      { kind: "tool", text: "→ read: a.md" },
      { kind: "tool", text: "← read: a.md" },
    ]);
  });
});

describe("polish prompt per provider", () => {
  const context = {
    feature: "toy",
    hubRepo: "example-org/hub",
    parentNumber: 16,
    repo: "api",
    integrationBranch: "integration/toy",
    fixedPoint: "origin/dev",
    pullRequestUrl: "https://github.com/example-org/api/pull/9",
    checks: "npm test",
    notesFile: "POLISH_NOTES.md",
  };

  it("keeps the Skill-tool instruction for claude", () => {
    expect(buildPolishPrompt(context)).toContain("invoke it through the `Skill` tool");
    expect(buildPolishPrompt({ ...context, skillTool: true })).toBe(buildPolishPrompt(context));
  });

  it("has an agent without skills or subagents read the command and run its passes itself", () => {
    const prompt = buildPolishPrompt({ ...context, skillTool: false });
    expect(prompt).not.toContain("`Skill` tool");
    expect(prompt).toContain("read `~/.claude/commands/polish.md` and follow it verbatim");
    expect(prompt).toContain("run its three passes (simplify → review+fix → strip comments) yourself");
  });
});

describe("classifyCodexOutput", () => {
  it("reads a usage limit with a same-day reset time", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "error", message: "You’ve hit your usage limit. Try again at 3:15 PM." }),
      JSON.stringify({ type: "turn.failed", error: { message: "You’ve hit your usage limit. Try again at 3:15 PM." } }),
    ].join("\n");
    const waiting = classifyCodexOutput(stdout, "", NOW);
    expect(waiting?.reason).toBe("rate-limit");
    expect(waiting?.resumeAt).toBe(Date.UTC(2026, 9, 23, 15, 15));
    expect(waiting?.message).toBe("Codex CLI usage limit reached — the window reopens at 2026-10-23T15:15:00.000Z");
  });

  it("reads a dated reset and rolls a past time of day to tomorrow", () => {
    expect(codexResetAt("Upgrade to Pro or try again at Oct 25th, 2026 9:05 AM.", NOW)).toBe(Date.UTC(2026, 9, 25, 9, 5));
    expect(codexResetAt("try again at 12:30 AM", NOW)).toBe(Date.UTC(2026, 9, 24, 0, 30));
    expect(codexResetAt("Try again later.", NOW)).toBeUndefined();
  });

  it("parks on auth failures, ahead of a usage limit", () => {
    const stdout = [
      JSON.stringify({ type: "error", message: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." }),
      JSON.stringify({ type: "error", message: "You've hit your usage limit." }),
    ].join("\n");
    const waiting = classifyCodexOutput(stdout, "", NOW);
    expect(waiting?.reason).toBe("auth");
    expect(waiting?.message).toMatch(/rejected by Codex CLI/);
    expect(classifyCodexOutput("", "Error: Not logged in", NOW)?.reason).toBe("auth");
  });

  it("ignores limit wording that only appears in tool output", () => {
    const stdout = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "grep", aggregated_output: "rate limit exceeded; invalid api key", exit_code: 0 },
    });
    expect(classifyCodexOutput(stdout, "", NOW)).toBeUndefined();
  });

  it("is what agentWaitFrom uses for a codex stage", () => {
    const failure = codexFailure(JSON.stringify({ type: "turn.failed", error: { message: "Quota exceeded. Check your plan and billing details." } }));
    expect(agentWaitFrom(failure, codexProvider.classify)?.reason).toBe("rate-limit");
    expect(agentWaitFrom(failure, claudeProvider.classify)).toBeUndefined();
  });
});

describe("codex login refresh", () => {
  it("is stale a day before codex would refresh it itself, and never for an API-key login", () => {
    expect(isStaleCodexLogin(login(new Date(NOW - CODEX_REFRESH_AFTER_MS - 1).toISOString()), NOW)).toBe(true);
    expect(isStaleCodexLogin(login(new Date(NOW - 60_000).toISOString()), NOW)).toBe(false);
    expect(isStaleCodexLogin(JSON.stringify({ OPENAI_API_KEY: "sk" }), NOW)).toBe(false);
    expect(isStaleCodexLogin("not json", NOW)).toBe(false);
  });

  it("writes a token the container refreshed back to the host", () => {
    const before = login("2026-10-01T00:00:00Z");
    const after = login("2026-10-23T14:00:00Z");
    const fs = fsWith({ [AUTH_JSON]: before });
    const runner = new RecordingCommandRunner().respond("cat /home/agent/.codex/auth.json", after);
    const logs: string[] = [];
    const snapshot = snapshotCredential(fs, testLayout(), codexProvider);
    syncBackCredential({ runner, fs, log: (line) => logs.push(line) }, "sc-demo-review-17-x", snapshot);
    expect(fs.readText(AUTH_JSON)).toBe(after);
    expect(logs.join("\n")).toMatch(/wrote it back/);
  });

  it("keeps the host login when it changed during the run or the container left junk", () => {
    const before = login("2026-10-01T00:00:00Z");
    const hostNewer = login("2026-10-22T00:00:00Z");
    const fs = fsWith({ [AUTH_JSON]: before });
    const snapshot = snapshotCredential(fs, testLayout(), codexProvider);
    fs.writeText(AUTH_JSON, hostNewer);
    const runner = new RecordingCommandRunner().respond("cat", login("2026-10-23T00:00:00Z"));
    syncBackCredential({ runner, fs, log: () => undefined }, "c", snapshot);
    expect(fs.readText(AUTH_JSON)).toBe(hostNewer);

    const junkFs = fsWith({ [AUTH_JSON]: before });
    const junk = new RecordingCommandRunner().respond("cat", "{ truncated");
    syncBackCredential({ runner: junk, fs: junkFs, log: () => undefined }, "c", snapshotCredential(junkFs, testLayout(), codexProvider));
    expect(junkFs.readText(AUTH_JSON)).toBe(before);
  });

  it("refreshes a stale login once, through one probe shared by concurrent stages", async () => {
    const fs = fsWith({ [AUTH_JSON]: login("2026-10-01T00:00:00Z") });
    const runner = new RecordingCommandRunner();
    const deps = { runner, fs, layout: testLayout(), config: CHATGPT_LOGIN_ONLY, now: () => NOW };
    const codexReview = resolveAgent(CHATGPT_LOGIN_ONLY, "review");
    const first = ensureFreshLogin(deps, codexReview);
    const second = ensureFreshLogin(deps, codexReview);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    await first;
    expect(runner.findAll(/codex exec/)).toHaveLength(1);
    expect(runner.find(/docker run .*sc-demo-probecodex-0-/)).toBeDefined();
  });

  it("needs no refresh for a fresh login or a claude stage", () => {
    const fs = fsWith({ [AUTH_JSON]: login(new Date(NOW).toISOString()) });
    const deps = { runner: new RecordingCommandRunner(), fs, layout: testLayout(), config: MIXED, now: () => NOW };
    expect(ensureFreshLogin(deps, resolveAgent(MIXED, "review"))).toBeUndefined();
    expect(ensureFreshLogin(deps, resolveAgent(MIXED, "develop"))).toBeUndefined();
  });

  it("never gates a login that CODEX_API_KEY overrides", () => {
    const layout = { ...testLayout(), codexDir: "/gate/api-key" };
    const fs = fsWith({ [join("/gate/api-key", "auth.json")]: login("2026-10-01T00:00:00Z") });
    const deps = { runner: new RecordingCommandRunner(), fs, layout, config: MIXED, now: () => NOW };
    expect(ensureFreshLogin(deps, resolveAgent(MIXED, "review"))).toBeUndefined();
  });

  it("re-probes a login the gate could not refresh at most once per retry window", async () => {
    const layout = { ...testLayout(), codexDir: "/gate/throttle" };
    const fs = fsWith({ [join("/gate/throttle", "auth.json")]: login("2026-10-01T00:00:00Z") });
    const runner = new RecordingCommandRunner();
    let now = NOW;
    const deps = { runner, fs, layout, config: CHATGPT_LOGIN_ONLY, now: () => now };
    const codexReview = resolveAgent(CHATGPT_LOGIN_ONLY, "review");
    await ensureFreshLogin(deps, codexReview);
    now += REFRESH_GATE_RETRY_MS - 1;
    expect(ensureFreshLogin(deps, codexReview)).toBeUndefined();
    now += 1;
    await ensureFreshLogin(deps, codexReview);
    expect(runner.findAll(/codex exec/)).toHaveLength(2);
  });

  it("never throws or leaves a half-written login when the host write fails", () => {
    const before = login("2026-10-01T00:00:00Z");
    const fs = fsWith({ [AUTH_JSON]: before });
    const snapshot = snapshotCredential(fs, testLayout(), codexProvider);
    fs.rename = () => {
      throw new Error("EBUSY");
    };
    const runner = new RecordingCommandRunner().respond("cat", login("2026-10-23T00:00:00Z"));
    const logs: string[] = [];
    expect(() => syncBackCredential({ runner, fs, log: (line) => logs.push(line) }, "c", snapshot)).not.toThrow();
    expect(fs.readText(AUTH_JSON)).toBe(before);
    expect(fs.readText(`${AUTH_JSON}.sandcastle-${process.pid}.tmp`)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/could not write .*EBUSY/);
  });

  it("does nothing for claude or without a host login file", () => {
    const fs = fsWith({});
    expect(snapshotCredential(fs, testLayout(), claudeProvider)).toBeUndefined();
    expect(snapshotCredential(fs, testLayout(), codexProvider)).toBeUndefined();
  });
});
