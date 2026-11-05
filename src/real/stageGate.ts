import { boundedTail, fencedBlock } from "../markdown.js";
import { SANDBOX_WORKDIR } from "./docker.js";
import type { StagePromptContext } from "./promptBuilder.js";

/** Where the pre-push hook lives inside a stage container. */
export const STAGE_HOOKS_DIR = "/usr/local/share/sandcastle-hooks";
const FIX_OUTPUT_LIMIT = 3000;

/** Git env that points `core.hooksPath` at the gate hooks, without touching the repo's own config. */
export const STAGE_HOOKS_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: STAGE_HOOKS_DIR,
};

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** A `pre-push` hook that runs the stage's commands in order and blocks the push at the first red one. */
export function prePushHookScript(commands: readonly string[]): string {
  return [
    "#!/bin/bash",
    `cd ${shellQuote(SANDBOX_WORKDIR)} || exit 1`,
    "run() {",
    '  echo "sandcastle stage check: $1" >&2',
    '  bash -lc "$1" >&2 </dev/null || { echo "sandcastle: push blocked - stage check failed: $1 - fix it, commit, push again" >&2; exit 1; }',
    "}",
    ...commands.map((command) => `run ${shellQuote(command)}`),
    "exit 0",
    "",
  ].join("\n");
}

/** Root shell command that installs the hook into a running container. Base64 keeps the script quoting-proof. */
export function installPrePushHookCommand(commands: readonly string[]): string {
  const encoded = Buffer.from(prePushHookScript(commands), "utf8").toString("base64");
  return `mkdir -p ${STAGE_HOOKS_DIR} && printf %s ${encoded} | base64 -d > ${STAGE_HOOKS_DIR}/pre-push && chmod 755 ${STAGE_HOOKS_DIR}/pre-push`;
}

function numbered(commands: readonly string[]): string {
  return commands.map((command, index) => `${index + 1}. \`${command}\``).join("\n");
}

/** Appended to the stage prompt so the agent runs the same gate itself before it finishes. */
export function stageChecksNote(commands: readonly string[], stage: string): string {
  return [
    `## Stage checks - sandcastle gates the ${stage} stage on these, in order`,
    numbered(commands),
    "Run them yourself in the foreground before you finish, and fix every failure at its cause - never skip, delete or weaken a test, a lint rule or a type. Sandcastle re-runs them in a clean container when you stop (and a git pre-push hook runs them on every push); red sends your work back to you or to develop.",
  ].join("\n");
}

export interface StageCheckFailure {
  command: string;
  output: string;
}

/** The prompt of the fix pass: the stage agent's own work is red against the gate, and only that is to be fixed. */
export function buildStageCheckFixPrompt(
  context: StagePromptContext,
  stage: string,
  failure: StageCheckFailure,
  commands: readonly string[],
  round: { attempt: number; limit: number },
): string {
  const local = context.tracker === "local";
  return [
    `Stage-check fix pass ${round.attempt}/${round.limit} for the ${stage} stage of sub-issue ${context.hubRepo}#${context.item.number}, branch \`${context.branch}\` (integration branch \`${context.integrationBranch}\`).`,
    "",
    `The ${stage} stage finished, but sandcastle ran the stage checks in a clean copy of the branch and one failed. Nothing is pushed until they pass.`,
    "",
    "## Stage checks, in order",
    numbered(commands),
    "",
    `## Failed: \`${failure.command}\` - last output`,
    fencedBlock(boundedTail(failure.output.trim() || "(no output)", FIX_OUTPUT_LIMIT)),
    "",
    "## Your job (ONLY this)",
    `**1. Fix the cause.** The smallest change that turns \`${failure.command}\` green. Never skip, delete or weaken a test, a lint rule or a type to get there. Do not add features and do not rewrite existing commits.`,
    "**2. Re-run all the stage checks above in the foreground** until every one passes.",
    "**3. Commit** the fix as `fix: <what>`.",
    local
      ? "**4. Stop.** Do not push (sandcastle does); print a one-line summary and stop."
      : `**4. Push and stop.** \`git push origin ${context.branch}\` (a pre-push hook re-runs the checks), then stop.`,
  ].join("\n");
}
