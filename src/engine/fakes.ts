import type { TargetRepo } from "../model/runModel.js";
import type {
  Adapters,
  GhClient,
  GitOps,
  SandboxRunner,
  SpawnRequest,
  StageName,
  UiSink,
} from "./adapters.js";
import { RebaseConflictError } from "./adapters.js";

export interface PendingStage {
  itemNumber: number;
  stage: StageName;
}

export interface ClosedIssue {
  itemNumber: number;
  mergedPullRequestUrl: string;
}

export function fakePullRequestUrl(itemNumber: number): string {
  return `https://example.invalid/pull/${itemNumber}`;
}

export class RecordingAdapters implements Adapters {
  readonly log: string[] = [];
  readonly pending: PendingStage[] = [];
  readonly spawned: SpawnRequest[] = [];
  readonly warnings: string[] = [];
  readonly notes: string[] = [];
  readonly comments: { itemNumber: number; body: string }[] = [];
  readonly closed: ClosedIssue[] = [];
  readonly killed: number[] = [];
  failRebase: ((repo: TargetRepo, branch: string) => Error | undefined) | undefined;
  failSync: ((repo: TargetRepo, branch: string) => Error | undefined) | undefined;
  failCreateItemBranch: ((repo: TargetRepo, branch: string) => Error | undefined) | undefined;
  failSpawn: ((itemNumber: number, stage: StageName) => Error | undefined) | undefined;
  failComment: ((itemNumber: number) => Error | undefined) | undefined;
  failMerge: ((itemNumber: number) => Error | undefined) | undefined;
  failClose: ((itemNumber: number) => Error | undefined) | undefined;

  constructor(
    private readonly forwardWarnings?: UiSink,
    private readonly onKill?: (itemNumber: number) => void,
  ) {}

  readonly gh: GhClient = {
    setStageLabel: (itemNumber, label) => {
      this.log.push(`label #${itemNumber} ${label}`);
    },
    addLabel: (itemNumber, label) => {
      this.log.push(`add-label #${itemNumber} ${label}`);
    },
    removeLabel: (itemNumber, label) => {
      this.log.push(`remove-label #${itemNumber} ${label}`);
    },
    swapLabels: (itemNumber, removeLabel, addLabel) => {
      this.log.push(`swap-labels #${itemNumber} ${removeLabel}→${addLabel}`);
    },
    comment: (itemNumber, body) => {
      const failure = this.failComment?.(itemNumber);
      if (failure) throw failure;
      this.log.push(`comment #${itemNumber} "${body}"`);
      this.comments.push({ itemNumber, body });
    },
    mergePullRequest: (itemNumber) => {
      const failure = this.failMerge?.(itemNumber);
      if (failure) throw failure;
      this.log.push(`merge-pr #${itemNumber}`);
      return { url: fakePullRequestUrl(itemNumber) };
    },
    closeIssue: (itemNumber, mergedPullRequestUrl) => {
      const failure = this.failClose?.(itemNumber);
      if (failure) throw failure;
      this.log.push(`close #${itemNumber}`);
      this.closed.push({ itemNumber, mergedPullRequestUrl });
    },
  };

  readonly ui: UiSink = {
    warn: (itemNumber, message) => {
      this.log.push(`warn #${itemNumber} "${message}"`);
      this.warnings.push(`#${itemNumber} ${message}`);
      this.forwardWarnings?.warn(itemNumber, message);
    },
    note: (itemNumber, message) => {
      this.log.push(`note #${itemNumber ?? "run"} "${message}"`);
      this.notes.push(`#${itemNumber ?? "run"} ${message}`);
      this.forwardWarnings?.note(itemNumber, message);
    },
  };

  readonly sandbox: SandboxRunner = {
    spawnStage: (request) => {
      const failure = this.failSpawn?.(request.itemNumber, request.stage);
      if (failure) throw failure;
      this.log.push(`spawn ${request.stage} #${request.itemNumber} [${request.repo}] ${request.branch}`);
      this.pending.push({ itemNumber: request.itemNumber, stage: request.stage });
      this.spawned.push(request);
    },
    spawnResolve: (request) => {
      const failure = this.failSpawn?.(request.itemNumber, "verify");
      if (failure) throw failure;
      this.log.push(`spawn resolve #${request.itemNumber} [${request.repo}] ${request.files.join(", ")}`);
      this.pending.push({ itemNumber: request.itemNumber, stage: "verify" });
    },
    kill: (itemNumber) => {
      this.log.push(`kill #${itemNumber}`);
      this.killed.push(itemNumber);
      this.dropPending(itemNumber);
      this.onKill?.(itemNumber);
    },
  };

  readonly git: GitOps = {
    createIntegrationBranch: (repo, branch) => {
      this.log.push(`git create-branch [${repo}] ${branch} from dev`);
    },
    createItemBranch: (repo, branch, baseBranch) => {
      const failure = this.failCreateItemBranch?.(repo, branch);
      if (failure) throw failure;
      this.log.push(`git create-branch [${repo}] ${branch} from ${baseBranch}`);
    },
    syncWithIntegration: (repo, branch, integrationBranch) => {
      this.log.push(`git sync [${repo}] ${branch} onto ${integrationBranch}`);
      const failure = this.failSync?.(repo, branch);
      if (!failure) return [];
      if (failure instanceof RebaseConflictError) return [...failure.files];
      throw failure;
    },
    rebaseOntoIntegration: (repo, branch, integrationBranch) => {
      this.log.push(`git rebase [${repo}] ${branch} onto ${integrationBranch}`);
      const failure = this.failRebase?.(repo, branch);
      if (failure) throw failure;
    },
    runChecks: (request) => {
      this.log.push(`git check [${request.repo}] ${request.branch}`);
      this.pending.push({ itemNumber: request.itemNumber, stage: "verify" });
    },
  };

  dropPending(itemNumber: number): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index]?.itemNumber === itemNumber) this.pending.splice(index, 1);
    }
  }

  takeNextPending(): PendingStage {
    const next = this.pending.shift();
    if (!next) throw new Error("no pending stage to complete");
    return next;
  }
}
