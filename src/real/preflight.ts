import { join } from "node:path";
import type { RunModel, TargetRepo } from "../model/runModel.js";
import { agentsInUse, describeAgent } from "./agents/index.js";
import { probeAgentAuth, type AuthProbeResult } from "./authProbe.js";
import { syncClaudeHome } from "./claudeSync.js";
import type { CommandRunner } from "./commandRunner.js";
import { assertDockerReady } from "./docker.js";
import { resolveSandboxEnvFile, sandboxEnvPreflightRepos, type OrchestratorConfig } from "./env.js";
import type { FileSystemPort } from "./fileSystem.js";
import { integrationBase, isKnownRepo, knownRepos } from "../project/projectConfig.js";
import type { LocalIssueStore } from "../tracker/local/store.js";
import { missingMemoryFiles } from "./memories.js";
import { repoRoot, type SandcastleLayout } from "./paths.js";
import { missingSkillFiles, SKILLS_FIX, type SkillsCheckResult } from "./skills.js";
import { messageOf } from "../messageOf.js";

/** Every host the providers in use call, plus api.github.com unless the Tracker is local. */
export function containerEgressHosts(config: OrchestratorConfig): string[] {
  const github = config.tracker === "local" ? [] : ["api.github.com"];
  return [...new Set([...agentsInUse(config).flatMap((agent) => agent.provider.egressHosts), ...github])];
}

export const LOCAL_ISSUES_FIX =
  "fix the issue file, or run `sandcastle init` (tracker: local) to set up the config and docs/agents/issue-tracker.md";

/** The Orchestration Issue's files parse and every item names a repo of this Project. */
export function checkLocalIssueFiles(store: LocalIssueStore, parentNumber: number): string {
  const feature = store.feature(parentNumber);
  const problems = feature.items.flatMap((item) => {
    const repo = item.data["repo"];
    if (typeof repo !== "string" || repo.trim().length === 0) return [`${item.path}: no \`repo:\` in its frontmatter`];
    if (!isKnownRepo(repo.trim())) return [`${item.path}: repo "${repo.trim()}" is not a repo of this project (known: ${knownRepos().join(", ")})`];
    return [];
  });
  if (problems.length > 0) throw new Error(`${problems.join("; ")} — ${LOCAL_ISSUES_FIX}`);
  return `${feature.slug}: parent #${feature.parent.number} + ${feature.items.length} item file(s) parse, every item has a valid repo`;
}

export function containerEgressProbeArgs(image: string, host: string): string[] {
  return [
    "run", "--rm", "--entrypoint", "curl", image,
    "-4", "-sS", "-o", "/dev/null", "--max-time", "15", `https://${host}/`,
  ];
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  failures: PreflightCheck[];
}

export interface PreflightDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  config: OrchestratorConfig;
  model: RunModel;
  skipVerify: boolean;
  /** The local Tracker's issue files; required when `config.tracker` is local. */
  localStore?: LocalIssueStore;
  claudeHomeInUse?: boolean;
  /** `sandcastle skills install --check` against the agent home; without it the required skill files are looked up through `fs`. */
  skillsCheck?: () => SkillsCheckResult;
  probe?: () => Promise<AuthProbeResult>;
  log?: (message: string) => void;
}

export class PreflightError extends Error {
  constructor(readonly report: PreflightReport) {
    super(
      `sandcastle preflight failed — fix these and start again:\n${report.failures
        .map((check) => `  - ${check.name}: ${check.detail}`)
        .join("\n")}`,
    );
    this.name = "PreflightError";
  }
}

export function preflightLine(check: PreflightCheck): string {
  return `[preflight] ${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`;
}

export function activeRepos(model: RunModel): TargetRepo[] {
  return [...new Set(model.items.filter((item) => item.admission !== "done").map((item) => item.repo))].sort();
}

function requiredMemorySlugs(model: RunModel): string[] {
  return [...model.loadBearingMemories, ...model.items.flatMap((item) => item.extraMemories)];
}

async function check(
  name: string,
  work: () => string | Promise<string>,
): Promise<PreflightCheck> {
  try {
    return { name, ok: true, detail: await work() };
  } catch (cause) {
    return { name, ok: false, detail: messageOf(cause) };
  }
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const { runner, fs, layout, config, model } = deps;
  const log = deps.log ?? ((): void => undefined);
  const repos = activeRepos(model);
  const checks: PreflightCheck[] = [];

  const record = async (name: string, work: () => string | Promise<string>): Promise<void> => {
    const result = await check(name, work);
    checks.push(result);
    log(preflightLine(result));
  };

  await record("claude home", () => {
    if (!config.claudeSyncSource) return `${layout.claudeDir} (no SANDCASTLE_CLAUDE_SOURCE — nothing to sync)`;
    if (deps.claudeHomeInUse) {
      return `${layout.claudeDir} left as synced by the first parent — a sibling parent's containers hydrate from it`;
    }
    const report = syncClaudeHome(fs, config.claudeSyncSource, layout.claudeDir);
    return `synced ${report.copied.join(", ")} from ${report.source}${
      report.absent.length > 0 ? ` (absent: ${report.absent.join(", ")})` : ""
    }`;
  });

  await record("docker", () => {
    assertDockerReady(runner, config.imageTag);
    return `daemon reachable, image ${config.imageTag} present`;
  });

  const local = config.tracker === "local";
  if (local) {
    await record("issue files", () => {
      if (!deps.localStore) throw new Error(`no local issue store was given to preflight — ${LOCAL_ISSUES_FIX}`);
      return checkLocalIssueFiles(deps.localStore, model.parentNumber);
    });
  } else {
    await record("gh auth (host)", () => {
      runner.run({ command: "gh", args: ["auth", "status"] });
      return "the host gh cli can write labels and comments";
    });

    await record("GH_TOKEN (containers)", () => {
      const { stdout } = runner.run({
        command: "gh",
        args: ["api", "user", "-q", ".login"],
        env: { GH_TOKEN: config.ghToken, GITHUB_TOKEN: config.ghToken },
      });
      return `pushes and pull requests run as ${stdout.trim()}`;
    });
  }

  await record("repo checkouts", () => {
    const roots = repos.map((repo) => repoRoot(layout, repo));
    const missing = roots.filter((root) => !fs.exists(join(root, ".git")));
    if (missing.length > 0) {
      throw new Error(
        `no git checkout at ${missing.join(", ")} — set repos.<name>.path in the project config (or SANDCASTLE_WORKSPACE_ROOT in .env) to the local checkout`,
      );
    }
    return roots.join(", ");
  });

  if (!local) await record("integration base", () => {
    for (const repo of repos) {
      const cwd = repoRoot(layout, repo);
      runner.run({ command: "git", args: ["fetch", "origin", "--prune"], cwd });
      runner.run({ command: "git", args: ["rev-parse", "--verify", `origin/${integrationBase()}`], cwd });
    }
    return `origin/${integrationBase()} fetchable in ${repos.join(", ") || "no repo"} → ${model.integrationBranch}`;
  });

  await record("sandbox env files", () => {
    const found = sandboxEnvPreflightRepos(repos, deps.skipVerify).map((repo) => resolveSandboxEnvFile(fs, layout, repo));
    return found.join(", ");
  });

  await record("load-bearing memories", () => {
    const slugs = requiredMemorySlugs(model);
    const missing = missingMemoryFiles(fs, layout, slugs);
    if (missing.length > 0) {
      throw new Error(
        `not found under ${layout.memoryDir}: ${missing.join(", ")} — point SANDCASTLE_MEMORY_DIR or SANDCASTLE_CLAUDE_SOURCE at the machine that has them`,
      );
    }
    return `${new Set(slugs).size} file(s) under ${layout.memoryDir}`;
  });

  await record("agent skills", () => {
    if (deps.skillsCheck) {
      const { stale } = deps.skillsCheck();
      if (stale.length > 0) throw new Error(`${stale.join(", ")} ${SKILLS_FIX}`);
      return `shipped skills and commands current under ${layout.claudeDir}`;
    }
    const missing = missingSkillFiles(fs, layout);
    if (missing.length > 0) throw new Error(`missing ${missing.join(", ")} ${SKILLS_FIX}`);
    return `simplify, mat-review and tdd present under ${layout.claudeDir}`;
  });

  await record("container network (IPv4)", () => {
    const unreachable: string[] = [];
    const hosts = containerEgressHosts(config);
    for (const host of hosts) {
      try {
        runner.run({ command: "docker", args: containerEgressProbeArgs(config.imageTag, host) });
      } catch (cause) {
        unreachable.push(`${host} (${cause instanceof Error ? cause.message.split("\n").at(-1) : String(cause)})`);
      }
    }
    if (unreachable.length > 0) {
      throw new Error(
        `containers cannot reach ${unreachable.join(", ")} over IPv4 — containers have no IPv6, so a host that still works over IPv6 hides this; check the ISP/firewall for a TCP 443 block`,
      );
    }
    return `${hosts.join(", ")} answer over IPv4 from inside ${config.imageTag}`;
  });

  await record("agent auth", async () => {
    const probe = deps.probe ?? ((): Promise<AuthProbeResult> => probeAgentAuth({ runner, fs, layout, config, log }));
    const result = await probe();
    const answered = agentsInUse(config).map(describeAgent).join(", ");
    if (result.ok) return `a throwaway container answered ${answered} over the mounted credentials`;
    const which = result.provider && result.provider !== "claude" ? `${result.provider}: ` : "";
    throw new Error(`${which}${result.reason ?? "unknown"} — ${result.detail ?? "no detail"}`);
  });

  return { checks, failures: checks.filter((entry) => !entry.ok) };
}

export async function assertPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const report = await runPreflight(deps);
  if (report.failures.length > 0) throw new PreflightError(report);
  return report;
}
