import { MODEL_NAME } from "../../project/agentsConfig.js";
import { classifyAgentOutput } from "../agentFailure.js";
import type { Mount } from "../docker.js";
import { agentAuthEnv } from "../env.js";
import { claudeJsonPath, CONTAINER_HOME, type SandcastleLayout } from "../paths.js";
import { containerSkillPath, REQUIRED_SKILLS, tarCopyCommand } from "../skills.js";
import type { AgentProvider } from "./provider.js";

export const HOST_CLAUDE_DIR = `${CONTAINER_HOME}/.claude-host`;
export const HOST_CLAUDE_JSON = `${CONTAINER_HOME}/.claude-host.json`;
export const HYDRATE_COPIED_ENTRIES = [
  "CLAUDE.md",
  "settings.json",
  "settings.local.json",
  ".credentials.json",
  "agents",
  "commands",
  "hooks",
  "skills",
] as const;
export const CONTAINER_AUTOCRLF = "true";

const CLAUDE_FLAGS = ["--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];

export function assertQuotableModel(model: string): string {
  if (!MODEL_NAME.test(model)) throw new Error(`refusing to run an unquotable model name: ${JSON.stringify(model)}`);
  return model;
}

export function claudeCommand(model: string | undefined): string {
  const modelArgs = model === undefined ? [] : ["--model", assertQuotableModel(model)];
  return ["claude", "-p", ...modelArgs, ...CLAUDE_FLAGS].join(" ");
}

export function requiredSkillChecks(): string[] {
  return REQUIRED_SKILLS.map((skill) => `test -f ${containerSkillPath(skill)}`);
}

export function hydrateHomeCommand(): string {
  return [
    "set -o pipefail",
    `rm -rf ${CONTAINER_HOME}/.claude ${CONTAINER_HOME}/.claude.json`,
    `mkdir -p ${CONTAINER_HOME}/.claude`,
    tarCopyCommand(HOST_CLAUDE_DIR, HYDRATE_COPIED_ENTRIES, `${CONTAINER_HOME}/.claude`),
    `cp -a --no-preserve=ownership ${HOST_CLAUDE_JSON} ${CONTAINER_HOME}/.claude.json`,
    `git config --global core.autocrlf ${CONTAINER_AUTOCRLF}`,
    ...requiredSkillChecks(),
  ].join(" && ");
}

export function claudeHomeMounts(layout: SandcastleLayout): Mount[] {
  return [
    { hostPath: layout.claudeDir, containerPath: HOST_CLAUDE_DIR, readonly: true },
    { hostPath: claudeJsonPath(layout), containerPath: HOST_CLAUDE_JSON, readonly: true },
  ];
}

export const claudeProvider: AgentProvider = {
  name: "claude",
  label: "Claude Code",
  egressHosts: ["api.anthropic.com"],
  skillTool: true,
  command: claudeCommand,
  homeMounts: claudeHomeMounts,
  hydrateCommand: hydrateHomeCommand,
  authEnv: agentAuthEnv,
  classify: classifyAgentOutput,
};
