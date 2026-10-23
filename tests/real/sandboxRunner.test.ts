import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_STAGES, type SpawnRequest, type StageCompletion, type VerifyRequest } from "../../src/engine/adapters.js";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import type { CreateDraftPrInput, PullRequestOps, PullRequestRef } from "../../src/real/ghClient.js";
import type { TargetRepo } from "../../src/model/runModel.js";
import { RunContext } from "../../src/real/runContext.js";
import {
  claimWorkspaceCommand,
  claudeCommand,
  containerEnv,
  containerGitDir,
  containerSpec,
  copyWorkspaceCommand,
  DockerSandboxRunner,
  hydrateHomeCommand,
  HYDRATE_COPIED_ENTRIES,
  withContainerEnvFile,
  type WorkspaceMode,
} from "../../src/real/sandboxRunner.js";
import { containerSkillPath, REQUIRED_SKILLS } from "../../src/real/skills.js";
import { fsWith, repoDir, testConfig, testLayout, testRunModel, worktreeDir } from "./support.js";

const INTEGRATION = "integration/toy-demo";
const BRANCH = "feat/17-toy-slice";
const SANITIZED = "feat-17-toy-slice";
const API = repoDir("api");
const WORKTREE = worktreeDir("api", SANITIZED);
const HOST_GIT_DIR = `${API}\\.git\\worktrees\\${SANITIZED}`;
const CONTAINER_GIT_DIR = `/home/agent/gitdir/worktrees/${SANITIZED}`;

const SPAWN: SpawnRequest = {
  itemNumber: 17,
  stage: "develop",
  repo: "api",
  branch: BRANCH,
  integrationBranch: INTEGRATION,
};

const VERIFY: VerifyRequest = { itemNumber: 17, repo: "api", branch: BRANCH, integrationBranch: INTEGRATION };

function openPullRequest(body = "", number = 42): PullRequestRef {
  return {
    number,
    url: `https://github.com/example-org/api/pull/${number}`,
    state: "OPEN",
    isDraft: true,
    body,
    title: "feat: toy slice",
  };
}

class FakeGh implements PullRequestOps {
  pullRequest: PullRequestRef | undefined;
  readonly created: CreateDraftPrInput[] = [];
  readonly appended: string[] = [];
  appendFailure: Error | undefined;
  onFind: (() => void) | undefined;

  findPullRequest(): PullRequestRef | undefined {
    const hook = this.onFind;
    this.onFind = undefined;
    hook?.();
    return this.pullRequest;
  }

  createDraftPullRequest(input: CreateDraftPrInput): PullRequestRef {
    this.created.push(input);
    const created = openPullRequest("", 99);
    this.pullRequest = created;
    return created;
  }

  appendToPullRequestBody(_repo: TargetRepo, pullRequest: PullRequestRef, addition: string): void {
    if (this.appendFailure) throw this.appendFailure;
    this.appended.push(addition);
    this.pullRequest = { ...pullRequest, body: `${pullRequest.body}\n${addition}` };
  }
}

function harness(
  options: {
    commits?: number;
    stageCommits?: string[];
    worktreeExists?: boolean;
    imageMissing?: boolean;
  } = {},
) {
  const runner = new RecordingCommandRunner();
  runner.respond("docker images", options.imageMissing ? "" : "sha256:abc");
  runner.respond("rev-parse --absolute-git-dir", `${HOST_GIT_DIR}\n`);
  if (options.stageCommits) runner.respond("--format=%s", options.stageCommits.join("\n"));
  if (options.commits) runner.respond("git log", Array.from({ length: options.commits }, (_, index) => `sha${index}`).join("\n"));

  const fs = fsWith({}, options.worktreeExists === false ? [API] : [API, WORKTREE]);
  const gh = new FakeGh();
  const context = new RunContext(testRunModel(), { loadMemories: () => [], hubRepo: "example-org/hub" });
  const warnings: string[] = [];
  const logs: string[] = [];
  const completions: StageCompletion[] = [];
  let resolveNext: ((completion: StageCompletion) => void) | undefined;
  const completion = new Promise<StageCompletion>((resolve) => {
    resolveNext = resolve;
  });

  const sandbox = new DockerSandboxRunner({
    runner,
    fs,
    layout: testLayout(),
    config: testConfig(),
    gh,
    context,
    log: (message) => logs.push(message),
    warn: (itemNumber, message) => warnings.push(`#${itemNumber} ${message}`),
    onComplete: (next) => {
      completions.push(next);
      resolveNext?.(next);
    },
    now: () => 1_700_000_000_000,
  });

  return { runner, fs, gh, sandbox, warnings, logs, completions, completion };
}

afterEach(() => {
  vi.useRealTimers();
});

function spec(workspace: WorkspaceMode = "bind") {
  return containerSpec({
    name: "sc-demo-develop-17-x",
    image: "sandcastle:demo",
    worktree: WORKTREE,
    repoGitDir: join(API, ".git"),
    layout: testLayout(),
    envFile: join("T:", "temp", "container.env"),
    workspace,
  });
}

describe("container composition", () => {
  it("mounts the worktree, the repo git dir and the host claude credentials", () => {
    expect(spec().mounts.map((mount) => mount.containerPath)).toEqual([
      "/home/agent/workspace",
      "/home/agent/gitdir",
      "/home/agent/.claude-host",
      "/home/agent/.claude-host.json",
    ]);
    expect(spec().workdir).toBe("/home/agent/workspace");
  });

  it("keeps node_modules and the jest cache on container-local volumes, off the host mount", () => {
    expect(spec().anonymousVolumes).toEqual(["/home/agent/workspace/node_modules", "/home/agent/workspace/.jest-cache"]);
    expect(claimWorkspaceCommand("bind")).toBe(
      "mkdir -p /home/agent/workspace/node_modules /home/agent/workspace/.jest-cache && " +
        "chown agent:agent /home/agent/workspace/node_modules /home/agent/workspace/.jest-cache",
    );
  });

  it("mounts the worktree read-only at a staging path when the workspace is a container-local copy", () => {
    const copied = spec("copy");
    expect(copied.mounts[0]).toEqual({ hostPath: WORKTREE, containerPath: "/home/agent/source", readonly: true });
    expect(copied.anonymousVolumes).toEqual([]);
    expect(copied.workdir).toBe("/home/agent/workspace");
    expect(copyWorkspaceCommand()).toBe(
      "set -o pipefail && tar -C /home/agent/source --exclude=./node_modules --exclude=./.jest-cache -cf - . | tar -C /home/agent/workspace -xf -",
    );
  });

  it("gives jest the configured worker count", () => {
    expect(containerEnv(testConfig(), CONTAINER_GIT_DIR)["JEST_MAX_WORKERS"]).toBe("4");
    expect(containerEnv(testConfig({ jestWorkers: "50%" }), CONTAINER_GIT_DIR)["JEST_MAX_WORKERS"]).toBe("50%");
  });

  it("mounts the host ~/.claude read-only at a staging path so a skip-permissions agent cannot write it", () => {
    const staged = spec().mounts.filter((mount) => mount.containerPath.startsWith("/home/agent/.claude-host"));
    expect(staged).toHaveLength(2);
    expect(staged.every((mount) => mount.readonly === true)).toBe(true);
    expect(spec().mounts.some((mount) => mount.containerPath === "/home/agent/.claude")).toBe(false);
  });

  it("copies the staged host home into a container-local writable ~/.claude", () => {
    const command = hydrateHomeCommand();
    expect(command).toContain("rm -rf /home/agent/.claude /home/agent/.claude.json");
    expect(command).toContain("tar -C /home/agent/.claude-host");
    expect(command).toContain("| tar -C /home/agent/.claude -xf -");
    expect(command).toContain("/home/agent/.claude-host.json /home/agent/.claude.json");
    expect(command).toContain("--no-preserve=ownership");
  });

  it("copies only the entries an agent needs, so a 16 MB host home does not ride into every container", () => {
    const command = hydrateHomeCommand();
    expect([...HYDRATE_COPIED_ENTRIES]).toEqual([
      "CLAUDE.md", "settings.json", "settings.local.json", ".credentials.json",
      "agents", "commands", "hooks", "skills",
    ]);
    for (const entry of HYDRATE_COPIED_ENTRIES) expect(command).toContain(`./${entry}`);
    expect(command).toContain("set -o pipefail");
  });

  it("never copies the host's transcripts, jobs, plugin marketplace or history", () => {
    const command = hydrateHomeCommand();
    for (const entry of ["projects", "todos", "sessions", "jobs", "plugins", "history.jsonl", "telemetry"]) {
      expect(command).not.toContain(`./${entry}`);
    }
    expect(command).toContain("--ignore-failed-read");
  });

  it("fails the hydrate when the trimmed copy did not deliver the fresh-eyes skills", () => {
    const command = hydrateHomeCommand();
    for (const skill of REQUIRED_SKILLS) expect(command).toContain(`test -f ${containerSkillPath(skill)}`);
  });

  it("matches the host's line endings so a Windows checkout is not spuriously dirty in the container", () => {
    expect(hydrateHomeCommand()).toContain("git config --global core.autocrlf true");
  });

  it("derives GIT_DIR from git's own admin dir rather than assuming the worktree basename", () => {
    expect(containerGitDir(`${API}\\.git\\worktrees\\feat-17-toy-slice2`)).toBe(
      "/home/agent/gitdir/worktrees/feat-17-toy-slice2",
    );
    expect(() => containerGitDir("C:\\somewhere\\else")).toThrow(/only mounts <repo>\/\.git/);
  });

  it("points git at the mounted git dir so a Windows worktree works inside Linux", () => {
    const env = containerEnv(testConfig(), CONTAINER_GIT_DIR);
    expect(env["GIT_DIR"]).toBe(CONTAINER_GIT_DIR);
    expect(env["GIT_WORK_TREE"]).toBe("/home/agent/workspace");
    expect(env["GH_TOKEN"]).toBe("gh-token");
  });

  it("passes CLAUDE_CODE_OAUTH_TOKEN only when one is configured", () => {
    expect(containerEnv(testConfig(), CONTAINER_GIT_DIR)["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(containerEnv(testConfig({ claudeOauthToken: "oat-x" }), CONTAINER_GIT_DIR)["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oat-x");
  });

  it("passes ANTHROPIC_API_KEY only when one is configured", () => {
    expect(containerEnv(testConfig(), CONTAINER_GIT_DIR)["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(containerEnv(testConfig({ anthropicApiKey: "sk-x" }), CONTAINER_GIT_DIR)["ANTHROPIC_API_KEY"]).toBe("sk-x");
  });

  it("streams the agent as json so idle detection sees progress", () => {
    expect(claudeCommand("opus")).toBe("claude -p --model opus --output-format stream-json --verbose --dangerously-skip-permissions");
  });

  it("refuses a model name it cannot safely put in a shell command", () => {
    expect(() => claudeCommand("opus; rm -rf /")).toThrow(/unquotable model name/);
  });
});

describe("develop stage", () => {
  it("runs the agent in a fresh container with the prompt on stdin and reports success", async () => {
    const { runner, sandbox, gh, completion } = harness({ commits: 2 });
    gh.pullRequest = openPullRequest();
    sandbox.spawnStage(SPAWN);
    expect(await completion).toEqual({
      itemNumber: 17,
      stage: "develop",
      outcome: "success",
      pullRequestUrl: "https://github.com/example-org/api/pull/42",
    });

    const run = runner.find("docker run");
    expect(run?.line).toContain("--name sc-demo-develop-17-");
    expect(run?.line).toContain(`-v ${WORKTREE.replace(/\\/g, "/")}:/home/agent/workspace`);
    expect(runner.find("npm ci")?.line).toContain("gh auth setup-git && npm ci");
    const agent = runner.find("claude -p");
    expect(agent?.args[0]).toBe("exec");
    expect(agent?.args[1]).toBe("-i");
    expect(agent?.line).toContain("--model opus");
    expect(agent?.input).toContain("example-org/hub#17");
    expect(runner.find("docker rm -f")).toBeDefined();
  });

  it("keeps GH_TOKEN off the argv, passing it through a private env file that is deleted again", async () => {
    const { runner, fs, sandbox, gh, completion } = harness({ commits: 1 });
    gh.pullRequest = openPullRequest();
    sandbox.spawnStage(SPAWN);
    await completion;

    const run = runner.find("docker run");
    expect(run?.line).not.toContain("gh-token");
    expect(run?.args).not.toContain("-e");
    const envFileIndex = run?.args.indexOf("--env-file") ?? -1;
    expect(envFileIndex).toBeGreaterThan(-1);
    const envFile = run?.args[envFileIndex + 1] ?? "";
    expect(envFile).toContain("container.env");
    expect(fs.exists(envFile.replace(/\//g, "\\"))).toBe(false);
    expect(fs.files.size).toBe(0);
  });

  it("takes the temp directory with the env file so a long run does not litter the host temp", () => {
    const fs = fsWith({});
    const before = fs.directories.size;
    const envFile = withContainerEnvFile(fs, { GH_TOKEN: "gh-token" }, (path) => path);
    expect(envFile).toContain("sandcastle-env-");
    expect(fs.directories.size).toBe(before);
    expect(fs.files.size).toBe(0);
  });

  it("hydrates the container-local home before anything reads ~/.claude", async () => {
    const { runner, sandbox, gh, completion } = harness({ commits: 1 });
    gh.pullRequest = openPullRequest();
    sandbox.spawnStage(SPAWN);
    await completion;
    const hydrateAt = runner.lines.findIndex((line) => line.includes("tar -C /home/agent/.claude-host"));
    const bootstrapAt = runner.lines.findIndex((line) => line.includes("npm ci"));
    expect(hydrateAt).toBeGreaterThan(-1);
    expect(hydrateAt).toBeLessThan(bootstrapAt);
  });

  it("asks git for the real admin dir of the worktree", async () => {
    const { runner, sandbox, gh, completion } = harness({ commits: 1 });
    gh.pullRequest = openPullRequest();
    sandbox.spawnStage(SPAWN);
    await completion;
    expect(runner.find("rev-parse --absolute-git-dir")?.cwd).toBe(WORKTREE);
  });

  it("opens the draft pull request itself when the agent left commits but no pull request", async () => {
    const { sandbox, gh, runner, completion, warnings } = harness({ commits: 1 });
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("success");
    expect(runner.find("git push -u origin")?.cwd).toBe(WORKTREE);
    expect(gh.created[0]).toMatchObject({ repo: "api", branch: BRANCH, baseBranch: INTEGRATION, title: "feat: toy slice" });
    expect(gh.created[0]?.body).toContain("Closes example-org/hub#17");
    expect(warnings.join()).toMatch(/no pull request — opening the draft/);
  });

  it("warns, without failing, when develop committed no failing tests first", async () => {
    const { sandbox, gh, completion, warnings } = harness({ commits: 1, stageCommits: ["feat: add the toggle"] });
    gh.pullRequest = openPullRequest();
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("success");
    expect(warnings.join()).toMatch(/no `test:` commit on feat\/17-toy-slice/);
  });

  it("stays quiet when develop committed its tests first", async () => {
    const { sandbox, gh, completion, warnings } = harness({
      commits: 2,
      stageCommits: ["feat: add the toggle", "test(toggle): prove it flips"],
    });
    gh.pullRequest = openPullRequest();
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("success");
    expect(warnings).toEqual([]);
  });

  describe("a rework round of develop", () => {
    const rework = {
      round: 2,
      limit: 3,
      briefs: [
        { round: 1, source: "review" as const, story: "never persists" },
        { round: 2, source: "verify" as const, story: "npm test red" },
      ],
    };

    it("writes the round's brief onto the pull request before the agent starts, once", async () => {
      const { sandbox, gh, completion, runner } = harness({ commits: 2 });
      gh.pullRequest = openPullRequest("## What changed\n- things");
      sandbox.spawnStage({ ...SPAWN, rework });
      await completion;
      expect(gh.appended[0]).toContain("<!-- sandcastle:rework=2 -->");
      expect(gh.appended[0]).toContain("## Rework 2/3 — sent back by verify");
      expect(gh.appended[0]).toContain("npm test red");
      expect(runner.find("claude -p")?.input).toContain("Rework round 2 of 3");
      expect(runner.find("claude -p")?.input).toContain("never persists");
    });

    it("succeeds on the round's fix section", async () => {
      const { sandbox, gh, completion } = harness({ commits: 2 });
      gh.pullRequest = openPullRequest(
        "## What changed\n\n<!-- sandcastle:rework=2 -->\n## Rework 2/3 — sent back by verify\n\nnpm test red\n\n<!-- sandcastle:develop rework=2 -->\n## Rework 2 — fix\n- fixed",
      );
      sandbox.spawnStage({ ...SPAWN, rework });
      expect(await completion).toMatchObject({ outcome: "success", pullRequestUrl: "https://github.com/example-org/api/pull/42" });
      expect(gh.appended).toEqual([]);
    });

    it("fails when the round landed neither commits nor its section", async () => {
      const { sandbox, gh, completion, warnings } = harness({ commits: 2 });
      gh.pullRequest = openPullRequest("<!-- sandcastle:rework=2 -->\n## Rework 2/3 — sent back by verify\n\nnpm test red");
      sandbox.spawnStage({ ...SPAWN, rework });
      expect((await completion).outcome).toBe("failure");
      expect(warnings.join()).toMatch(/rework round 2 landed no commits/);
    });

    it("refuses to run when the item has no pull request to rework", async () => {
      const { sandbox, completion, warnings } = harness({ commits: 2 });
      sandbox.spawnStage({ ...SPAWN, rework });
      expect((await completion).outcome).toBe("failure");
      expect(warnings.join()).toMatch(/needs the open pull request/);
    });
  });

  it("fails the stage when the agent left no commits at all", async () => {
    const { sandbox, gh, completion, warnings } = harness({ commits: 0 });
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("failure");
    expect(gh.created).toHaveLength(0);
    expect(warnings.join()).toMatch(/no commits landed/);
  });

  it("removes the container even when the stage blows up", async () => {
    const { runner, sandbox, completion, warnings } = harness({ commits: 1 });
    runner.fail(/npm ci/, new CommandFailure("docker", ["exec"], 1, "", "npm ci exploded"));
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("failure");
    expect(runner.find("docker rm -f")).toBeDefined();
    expect(warnings.join()).toMatch(/npm ci exploded/);
  });

  it("fails fast when the item branch has no worktree", async () => {
    const { sandbox, completion, warnings } = harness({ worktreeExists: false });
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("failure");
    expect(warnings.join()).toMatch(/worktree .* is missing/);
  });

  it("stops before spending a container when the docker image is missing", async () => {
    const { runner, sandbox, completion, warnings } = harness({ commits: 1, imageMissing: true });
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("failure");
    expect(warnings.join()).toMatch(/npm run build-image/);
    expect(runner.find("docker run")).toBeUndefined();
  });

});

describe("a stage the usage window or the credentials cut off", () => {
  const INIT = JSON.stringify({ type: "system", subtype: "init", tools: ["Read"] });
  const RATE_LIMIT = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1_757_000_000, rateLimitType: "five_hour" },
  });

  it("reports waiting with the reset time instead of parking the item", async () => {
    const { runner, sandbox, completion, warnings } = harness({ commits: 1 });
    runner.fail(/claude -p/, new CommandFailure("docker", ["exec"], 1, `${INIT}\n${RATE_LIMIT}`, ""));

    sandbox.spawnStage(SPAWN);
    const result = await completion;

    expect(result.outcome).toBe("waiting");
    expect(result.waitReason).toBe("rate-limit");
    expect(result.resumeAt).toBe(1_757_000_000_000);
    expect(warnings).toEqual([]);
  });

  it("reports waiting on rejected credentials, with no resume time to wait for", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    runner.fail(
      /claude -p/,
      new CommandFailure("docker", ["exec"], 1, INIT, "Failed to authenticate: OAuth session expired and could not be refreshed"),
    );

    sandbox.spawnStage(SPAWN);
    const result = await completion;

    expect(result.outcome).toBe("waiting");
    expect(result.waitReason).toBe("auth");
    expect(result.resumeAt).toBeUndefined();
  });

  it("reports an auth wait, not a rate-limit hold, when a revoked token fails a stream full of allowed limit events", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    const allowed = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1_789_741_800, rateLimitType: "five_hour", overageStatus: "rejected" },
    });
    const result401 = JSON.stringify({ type: "result", is_error: true, api_error_status: 401 });
    runner.fail(/claude -p/, new CommandFailure("docker", ["exec"], 1, `${INIT}\n${allowed}\n${result401}`, ""));

    sandbox.spawnStage(SPAWN);
    const result = await completion;

    expect(result.outcome).toBe("waiting");
    expect(result.waitReason).toBe("auth");
    expect(result.resumeAt).toBeUndefined();
  });

  it("reports waiting on a transient failure when the container cannot reach the Claude API", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    const refused = JSON.stringify({ type: "result", is_error: true, result: "API Error: Unable to connect to API (ConnectionRefused)" });
    runner.fail(/claude -p/, new CommandFailure("docker", ["exec"], 1, `${INIT}\n${refused}`, ""));

    sandbox.spawnStage(SPAWN);
    const result = await completion;

    expect(result.outcome).toBe("waiting");
    expect(result.waitReason).toBe("transient");
    expect(result.resumeAt).toBeUndefined();
  });

  it("still parks a bootstrap failure that merely mentions authentication", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    runner.fail(/npm ci/, new CommandFailure("docker", ["exec"], 1, "", "npm ERR! authentication_error on registry"));

    sandbox.spawnStage(SPAWN);

    expect((await completion).outcome).toBe("failure");
  });

  it("puts the last stream event in the park detail so the comment is not a truncated init line", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    const result = JSON.stringify({ type: "result", is_error: true, result: "model refused" });
    runner.fail(/claude -p/, new CommandFailure("docker", ["exec"], 1, `${INIT}\n${result}`, ""));

    sandbox.spawnStage(SPAWN);

    expect((await completion).detail).toContain("model refused");
  });
});

describe("review and simplify settlement", () => {
  const REVIEW: SpawnRequest = { ...SPAWN, stage: "review" };
  const SIMPLIFY: SpawnRequest = { ...SPAWN, stage: "simplify" };
  const REVIEWED = "## What changed\n- things\n\n<!-- sandcastle:review -->\n## Review\n- fixed a thing";

  it("runs the stage agent with the stage's own prompt", async () => {
    const { runner, sandbox, gh, completion } = harness({ commits: 2 });
    gh.pullRequest = openPullRequest(REVIEWED);
    sandbox.spawnStage(REVIEW);
    expect(await completion).toEqual({ itemNumber: 17, stage: "review", outcome: "success" });
    expect(runner.find("docker run")?.line).toContain("--name sc-demo-review-17-");
    expect(runner.find("claude -p")?.input).toContain("/home/agent/.claude/skills/mat-review/SKILL.md");
    expect(runner.find("claude -p")?.line).toContain("--model sonnet");
  });

  it("succeeds on the pull-request section alone when the stage found nothing to fix", async () => {
    const { sandbox, gh, completion, warnings, logs } = harness({ commits: 1, stageCommits: [] });
    gh.pullRequest = openPullRequest("## What changed\n- things\n\n<!-- sandcastle:review -->\n## Review\n\nno findings");
    sandbox.spawnStage(REVIEW);
    expect((await completion).outcome).toBe("success");
    expect(warnings).toEqual([]);
    expect(logs.join()).toMatch(/#17 review done/);
  });

  it("does not accept a bare heading the agent wrote without the sentinel", async () => {
    const { sandbox, gh, completion } = harness({ commits: 1, stageCommits: ["feat: toy slice"] });
    gh.pullRequest = openPullRequest("## What changed\n\n```md\n## Review\n```");
    sandbox.spawnStage(REVIEW);
    expect((await completion).outcome).toBe("failure");
  });

  it("appends the missing section itself when stage commits landed without one", async () => {
    const { sandbox, gh, completion, warnings, logs } = harness({
      commits: 3,
      stageCommits: ["feat: toy slice", "fix(review): guard the null", "fix(review): rename the thing"],
    });
    gh.pullRequest = openPullRequest("## What changed\n- things");
    sandbox.spawnStage(REVIEW);
    expect((await completion).outcome).toBe("success");
    expect(gh.appended).toHaveLength(1);
    expect(gh.appended[0]).toContain("<!-- sandcastle:review -->");
    expect(gh.appended[0]).toContain("`fix(review): guard the null`");
    expect(gh.appended[0]).toContain("`fix(review): rename the thing`");
    expect(gh.appended[0]).not.toContain("feat: toy slice");
    expect(warnings.join()).toMatch(/2 `fix\(review\):` commit\(s\) landed but the review agent wrote no "## Review" section/);
    expect(logs.join()).toMatch(/#17 review done \(orchestrator-recorded\)/);
  });

  it("fails the stage when the stub section cannot be written to the pull request", async () => {
    const { sandbox, gh, completion, warnings } = harness({ commits: 2, stageCommits: ["fix(review): guard the null"] });
    gh.pullRequest = openPullRequest("## What changed\n- things");
    gh.appendFailure = new Error("rate limited");
    sandbox.spawnStage(REVIEW);
    expect((await completion).outcome).toBe("failure");
    expect(warnings.join()).toMatch(/rate limited/);
  });

  it("fails the stage with the agent's reason when it declares the work unfixable", async () => {
    const { sandbox, gh, completion, warnings } = harness({ commits: 2, stageCommits: ["fix(review): guard the null"] });
    gh.pullRequest = openPullRequest(
      "## What changed\n\n<!-- sandcastle:review -->\n## Review\n\nUNFIXABLE: the fix needs a schema migration",
    );
    sandbox.spawnStage(REVIEW);
    expect((await completion).outcome).toBe("failure");
    expect(gh.appended).toEqual([]);
    expect(warnings.join()).toMatch(/unfixable in place .*: the fix needs a schema migration/);
  });

  it("sends the item back to develop with the review's story when it asks for rework", async () => {
    const { sandbox, gh, completion } = harness({ commits: 1, stageCommits: ["feat: toy slice"] });
    gh.pullRequest = openPullRequest(
      "## What changed\n\n<!-- sandcastle:review -->\n## Review\n\nNEEDS-REWORK:\n### What is wrong\nthe toggle never persists",
    );
    sandbox.spawnStage(REVIEW);
    const result = await completion;
    expect(result).toMatchObject({
      outcome: "failure",
      rework: { source: "review", story: "### What is wrong\nthe toggle never persists" },
    });
  });

  it("settles a rework round's review on that round's sentinel, not the first pass's", async () => {
    const { sandbox, gh, completion } = harness({ commits: 3, stageCommits: ["fix(review): old"] });
    const rework = { round: 1, limit: 3, briefs: [{ round: 1, source: "verify" as const, story: "red" }] };
    gh.pullRequest = openPullRequest(REVIEWED);
    sandbox.spawnStage({ ...REVIEW, rework });
    expect((await completion).outcome).toBe("failure");

    const second = harness({ commits: 3 });
    second.gh.pullRequest = openPullRequest(`${REVIEWED}\n\n<!-- sandcastle:review rework=1 -->\n## Review (rework 1)\n- ok`);
    second.sandbox.spawnStage({ ...REVIEW, rework });
    expect((await second.completion).outcome).toBe("success");
  });

  it("fails the stage when it left neither a stage commit nor a section", async () => {
    const { sandbox, gh, completion, warnings } = harness({ commits: 1, stageCommits: ["feat: toy slice"] });
    gh.pullRequest = openPullRequest("## What changed\n- things");
    sandbox.spawnStage(REVIEW);
    expect((await completion).outcome).toBe("failure");
    expect(gh.appended).toEqual([]);
    expect(warnings.join()).toMatch(/left no evidence it ran/);
  });

  it("fails the stage when the develop pull request is gone", async () => {
    const { sandbox, completion, warnings } = harness({ commits: 1 });
    sandbox.spawnStage(REVIEW);
    expect((await completion).outcome).toBe("failure");
    expect(warnings.join()).toMatch(/no pull request on feat\/17-toy-slice/);
  });

  it("reads the simplify section, not the review one, when settling simplify", async () => {
    const { sandbox, gh, completion, warnings } = harness({
      commits: 2,
      stageCommits: ["feat: toy slice", "fix(review): guard the null"],
    });
    gh.pullRequest = openPullRequest(REVIEWED);
    sandbox.spawnStage(SIMPLIFY);
    expect((await completion).outcome).toBe("failure");
    expect(warnings.join()).toMatch(/no `refactor\(simplify\):` commits and no "## Simplify" section/);
  });
});

describe("the gate conflict resolve pass", () => {
  const RESOLVE = {
    itemNumber: 17,
    repo: "api" as TargetRepo,
    branch: BRANCH,
    integrationBranch: INTEGRATION,
    files: ["src/models/Profile.ts", "src/types/profileTypes.ts"],
  };

  it("runs a constrained agent on the conflicting files and reports the branch resolved", async () => {
    const { runner, sandbox, completion } = harness({ commits: 2 });
    sandbox.spawnResolve(RESOLVE);
    const result = await completion;

    expect(result).toMatchObject({ itemNumber: 17, stage: "verify", outcome: "success", resolved: true });
    const agent = runner.findAll(/claude -p/)[0];
    expect(agent?.input).toContain("Resolve a merge conflict");
    expect(agent?.line).toContain("--model opus");
    expect(agent?.input).toContain("src/models/Profile.ts");
    expect(agent?.input).toContain(`git rebase origin/${INTEGRATION}`);
    expect(runner.find(/merge-base --is-ancestor/)).toBeDefined();
  });

  it("fails the gate when the agent leaves the branch off the integration tip", async () => {
    const { runner, sandbox, completion } = harness({ commits: 2 });
    runner.fail(/merge-base --is-ancestor/, new CommandFailure("git", ["merge-base"], 1, "", ""));
    sandbox.spawnResolve(RESOLVE);
    const result = await completion;

    expect(result.outcome).toBe("failure");
    expect(result.resolved).toBeUndefined();
    expect(result.detail).toContain("off the tip of origin/integration/toy-demo");
  });
});

describe("salvage pass", () => {
  it("runs a constrained second pass when the agent idles out with commits on the branch", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, completion, warnings } = harness({ commits: 3 });
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage(SPAWN);
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await completion).outcome).toBe("success");
    const agentRuns = runner.findAll(/claude -p/);
    expect(agentRuns).toHaveLength(2);
    expect(agentRuns[1]?.input).toContain("Salvage pass");
    expect(warnings.join()).toMatch(/constrained salvage pass in a fresh container \(300s idle budget\)/);
  });

  it("tears the timed-out container down before the salvage agent touches the same worktree", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, completion } = harness({ commits: 3 });
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage(SPAWN);
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await completion).outcome).toBe("success");

    const timedOutContainer = runner.findAll(/claude -p/)[0]?.args[2];
    const salvageContainer = runner.findAll(/claude -p/)[1]?.args[2];
    expect(timedOutContainer).toBeDefined();
    expect(salvageContainer).not.toBe(timedOutContainer);

    const removedAt = runner.lines.findIndex((line) => line === `docker rm -f -v ${timedOutContainer}`);
    const salvageStartedAt = runner.lines.findIndex((line) => line.includes(`--name ${salvageContainer}`));
    expect(removedAt).toBeGreaterThan(-1);
    expect(salvageStartedAt).toBeGreaterThan(removedAt);
    expect(runner.findAll("docker rm -f")).toHaveLength(2);
  });

  it("runs a salvage pass for every agent stage that idles out with work on the branch", async () => {
    vi.useFakeTimers();
    for (const stage of AGENT_STAGES) {
      const { runner, sandbox, gh, completion, warnings } = harness({ commits: 2, stageCommits: ["fix(review): a", "refactor(simplify): b"] });
      if (stage !== "develop") gh.pullRequest = openPullRequest("## What changed\n- things");
      runner.hold(/claude -p/, 1);
      sandbox.spawnStage({ ...SPAWN, stage });
      await vi.advanceTimersByTimeAsync(600_000);
      await completion;
      const agentRuns = runner.findAll(/claude -p/);
      expect(agentRuns).toHaveLength(2);
      const expectedModel = stage === "develop" ? "opus" : "sonnet";
      for (const run of agentRuns) expect(run.line).toContain(`--model ${expectedModel}`);
      expect(warnings.join()).toMatch(/constrained salvage pass/);
    }
  });

  it("does not salvage when nothing was committed", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, completion, warnings } = harness({ commits: 0 });
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage(SPAWN);
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await completion).outcome).toBe("failure");
    expect(runner.findAll(/claude -p/)).toHaveLength(1);
    expect(warnings.join()).toMatch(/0 commits — nothing to salvage/);
  });

  it("treats an idle-out after the pull request opened as done", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, gh, completion, warnings } = harness({ commits: 2 });
    gh.pullRequest = openPullRequest();
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage(SPAWN);
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await completion).outcome).toBe("success");
    expect(runner.findAll(/claude -p/)).toHaveLength(1);
    expect(warnings.join()).toMatch(/after opening its pull request/);
  });

  it("salvages a review that idled out before its section reached the pull request", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, gh, completion, warnings } = harness({ commits: 2, stageCommits: ["fix(review): a"] });
    gh.pullRequest = openPullRequest("## What changed\n- things");
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage({ ...SPAWN, stage: "review" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await completion).outcome).toBe("success");
    const agentRuns = runner.findAll(/claude -p/);
    expect(agentRuns).toHaveLength(2);
    expect(agentRuns[1]?.input).toContain("Salvage pass for the review stage");
    expect(warnings.join()).toMatch(/before "## Review" reached .*— running a constrained salvage pass/);
  });

  it("treats a review idle-out after the section landed as done", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, gh, completion, warnings } = harness({ commits: 2 });
    gh.pullRequest = openPullRequest("## What changed\n- things\n\n<!-- sandcastle:review -->\n## Review\n- fixed a thing");
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage({ ...SPAWN, stage: "review" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await completion).outcome).toBe("success");
    expect(runner.findAll(/claude -p/)).toHaveLength(1);
    expect(warnings.join()).toMatch(/after appending its "## Review" section/);
  });

  it("does not salvage a review when the pull request it should annotate is gone", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, completion, warnings } = harness({ commits: 2 });
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage({ ...SPAWN, stage: "review" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await completion).outcome).toBe("failure");
    expect(runner.findAll(/claude -p/)).toHaveLength(1);
    expect(warnings.join()).toMatch(/has no pull request to finish — nothing to salvage/);
  });

  it("gives up after a single salvage attempt", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, completion, warnings } = harness({ commits: 2 });
    runner.hold(/claude -p/, 2);
    sandbox.spawnStage(SPAWN);
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await completion).outcome).toBe("failure");
    expect(runner.findAll(/claude -p/)).toHaveLength(2);
    expect(warnings.join()).toMatch(/salvage pass also failed/);
  });
});

describe("cancelling a stage", () => {
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const containerOf = (call: { args: string[] } | undefined): string | undefined => call?.args[3];

  it("removes the container the cancelled attempt started and drops only that attempt's completion", async () => {
    const { runner, sandbox, gh, completions } = harness({ commits: 1 });
    gh.pullRequest = openPullRequest();
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage(SPAWN);
    const container = containerOf(runner.find("docker run"));

    sandbox.kill(17);
    expect(runner.findAll("docker rm -f -v").map((call) => call.args[3])).toEqual([container]);

    runner.held[0]?.finish();
    await flush();

    expect(completions).toEqual([]);
    expect(runner.findAll("docker rm -f")).toHaveLength(1);
  });

  it("keeps a retried attempt's completion instead of swallowing it with the earlier cancel", async () => {
    const { runner, sandbox, gh, completions } = harness({ commits: 1 });
    gh.pullRequest = openPullRequest();
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage(SPAWN);
    sandbox.kill(17);

    sandbox.spawnStage(SPAWN);
    await flush();
    expect(completions).toEqual([
      { itemNumber: 17, stage: "develop", outcome: "success", pullRequestUrl: gh.pullRequest?.url },
    ]);

    runner.held[0]?.finish();
    await flush();
    expect(completions).toHaveLength(1);
  });

  it("never starts the next container when the cancel lands between two of them", async () => {
    vi.useFakeTimers();
    const { runner, sandbox, gh, completions } = harness({ commits: 3 });
    gh.onFind = () => sandbox.kill(17);
    runner.hold(/claude -p/, 1);
    sandbox.spawnStage(SPAWN);

    await vi.advanceTimersByTimeAsync(600_000);

    expect(runner.findAll("docker run")).toHaveLength(1);
    expect(runner.findAll(/claude -p/)).toHaveLength(1);
    expect(completions).toEqual([]);
  });
});

describe("verify gate", () => {
  it("runs the repo's check command inside a container and reports the outcome", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    sandbox.runChecks(VERIFY);
    expect(await completion).toEqual({ itemNumber: 17, stage: "verify", outcome: "success" });
    expect(runner.find("tsc -p tsconfig.ci.json")).toBeDefined();
    expect(runner.find("docker run")?.line).toContain("--name sc-demo-verify-17-");
  });

  it("runs the checks on a container-local copy of the worktree, never over the host mount", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    sandbox.runChecks(VERIFY);
    await completion;
    const run = runner.find("docker run")?.line ?? "";
    expect(run).toContain(`-v ${WORKTREE.replace(/\\/g, "/")}:/home/agent/source:ro`);
    expect(run).not.toContain(":/home/agent/workspace");
    const lines = runner.lines;
    const copy = lines.findIndex((line) => line.includes(copyWorkspaceCommand()));
    const bootstrap = lines.findIndex((line) => line.includes("npm ci"));
    expect(runner.find(claimWorkspaceCommand("copy"))?.line).toContain("exec -u root");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(bootstrap);
  });

  it("fails the gate when the checks come back red", async () => {
    const { runner, sandbox, completion, warnings } = harness({ commits: 1 });
    runner.fail(/tsc -p tsconfig.ci.json/, new CommandFailure("docker", ["exec"], 2, "", "TS2345"));
    sandbox.runChecks(VERIFY);
    expect((await completion).outcome).toBe("failure");
    expect(warnings.join()).toMatch(/TS2345/);
  });

  it("keeps the tail of the check output on the failure so it can reach the park comment", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    const noise = "x".repeat(5000);
    runner.fail(
      /tsc -p tsconfig.ci.json/,
      new CommandFailure("docker", ["exec"], 2, `${noise}\nsrc/a.ts(3,7): error TS2345: nope\n`, "exit 2"),
    );
    sandbox.runChecks(VERIFY);
    const result = await completion;
    expect(result.outcome).toBe("failure");
    expect(result.detail).toContain("--- last output ---");
    expect(result.detail).toContain("error TS2345: nope");
    expect(result.detail?.length).toBeLessThan(5000);
  });

  it("sends red checks back to develop with a story built from the branch and the check output", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1, stageCommits: ["feat: add the toggle"] });
    runner.fail(/tsc -p tsconfig.ci.json/, new CommandFailure("docker", ["exec"], 2, "src/a.ts(3,7): error TS2345: nope\n", "exit 2"));
    sandbox.runChecks(VERIFY);
    const result = await completion;
    expect(result.rework?.source).toBe("verify");
    const story = result.rework?.story ?? "";
    expect(story).toContain("### What happened");
    expect(story).toContain("### Why it matters");
    expect(story).toContain("- `feat: add the toggle`");
    expect(story).toContain("error TS2345: nope");
    expect(story).toContain("### What a fix must achieve");
  });

  it("does not ask for rework when the gate fails for anything but red checks", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    runner.fail("npm ci", new CommandFailure("docker", ["exec"], 1, "", "npm ERR! peer dep conflict"));
    sandbox.runChecks(VERIFY);
    const result = await completion;
    expect(result.outcome).toBe("failure");
    expect(result.rework).toBeUndefined();
  });

  it("says nothing about output when the checks pass", async () => {
    const { sandbox, completion, warnings } = harness({ commits: 1 });
    sandbox.runChecks(VERIFY);
    await completion;
    expect(warnings).toEqual([]);
  });

  it("reports a network failure during npm ci as a transient wait, not a red gate", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    runner.fail("npm ci", new CommandFailure("docker", ["exec"], 1, "", "npm error code ECONNRESET\nnpm error network aborted"));
    sandbox.runChecks(VERIFY);
    expect(await completion).toMatchObject({ itemNumber: 17, stage: "verify", outcome: "waiting", waitReason: "transient" });
  });

  it("keeps a red check red even when a test prints a network error", async () => {
    const { runner, sandbox, completion } = harness({ commits: 1 });
    runner.fail(/tsc -p tsconfig.ci.json/, new CommandFailure("docker", ["exec"], 1, "FAIL tests/a.test.ts\n  ECONNREFUSED 127.0.0.1:6379", ""));
    sandbox.runChecks(VERIFY);
    expect((await completion).outcome).toBe("failure");
  });
});
