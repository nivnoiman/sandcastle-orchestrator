import { join } from "node:path";
import { REWORK_LIMIT_DEFAULT } from "../engine/rework.js";
import type { TargetRepo } from "../model/runModel.js";
import {
  activeProject,
  DEFAULT_MONGO_IMAGE,
  knownRepos,
  type TrackerKind,
  type VerifyService,
  type VerifyStrategy,
} from "../project/projectConfig.js";
import type { AgentsConfig } from "../project/agentsConfig.js";
import type { StageSpec } from "../project/stagesConfig.js";
import type { FileSystemPort } from "./fileSystem.js";
import { defaultLayout, sandcastleDirFrom, TOOL_DIR, type SandcastleLayout } from "./paths.js";

export const IDLE_TIMEOUT_DEFAULT = 1200;
export const IDLE_TIMEOUT_MIN = 60;
export const IDLE_TIMEOUT_MAX = 7200;
export const SALVAGE_IDLE_MAX = 300;
export const DEFAULT_MODEL = "opus";
export const DEFAULT_REVIEW_MODEL = "sonnet";
export const DEFAULT_JEST_WORKERS = "4";
const JEST_WORKERS = /^[1-9]\d?%?$/;
const REWORK_LIMIT = /^\d+$/;

export interface OrchestratorConfig {
  tracker: TrackerKind;
  /** Empty with the local Tracker: nothing talks to GitHub. */
  ghToken: string;
  anthropicApiKey: string | undefined;
  claudeOauthToken: string | undefined;
  codexApiKey: string | undefined;
  cursorApiKey: string | undefined;
  agents: AgentsConfig;
  stages: readonly StageSpec[];
  model: string;
  reviewModel: string;
  imageTag: string;
  mongoImage: string;
  hubRepo: string;
  idleTimeoutSeconds: number;
  claudeSyncSource: string | undefined;
  bootstrapCommands: Record<TargetRepo, string>;
  checkCommands: Record<TargetRepo, string>;
  jestWorkers: string;
  reworkLimit: number;
  featureReworkLimit: number;
  verify: VerifyStrategy;
  verifyServices: Record<TargetRepo, VerifyService>;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    values[key] = value;
  }
  return values;
}

export function numericSetting(values: Record<string, string>, key: string): number | undefined {
  const raw = values[key];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key}="${raw}" is not a number — fix it in .env.orchestrator or remove the line to take the default`);
  }
  return parsed;
}

export function clampIdleTimeout(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return IDLE_TIMEOUT_DEFAULT;
  return Math.max(IDLE_TIMEOUT_MIN, Math.min(IDLE_TIMEOUT_MAX, Math.trunc(raw)));
}

export function salvageIdleTimeout(idleTimeoutSeconds: number): number {
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 1) {
    throw new Error(`salvage budget needs a positive idle timeout, got ${idleTimeoutSeconds}`);
  }
  return Math.min(idleTimeoutSeconds, SALVAGE_IDLE_MAX);
}

export const ORCHESTRATOR_ENV_FILE = ".env.orchestrator";

export function orchestratorEnvPath(layout: SandcastleLayout): string {
  return join(layout.sandcastleDir, ORCHESTRATOR_ENV_FILE);
}

export function sandboxEnvCandidates(layout: SandcastleLayout, repo: TargetRepo): string[] {
  return [join(layout.sandcastleDir, `.env.sandbox.${repo}`), join(layout.sandcastleDir, ".env.sandbox")];
}

export function sandboxEnvPreflightRepos(activeRepos: readonly TargetRepo[], skipVerify: boolean): TargetRepo[] {
  const repos = new Set<TargetRepo>(activeRepos);
  if (!skipVerify && activeProject().verify.strategy === "compose") for (const repo of knownRepos()) repos.add(repo);
  return [...repos].sort();
}

export function resolveSandboxEnvFile(fs: FileSystemPort, layout: SandcastleLayout, repo: TargetRepo): string {
  const candidates = sandboxEnvCandidates(layout, repo);
  const found = candidates.find((candidate) => fs.exists(candidate));
  if (found) return found;
  throw new Error(
    `missing sanitized sandbox env for "${repo}" — expected one of ${candidates.join(" or ")}. ` +
      `Copy .env.sandbox.example there and fill it with SAFE dev values (an empty file is fine); never copy the real ${repo} .env.`,
  );
}

export function envKeySuffix(repo: TargetRepo): string {
  return repo.toUpperCase().replace(/-/g, "_");
}

function perRepo(values: Record<string, string>, prefix: string, pick: (repo: TargetRepo) => string): Record<TargetRepo, string> {
  const resolved: Record<TargetRepo, string> = {};
  for (const repo of knownRepos()) resolved[repo] = values[`${prefix}${envKeySuffix(repo)}`] || pick(repo);
  return resolved;
}

function verifyPort(values: Record<string, string>, repo: TargetRepo, fallback: number): number {
  const key = `SANDCASTLE_VERIFY_PORT_${envKeySuffix(repo)}`;
  const parsed = numericSetting(values, key);
  if (parsed === undefined) return fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${key}="${values[key]}" is not a tcp port — fix it in .env.orchestrator or remove the line`);
  }
  return parsed;
}

function verifyServices(values: Record<string, string>, verify: VerifyStrategy): Record<TargetRepo, VerifyService> {
  const resolved: Record<TargetRepo, VerifyService> = {};
  if (verify.strategy !== "compose") return resolved;
  for (const [repo, defaults] of Object.entries(verify.services)) {
    const suffix = envKeySuffix(repo);
    resolved[repo] = {
      build: values[`SANDCASTLE_VERIFY_BUILD_${suffix}`] || defaults.build,
      seed: values[`SANDCASTLE_VERIFY_SEED_${suffix}`] ?? defaults.seed,
      serve: values[`SANDCASTLE_VERIFY_SERVE_${suffix}`] || defaults.serve,
      port: verifyPort(values, repo, defaults.port),
      healthPath: values[`SANDCASTLE_VERIFY_HEALTH_${suffix}`] || defaults.healthPath,
      env: defaults.env,
    };
  }
  return resolved;
}

export function reworkLimit(values: Record<string, string>, key = "SANDCASTLE_REWORK_LIMIT"): number {
  const raw = values[key]?.trim();
  if (!raw) return REWORK_LIMIT_DEFAULT;
  if (!REWORK_LIMIT.test(raw)) {
    throw new Error(`${key}="${raw}" must be a whole number of rework rounds (0 parks on the first red check) — fix it in .env.orchestrator`);
  }
  return Number(raw);
}

export function jestWorkers(values: Record<string, string>): string {
  const raw = values["SANDCASTLE_JEST_WORKERS"]?.trim();
  if (!raw) return DEFAULT_JEST_WORKERS;
  if (!JEST_WORKERS.test(raw)) {
    throw new Error(`SANDCASTLE_JEST_WORKERS="${raw}" must be a worker count like 4 or a share like 50% — fix it in .env.orchestrator`);
  }
  return raw;
}

export interface LoadConfigOptions {
  idleTimeoutSeconds?: number;
  hubRepo?: string;
  tracker?: TrackerKind;
}

/** The tool-wide .env.orchestrator (shared secrets) overlaid by the project's own one in its state dir. */
export function readOrchestratorEnv(fs: FileSystemPort, layout: SandcastleLayout, toolDir = TOOL_DIR): { values: Record<string, string>; found: string[] } {
  return readEnvLayers(fs, layout.sandcastleDir, toolDir);
}

function readEnvLayers(fs: FileSystemPort, sandcastleDir: string, toolDir: string): { values: Record<string, string>; found: string[] } {
  const paths = [...new Set([join(toolDir, ORCHESTRATOR_ENV_FILE), join(sandcastleDir, ORCHESTRATOR_ENV_FILE)])];
  const found: string[] = [];
  let values: Record<string, string> = {};
  for (const path of paths) {
    const content = fs.readText(path);
    if (content === undefined) continue;
    found.push(path);
    values = { ...values, ...parseEnvFile(content) };
  }
  return { values, found };
}

export function loadOrchestratorConfig(
  fs: FileSystemPort,
  layout: SandcastleLayout,
  options: LoadConfigOptions = {},
): OrchestratorConfig {
  const path = orchestratorEnvPath(layout);
  const project = activeProject();
  const tracker = options.tracker ?? project.tracker;
  const { values, found } = readOrchestratorEnv(fs, layout);
  if (tracker !== "local" && found.length === 0) {
    throw new Error(
      `missing ${path} — sandcastle refuses to start without it. Copy .env.orchestrator.example there (or to ${join(TOOL_DIR, ORCHESTRATOR_ENV_FILE)} to share it across projects) and fill in GH_TOKEN.`,
    );
  }
  const ghToken = values["GH_TOKEN"] ?? "";
  if (tracker !== "local" && !ghToken) throw new Error(`${found.join(" + ")} has no GH_TOKEN — agents cannot push branches or open PRs without it`);

  const idleFromFile = numericSetting(values, "SANDCASTLE_IDLE_TIMEOUT");
  return {
    tracker,
    ghToken,
    anthropicApiKey: values["ANTHROPIC_API_KEY"] || undefined,
    claudeOauthToken: values["CLAUDE_CODE_OAUTH_TOKEN"] || undefined,
    codexApiKey: values["CODEX_API_KEY"] || values["OPENAI_API_KEY"] || undefined,
    cursorApiKey: values["CURSOR_API_KEY"] || undefined,
    agents: project.agents,
    stages: project.stages,
    model: values["SANDCASTLE_MODEL"] || DEFAULT_MODEL,
    reviewModel: values["SANDCASTLE_REVIEW_MODEL"] || DEFAULT_REVIEW_MODEL,
    imageTag: values["SANDCASTLE_IMAGE"] || project.imageTag,
    mongoImage:
      values["SANDCASTLE_VERIFY_MONGO_IMAGE"] ||
      (project.verify.strategy === "compose" ? project.verify.mongoImage : undefined) ||
      DEFAULT_MONGO_IMAGE,
    hubRepo: options.hubRepo ?? project.hubRepo,
    idleTimeoutSeconds: clampIdleTimeout(options.idleTimeoutSeconds ?? idleFromFile),
    claudeSyncSource: values["SANDCASTLE_CLAUDE_SOURCE"] || undefined,
    bootstrapCommands: perRepo(values, "SANDCASTLE_BOOTSTRAP_", (repo) => project.repos[repo]!.bootstrap),
    checkCommands: perRepo(values, "SANDCASTLE_CHECKS_", (repo) => project.repos[repo]!.checks),
    jestWorkers: jestWorkers(values),
    reworkLimit: reworkLimit(values),
    featureReworkLimit: reworkLimit(values, "SANDCASTLE_FEATURE_REWORK_LIMIT"),
    verify: project.verify,
    verifyServices: verifyServices(values, project.verify),
  };
}

/** Claude Code credentials beyond the mounted ~/.claude login: an API key, a `claude setup-token` OAuth token, or both. */
export function agentAuthEnv(config: Pick<OrchestratorConfig, "anthropicApiKey" | "claudeOauthToken">): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.anthropicApiKey) env["ANTHROPIC_API_KEY"] = config.anthropicApiKey;
  if (config.claudeOauthToken) env["CLAUDE_CODE_OAUTH_TOKEN"] = config.claudeOauthToken;
  return env;
}

export function readEnvFileValues(fs: FileSystemPort, sandcastleDir: string, toolDir = TOOL_DIR): Record<string, string> {
  return readEnvLayers(fs, sandcastleDir, toolDir).values;
}

export function resolveLayout(fs: FileSystemPort, env: NodeJS.ProcessEnv = process.env): SandcastleLayout {
  return defaultLayout(env, readEnvFileValues(fs, sandcastleDirFrom(env)));
}

export function perRepoValue<T>(values: Readonly<Record<TargetRepo, T>>, repo: TargetRepo, what: string): T {
  const value = values[repo];
  if (value === undefined) throw new Error(`no ${what} configured for repo "${repo}" — add it under repos.${repo} in the project config`);
  return value;
}

export function checkCommand(config: OrchestratorConfig, repo: TargetRepo): string {
  return perRepoValue(config.checkCommands, repo, "checks command");
}

export function bootstrapScript(config: OrchestratorConfig, repo: TargetRepo): string {
  const bootstrap = perRepoValue(config.bootstrapCommands, repo, "bootstrap command").trim();
  if (config.tracker === "local") return bootstrap.length > 0 ? bootstrap : "true";
  return bootstrap.length > 0 ? `gh auth setup-git && ${bootstrap}` : "gh auth setup-git";
}
