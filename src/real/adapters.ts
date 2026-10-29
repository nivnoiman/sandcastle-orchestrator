import type { Adapters, GitOps, StageCompletion, UiSink } from "../engine/adapters.js";
import type { AttemptLogStore } from "./attemptLog.js";
import type { CommandRunner } from "./commandRunner.js";
import type { OrchestratorConfig } from "./env.js";
import type { FileSystemPort } from "./fileSystem.js";
import { activeProject } from "../project/projectConfig.js";
import { LocalTrackerClient, localIssueStore, type TrackerClient } from "../tracker/index.js";
import { RealGhClient } from "./ghClient.js";
import { RealGitOps } from "./gitOps.js";
import type { SandcastleLayout } from "./paths.js";
import type { RunContext } from "./runContext.js";
import { DockerSandboxRunner } from "./sandboxRunner.js";

export interface StageCompletionSink {
  handleStageCompletion(completion: StageCompletion): void;
}

export interface RealAdaptersDeps {
  logs?: AttemptLogStore | undefined;
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  config: OrchestratorConfig;
  context: RunContext;
  log?: (message: string) => void;
  ui?: UiSink;
}

export interface RealAdapterBundle {
  adapters: Adapters;
  gh: TrackerClient;
  git: RealGitOps;
  sandbox: DockerSandboxRunner;
  attach(engine: StageCompletionSink): void;
}

export function consoleUi(log: (message: string) => void): UiSink {
  return {
    warn: (itemNumber, message) => log(`[warn] #${itemNumber} ${message}`),
    note: (itemNumber, message) => log(itemNumber === undefined ? `[note] ${message}` : `[note] #${itemNumber} ${message}`),
  };
}

function createTrackerClient(deps: RealAdaptersDeps, log: (message: string) => void, ui: UiSink): TrackerClient {
  const locate = (itemNumber: number) => deps.context.locate(itemNumber);
  const project = activeProject();
  if (project.tracker === "local") {
    return new LocalTrackerClient({
      runner: deps.runner,
      fs: deps.fs,
      layout: deps.layout,
      store: localIssueStore(project),
      locate,
      itemOfBranch: (repo, branch) =>
        deps.context.runModel().items.find((item) => item.repo === repo && locate(item.number).branch === branch)?.number,
      log,
    });
  }
  return new RealGhClient({ runner: deps.runner, hubRepo: deps.config.hubRepo, locate, log, warn: ui.warn });
}

export function createRealAdapters(deps: RealAdaptersDeps): RealAdapterBundle {
  const log = deps.log ?? ((message: string) => console.log(message));
  const ui = deps.ui ?? consoleUi(log);

  let engine: StageCompletionSink | undefined;
  const onComplete = (completion: StageCompletion): void => {
    if (!engine) throw new Error("stage completed before the engine was attached — call attach(engine) right after construction");
    engine.handleStageCompletion(completion);
  };

  const gh = createTrackerClient(deps, log, ui);

  const git = new RealGitOps({ runner: deps.runner, fs: deps.fs, layout: deps.layout, log });

  const sandbox = new DockerSandboxRunner({
    runner: deps.runner,
    fs: deps.fs,
    layout: deps.layout,
    config: deps.config,
    gh,
    context: deps.context,
    log,
    warn: ui.warn,
    onComplete,
    logs: deps.logs,
  });

  const gitOps: GitOps = {
    createIntegrationBranch: (repo, branch) => git.createIntegrationBranch(repo, branch),
    createItemBranch: (repo, branch, baseBranch) => git.createItemBranch(repo, branch, baseBranch),
    syncWithIntegration: (repo, branch, integrationBranch) => git.syncWithIntegration(repo, branch, integrationBranch),
    rebaseOntoIntegration: (repo, branch, integrationBranch) => git.rebaseOntoIntegration(repo, branch, integrationBranch),
    runChecks: (request) => sandbox.runChecks(request),
  };

  return {
    adapters: { gh, sandbox, git: gitOps, ui },
    gh,
    git,
    sandbox,
    attach: (attached) => {
      engine = attached;
    },
  };
}
