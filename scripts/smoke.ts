import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { REWORK_LIMIT_DEFAULT } from "../src/engine/rework.js";
import { isTargetRepo } from "../src/model/runModel.js";
import { bootProject } from "../src/project/boot.js";
import { DEFAULT_MONGO_IMAGE, integrationBase, knownRepos } from "../src/project/projectConfig.js";
import { NodeCommandRunner, runWithIdleTimeout } from "../src/real/commandRunner.js";
import {
  assertDockerReady,
  execRequest,
  removeContainer,
  SMOKE_CONTAINER_PREFIX,
  startContainer,
} from "../src/real/docker.js";
import {
  clampIdleTimeout,
  DEFAULT_JEST_WORKERS,
  IDLE_TIMEOUT_DEFAULT,
} from "../src/real/env.js";
import { nodeFileSystem } from "../src/real/fileSystem.js";
import { RealGitOps, resolveGitDir } from "../src/real/gitOps.js";
import { layoutFrom, projectRepoRoots, repoRoot, worktreePath } from "../src/real/paths.js";
import {
  containerEnv,
  containerGitDir,
  containerSpec,
  withContainerEnvFile,
} from "../src/real/sandboxRunner.js";
import { isProviderName, PROVIDER_NAMES, type ProviderName } from "../src/project/agentsConfig.js";
import { DEFAULT_STAGES } from "../src/project/stagesConfig.js";
import { providerNamed, snapshotCredential, syncBackCredential } from "../src/real/agents/index.js";
import { agentWaitFrom } from "../src/real/agentFailure.js";
import { codexLogin, CODEX_FLAGS } from "../src/real/agents/codex.js";
import { CURSOR_FLAGS } from "../src/real/agents/cursor.js";
import { PROBE_PROMPT } from "../src/real/authProbe.js";
import { messageOf } from "../src/messageOf.js";

const project = bootProject();
const usage = `usage: sandcastle smoke [${knownRepos().join("|")}] [--agent=${PROVIDER_NAMES.join("|")}] [--config=path]`;
const repoArg = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? knownRepos()[0]!;
const agentArg = process.argv.slice(2).find((arg) => arg.startsWith("--agent="))?.slice("--agent=".length) ?? "claude";
if (!isTargetRepo(repoArg) || !isProviderName(agentArg)) {
  console.error(usage);
  process.exit(2);
}
const provider = providerNamed(agentArg);
const repo = repoArg;
const branch = `sandcastle/smoke-${Date.now().toString(36)}`;
const image = process.env["SANDCASTLE_IMAGE"] ?? project.imageTag;
const idleSeconds = clampIdleTimeout(Number(process.env["SANDCASTLE_IDLE_TIMEOUT"] ?? IDLE_TIMEOUT_DEFAULT));
const container = `${SMOKE_CONTAINER_PREFIX}${Date.now().toString(36)}`;

const scratch = mkdtempSync(join(tmpdir(), "sandcastle-smoke-"));
writeFileSync(join(scratch, ".env.sandbox"), "NODE_ENV=development\n", "utf8");

const layout = layoutFrom(scratch, homedir(), {
  worktreesDir: join(scratch, "worktrees"),
  repoRoots: projectRepoRoots(),
});
const runner = new NodeCommandRunner();
const log = (message: string) => console.log(message);
const git = new RealGitOps({ runner, fs: nodeFileSystem, layout, log });

const worktree = worktreePath(layout, repo, branch);
let worktreeCreated = false;
let containerCreated = false;

function cleanup(): void {
  if (containerCreated) {
    try {
      removeContainer(runner, container);
      log(`cleanup: removed container ${container}`);
    } catch (cause) {
      log(`cleanup: container ${container} — ${messageOf(cause)}`);
    }
  }
  const cwd = repoRoot(layout, repo);
  if (worktreeCreated) {
    try {
      runner.run({ command: "git", args: ["worktree", "remove", "--force", worktree], cwd });
      log(`cleanup: removed worktree ${worktree}`);
    } catch (cause) {
      log(`cleanup: worktree ${worktree} — ${messageOf(cause)}`);
    }
    try {
      runner.run({ command: "git", args: ["branch", "-D", branch], cwd });
      log(`cleanup: deleted local branch ${branch}`);
    } catch (cause) {
      log(`cleanup: branch ${branch} — ${messageOf(cause)}`);
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}

const AGENT_HOME_CHECKS: Record<ProviderName, string[]> = {
  claude: ["test -w /home/agent/.claude && test ! -w /home/agent/.claude-host"],
  codex: [
    "test -w /home/agent/.codex && test ! -w /home/agent/.codex-host",
    "test -f /home/agent/.agents/skills/tdd/SKILL.md",
    "echo --- codex exec accepts the sandcastle flags ---",
    "codex exec --help > /tmp/codex-exec-help.txt",
    ...CODEX_FLAGS.map((flag) => `grep -q -- '${flag}' /tmp/codex-exec-help.txt`),
  ],
  cursor: [
    "test -w /home/agent/.claude && test ! -w /home/agent/.claude-host",
    "cursor-agent --version",
    "cursor-agent --help > /tmp/cursor-help.txt",
    ...CURSOR_FLAGS.filter((flag) => flag.startsWith("--")).map((flag) => `grep -q -- '${flag}' /tmp/cursor-help.txt`),
  ],
};

const codexApiKey = process.env["CODEX_API_KEY"] || process.env["OPENAI_API_KEY"] || undefined;

async function codexCall(): Promise<void> {
  const login = snapshotCredential(nodeFileSystem, layout, provider);
  if (!login && !codexApiKey) {
    log(`\nsmoke: codex call SKIPPED — no ${codexLogin.hostPath(layout)} and no CODEX_API_KEY; run \`codex login\` or export CODEX_API_KEY to test it`);
    return;
  }
  log("\nsmoke: --- codex exec, one tool-free answer ---");
  try {
    const answer = await runWithIdleTimeout(
      runner,
      execRequest(container, provider.command(undefined), { input: PROBE_PROMPT, onOutput: (chunk) => process.stdout.write(chunk) }),
      idleSeconds,
    );
    if (!/"agent_message"/.test(answer.stdout)) throw new Error("codex exec finished without an agent_message event");
  } catch (cause) {
    const waiting = agentWaitFrom(cause, provider.classify);
    throw waiting ? new Error(`codex ${waiting.reason}: ${waiting.message}`) : cause;
  } finally {
    syncBackCredential({ runner, fs: nodeFileSystem, log }, container, login);
  }
}

try {
  log(`smoke: image ${image}`);
  assertDockerReady(runner, image);

  log(`smoke: creating worktree for ${repo} on ${branch}`);
  git.createItemBranch(repo, branch, integrationBase());
  worktreeCreated = true;

  const env = containerEnv(
    {
      ghToken: "smoke-not-a-real-token",
      anthropicApiKey: undefined,
      claudeOauthToken: undefined,
      codexApiKey,
      cursorApiKey: undefined,
      agents: { default: { provider: provider.name, model: undefined }, roles: {} },
      stages: DEFAULT_STAGES,
      model: "opus",
      reviewModel: "sonnet",
      imageTag: image,
      mongoImage: DEFAULT_MONGO_IMAGE,
      hubRepo: project.hubRepo,
      idleTimeoutSeconds: idleSeconds,
      claudeSyncSource: undefined,
      bootstrapCommands: {},
      checkCommands: {},
      jestWorkers: DEFAULT_JEST_WORKERS,
      reworkLimit: REWORK_LIMIT_DEFAULT,
      featureReworkLimit: REWORK_LIMIT_DEFAULT,
      verify: project.verify,
      verifyServices: {},
    },
    containerGitDir(resolveGitDir(runner, worktree)),
    provider,
  );
  withContainerEnvFile(nodeFileSystem, env, (envFile) => {
    startContainer(
      runner,
      containerSpec({ name: container, image, worktree, repoGitDir: join(repoRoot(layout, repo), ".git"), layout, envFile, workspace: "bind", provider }),
    );
  });
  containerCreated = true;
  log(`smoke: container ${container} up (agent ${provider.label})`);

  const probe = [
    "set -e",
    "echo --- identity ---",
    `node -v && git --version && gh --version | head -1 && ${provider.name} --version`,
    "echo --- container-local writable home ---",
    provider.hydrateCommand(),
    ...AGENT_HOME_CHECKS[provider.name],
    "echo --- git through the mounted worktree ---",
    "git rev-parse --abbrev-ref HEAD",
    "git log --oneline -1",
    'dirty=$(git status --short)',
    'test -z "$dirty" || { echo "worktree is dirty inside the container:"; echo "$dirty"; exit 1; }',
    "echo --- sanitized env ---",
    "test -f .env && head -1 .env",
    "echo SMOKE_OK",
  ].join("\n");
  const result = await runWithIdleTimeout(
    runner,
    execRequest(container, probe, { onOutput: (chunk) => process.stdout.write(chunk) }),
    idleSeconds,
  );
  if (!result.stdout.includes("SMOKE_OK")) throw new Error("probe did not reach SMOKE_OK");
  if (provider.name === "codex") await codexCall();
  log(`\nsmoke: PASS — worktree, container, git plumbing and ${provider.label} mounts all work`);
} catch (cause) {
  log(`\nsmoke: FAIL — ${messageOf(cause)}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
