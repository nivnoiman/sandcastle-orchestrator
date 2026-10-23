import { join } from "node:path";
import type { TargetRepo } from "../../model/runModel.js";
import { runWithIdleTimeout, type CommandRunner } from "../commandRunner.js";
import {
  createNetwork,
  createVolume,
  execDetached,
  execRequest,
  featureNetworkName,
  featureVolumeName,
  IMAGE_ENTRYPOINT,
  removeContainer,
  removeNetwork,
  removeVolume,
  renderEnvFile,
  SANDBOX_WORKDIR,
  stageContainerName,
  startContainer,
} from "../docker.js";
import { agentAuthEnv, envKeySuffix, parseEnvFile, perRepoValue, resolveSandboxEnvFile, type OrchestratorConfig } from "../env.js";
import type { FileSystemPort } from "../fileSystem.js";
import type { VerifyWorktrees } from "../gitOps.js";
import { integrationBase, knownRepos, type VerifyService } from "../../project/projectConfig.js";
import { CONTAINER_HOME, type SandcastleLayout } from "../paths.js";
import {
  claudeCommand,
  claudeHomeMounts,
  hydrateHomeCommand,
  outputTail,
  withContainerEnvFile,
} from "../sandboxRunner.js";
import { composeServiceEnv, credentialKeys, localMongoUri, MONGO_ALIAS, serviceBaseUrl } from "./composeEnv.js";
import { messageOf } from "../../messageOf.js";

export const REPORT_FILE = "report.md";
export const CONTAINER_REPORT_PATH = `${SANDBOX_WORKDIR}/${REPORT_FILE}`;
export const SOURCE_MOUNT_ROOT = `${CONTAINER_HOME}/sources`;
export const READY_ATTEMPTS = 90;
export const READY_INTERVAL_SECONDS = 2;
export const COMPOSE_OUTPUT_TAIL = 4000;

export interface ComposeService {
  repo: TargetRepo;
  ref: string;
  baseUrl: string | undefined;
  sourcePath: string;
}

export interface VerifyCommandRun {
  repo: TargetRepo;
  command: string;
  outputTail: string;
}

export interface ComposeFacts {
  network: string;
  environment: string;
  mongoUri: string | undefined;
  commands?: readonly VerifyCommandRun[] | undefined;
  externalProviders?: readonly string[] | undefined;
  reportPath: string;
  services: readonly ComposeService[];
}

export interface VerifyHarness {
  up(): Promise<ComposeFacts>;
  runAgent(prompt: string): Promise<void>;
  readReport(): string | undefined;
  down(): void;
}

export interface ComposeHarnessDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  config: OrchestratorConfig;
  git: VerifyWorktrees;
  parentNumber: number;
  feature: string;
  integrationBranch: string;
  involvedRepos: readonly TargetRepo[];
  log: (message: string) => void;
  now?: () => number;
}

export interface Disposable {
  label: string;
  dispose: () => void;
}

/** Disposes everything claimed so far, newest first; a failed disposal is logged, never thrown. */
export function tearDown(disposables: Disposable[], log: (message: string) => void): void {
  const pending = disposables.splice(0, disposables.length).reverse();
  for (const entry of pending) {
    try {
      entry.dispose();
      log(`[feature-verify] tore down ${entry.label}`);
    } catch (cause) {
      log(`[feature-verify][warn] could not tear down ${entry.label}: ${messageOf(cause)}`);
    }
  }
}

/** Claims a detached verify worktree, registering its disposal before creation so a half-made claim still tears down. */
export function claimVerifyWorktree(
  git: VerifyWorktrees,
  disposables: Disposable[],
  integrationBranch: string,
  repo: TargetRepo,
  ref: string,
): string {
  let created: string | undefined;
  disposables.push({
    label: `worktree ${repo} verify/${integrationBranch}`,
    dispose: () => {
      if (created) git.dropWorktree(repo, created);
    },
  });
  created = git.createDetachedWorktree(repo, ref, `verify/${integrationBranch}`);
  return created;
}

export class ComposeFailure extends Error {
  constructor(
    readonly step: string,
    readonly outputTail: string,
    cause: unknown,
  ) {
    super(
      `feature verify could not compose the environment — "${step}" failed: ${messageOf(cause)}` +
        (outputTail.length > 0 ? `\n--- last output ---\n${outputTail}` : ""),
    );
    this.name = "ComposeFailure";
  }
}

export function waitCommand(probe: string, failureMessage: string, logFile?: string): string {
  const dump = logFile ? `tail -n 80 ${logFile}; ` : "";
  return [
    `for attempt in $(seq 1 ${READY_ATTEMPTS}); do`,
    `  if ${probe}; then exit 0; fi;`,
    `  printf '.';`,
    `  sleep ${READY_INTERVAL_SECONDS};`,
    "done;",
    `echo "${failureMessage}"; ${dump}exit 1`,
  ].join(" ");
}

export function mongoProbe(): string {
  return "mongosh --quiet --eval 'db.runCommand({ ping: 1 })' >/dev/null 2>&1";
}

export function httpProbe(port: number, path: string): string {
  return `curl -sf http://localhost:${port}${path} >/dev/null 2>&1`;
}

export function serviceLogFile(repo: TargetRepo): string {
  return `/tmp/sandcastle-${repo}.log`;
}

export class DockerComposeHarness implements VerifyHarness {
  private readonly disposables: Disposable[] = [];
  private readonly worktrees = new Map<TargetRepo, string>();
  private agentContainer: string | undefined;
  private scratchDir: string | undefined;
  private sequence = 0;

  constructor(private readonly deps: ComposeHarnessDeps) {}

  async up(): Promise<ComposeFacts> {
    const refs = this.resolveRefs();
    const network = featureNetworkName(this.deps.parentNumber, this.stamp());
    this.claim(`network ${network}`, () => createNetwork(this.deps.runner, network), () => removeNetwork(this.deps.runner, network));

    const mongo = this.mongoEnabled();
    if (mongo) await this.startMongo(network);

    const services: ComposeService[] = [];
    for (const repo of knownRepos()) services.push(await this.startService(repo, network, perRepoValue(refs, repo, "verify ref")));

    const facts: ComposeFacts = {
      network,
      environment: `throwaway docker network — ${mongo ? "a fresh `mongo` container plus " : ""}${services.map((service) => service.repo).join(" and ")}; no hosted database was reachable from it`,
      externalProviders: this.deps.config.verify.strategy === "compose" ? this.deps.config.verify.externalProviders : [],
      mongoUri: mongo ? localMongoUri(this.deps.feature) : undefined,
      reportPath: CONTAINER_REPORT_PATH,
      services,
    };
    this.startAgent(network, facts);
    return facts;
  }

  async runAgent(prompt: string): Promise<void> {
    const container = this.agentContainer;
    if (!container) throw new Error("runAgent was called before up() — there is no feature verify agent container");
    const idle = this.deps.config.idleTimeoutSeconds;
    await this.exec(container, hydrateHomeCommand(), "agent home hydration");
    this.deps.log(`[feature-verify] agent starting (idle budget ${idle}s, model ${this.deps.config.reviewModel})`);
    await runWithIdleTimeout(
      this.deps.runner,
      execRequest(container, claudeCommand(this.deps.config.reviewModel), { input: prompt, onOutput: () => undefined }),
      idle,
    );
  }

  readReport(): string | undefined {
    if (!this.scratchDir) return undefined;
    return this.deps.fs.readText(join(this.scratchDir, REPORT_FILE));
  }

  down(): void {
    tearDown(this.disposables, this.deps.log);
  }

  private async startMongo(network: string): Promise<void> {
    const volume = featureVolumeName(this.deps.parentNumber, this.stamp());
    this.claim(`volume ${volume}`, () => createVolume(this.deps.runner, volume), () => removeVolume(this.deps.runner, volume));

    const container = this.containerName("fvmongo");
    this.claim(
      `container ${container}`,
      () =>
        startContainer(this.deps.runner, {
          name: container,
          image: this.deps.config.mongoImage,
          mounts: [],
          volumes: [{ volume, containerPath: "/data/db" }],
          network,
          networkAlias: MONGO_ALIAS,
          command: IMAGE_ENTRYPOINT,
        }),
      () => removeContainer(this.deps.runner, container),
    );
    await this.exec(container, waitCommand(mongoProbe(), "the verify mongo never answered a ping"), "mongo readiness");
  }

  private async startService(repo: TargetRepo, network: string, ref: string): Promise<ComposeService> {
    const service = perRepoValue(this.deps.config.verifyServices, repo, "verify service");
    const worktree = this.claimWorktree(repo, ref);

    const env = composeServiceEnv({
      repo,
      sandboxEnv: this.sandboxEnv(repo),
      feature: this.deps.feature,
      services: this.deps.config.verifyServices,
      source: `the sanitized sandbox env for ${repo}`,
    });
    this.warnCredentials(repo, env);
    this.deps.fs.writePrivateText(join(worktree, ".env"), renderEnvFile(env));

    const container = this.containerName(`fv${repo.replace(/[^a-z]/g, "")}`);
    this.claim(
      `container ${container}`,
      () =>
        withContainerEnvFile(this.deps.fs, env, (envFile) =>
          startContainer(this.deps.runner, {
            name: container,
            image: this.deps.config.imageTag,
            workdir: SANDBOX_WORKDIR,
            mounts: [{ hostPath: worktree, containerPath: SANDBOX_WORKDIR }],
            envFile,
            network,
            networkAlias: repo,
          }),
        ),
      () => removeContainer(this.deps.runner, container),
    );

    await this.exec(container, service.build, `${repo} build`);
    if (service.seed.trim().length > 0) await this.exec(container, service.seed, `${repo} seed`);
    execDetached(this.deps.runner, container, service.serve, serviceLogFile(repo));
    await this.exec(container, this.healthCommand(repo, service), `${repo} readiness`);

    return { repo, ref, baseUrl: serviceBaseUrl(repo, service.port), sourcePath: `${SOURCE_MOUNT_ROOT}/${repo}` };
  }

  private startAgent(network: string, facts: ComposeFacts): void {
    const scratch = this.deps.fs.makeTempDirectory("sandcastle-verify-");
    this.scratchDir = scratch;
    this.disposables.push({ label: `scratch ${scratch}`, dispose: () => this.deps.fs.removeDirectory(scratch) });

    const container = this.containerName("fvagent");
    const env: Record<string, string> = { SANDCASTLE_REPORT_PATH: facts.reportPath };
    if (facts.mongoUri) env["SANDCASTLE_MONGO_URI"] = facts.mongoUri;
    for (const service of facts.services) {
      if (service.baseUrl) env[`SANDCASTLE_${envKeySuffix(service.repo)}_URL`] = service.baseUrl;
    }
    Object.assign(env, agentAuthEnv(this.deps.config));

    this.claim(
      `container ${container}`,
      () =>
        withContainerEnvFile(this.deps.fs, env, (envFile) =>
          startContainer(this.deps.runner, {
            name: container,
            image: this.deps.config.imageTag,
            workdir: SANDBOX_WORKDIR,
            mounts: [
              { hostPath: scratch, containerPath: SANDBOX_WORKDIR },
              ...facts.services.map((service) => ({
                hostPath: this.worktreeOf(service.repo),
                containerPath: service.sourcePath,
                readonly: true,
              })),
              ...claudeHomeMounts(this.deps.layout),
            ],
            envFile,
            network,
          }),
        ),
      () => removeContainer(this.deps.runner, container),
    );
    this.agentContainer = container;
  }

  private worktreeOf(repo: TargetRepo): string {
    const found = this.worktrees.get(repo);
    if (!found) throw new Error(`no verify worktree was created for ${repo}`);
    return found;
  }

  private healthCommand(repo: TargetRepo, service: VerifyService): string {
    return waitCommand(
      httpProbe(service.port, service.healthPath),
      `${repo} never answered ${service.healthPath} on port ${service.port}`,
      serviceLogFile(repo),
    );
  }

  private resolveRefs(): Record<TargetRepo, string> {
    const refs: Record<TargetRepo, string> = {};
    for (const repo of knownRepos()) refs[repo] = this.serviceRef(repo);
    return refs;
  }

  private serviceRef(repo: TargetRepo): string {
    if (this.deps.git.remoteRefExists(repo, this.deps.integrationBranch)) return `origin/${this.deps.integrationBranch}`;
    if (this.deps.involvedRepos.includes(repo)) {
      throw new Error(
        `${repo} has work items in this run but no ${this.deps.integrationBranch} on origin — feature verify refuses to ` +
          `compose ${repo} from origin/${integrationBase()} and call the result the feature. Push the integration branch, or re-run once the ${repo} items have merged.`,
      );
    }
    this.deps.log(
      `[feature-verify] ${repo} has no work in this run and no ${this.deps.integrationBranch} on origin — composing it from origin/${integrationBase()}`,
    );
    return `origin/${integrationBase()}`;
  }

  private claimWorktree(repo: TargetRepo, ref: string): string {
    const created = claimVerifyWorktree(this.deps.git, this.disposables, this.deps.integrationBranch, repo, ref);
    this.worktrees.set(repo, created);
    return created;
  }

  private warnCredentials(repo: TargetRepo, env: Readonly<Record<string, string>>): void {
    const exposed = credentialKeys(env);
    if (exposed.length === 0) return;
    this.deps.log(
      `[feature-verify][warn] ${repo} compose env carries ${exposed.length} credential-shaped key(s) into the throwaway ` +
        `environment: ${exposed.join(", ")} — the sanitized sandbox env is the only control, so make sure those values are dev-only.`,
    );
  }

  private sandboxEnv(repo: TargetRepo): Record<string, string> {
    const path = resolveSandboxEnvFile(this.deps.fs, this.deps.layout, repo);
    const content = this.deps.fs.readText(path);
    if (content === undefined) throw new Error(`sanitized sandbox env ${path} disappeared while composing the verify env`);
    return parseEnvFile(content);
  }

  private mongoEnabled(): boolean {
    return this.deps.config.verify.strategy === "compose" && this.deps.config.verify.mongoImage !== undefined;
  }

  private async exec(container: string, command: string, step: string): Promise<void> {
    this.deps.log(`[feature-verify] ${step}`);
    const tail = outputTail(COMPOSE_OUTPUT_TAIL);
    try {
      await runWithIdleTimeout(
        this.deps.runner,
        execRequest(container, command, { onOutput: tail.append }),
        this.deps.config.idleTimeoutSeconds,
      );
    } catch (cause) {
      throw new ComposeFailure(step, tail.text(), cause);
    }
  }

  private claim(label: string, create: () => void, dispose: () => void): void {
    this.disposables.push({ label, dispose });
    create();
  }

  private containerName(stage: string): string {
    return stageContainerName(stage, this.deps.parentNumber, this.stamp());
  }

  private stamp(): string {
    this.sequence += 1;
    return `${(this.deps.now ?? Date.now)().toString(36)}${this.sequence.toString(36)}`;
  }
}
