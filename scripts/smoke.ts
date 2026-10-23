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
  hydrateHomeCommand,
  withContainerEnvFile,
} from "../src/real/sandboxRunner.js";
import { messageOf } from "../src/messageOf.js";

const project = bootProject();
const repoArg = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? knownRepos()[0]!;
if (!isTargetRepo(repoArg)) {
  console.error(`usage: sandcastle smoke [${knownRepos().join("|")}] [--config=path]`);
  process.exit(2);
}
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
  );
  withContainerEnvFile(nodeFileSystem, env, (envFile) => {
    startContainer(
      runner,
      containerSpec({ name: container, image, worktree, repoGitDir: join(repoRoot(layout, repo), ".git"), layout, envFile, workspace: "bind" }),
    );
  });
  containerCreated = true;
  log(`smoke: container ${container} up`);

  const probe = [
    "set -e",
    "echo --- identity ---",
    "node -v && git --version && gh --version | head -1 && claude --version",
    "echo --- container-local writable home ---",
    hydrateHomeCommand(),
    "test -w /home/agent/.claude && test ! -w /home/agent/.claude-host",
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
  log("\nsmoke: PASS — worktree, container, git plumbing and mounts all work");
} catch (cause) {
  log(`\nsmoke: FAIL — ${messageOf(cause)}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
