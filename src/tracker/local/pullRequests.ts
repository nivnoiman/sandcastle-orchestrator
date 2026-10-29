import { dirname, join } from "node:path";
import type { MergedPullRequest } from "../../engine/adapters.js";
import type { TargetRepo } from "../../model/runModel.js";
import type { CommandRunner } from "../../real/commandRunner.js";
import type { FileSystemPort } from "../../real/fileSystem.js";
import { removeWorktreeTree } from "../../real/gitOps.js";
import { repoRoot, sanitizeBranch, worktreePath, type SandcastleLayout } from "../../real/paths.js";
import { hasPrSection, needsReworkStory, unfixableReason } from "../../real/stageAudit.js";
import { messageOf } from "../../messageOf.js";
import type { CreateDraftPrInput, PullRequestRef, PullRequestSeam } from "../types.js";
import type { LocalIssueStore } from "./store.js";

export const LOCAL_PRS_FOLDER = "local-prs";
/** Agents append their stage sections here, at the root of their worktree; the seam reads them as part of the pull-request body. */
export const LOCAL_PR_NOTES_FILE = ".sandcastle-pr.md";

const URL_PREFIX = "local-pr://";
const COUNTER_FILE = "counter";
const MAX_REVIEW_ROUNDS = 20;
const FALLBACK_IDENTITY = ["-c", "user.name=sandcastle", "-c", "user.email=sandcastle@localhost"];

interface LocalPrRecord {
  number: number;
  url: string;
  state: "OPEN" | "MERGED";
  isDraft: boolean;
  title: string;
  body: string;
  branch: string;
  baseBranch: string;
}

export interface LocalPullRequestDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  store: LocalIssueStore;
  locate: (itemNumber: number) => { repo: TargetRepo; branch: string };
  itemOfBranch: (repo: TargetRepo, branch: string) => number | undefined;
  log: (message: string) => void;
}

/** The review stage's latest recorded verdict in a pull-request body, e.g. "approved (round 1)". */
export function reviewVerdict(body: string): string | undefined {
  let latest: number | undefined;
  for (let round = 0; round <= MAX_REVIEW_ROUNDS; round += 1) {
    if (hasPrSection(body, "review", round)) latest = round;
  }
  if (latest === undefined) return undefined;
  if (unfixableReason(body, "review", latest) !== undefined) return `unfixable (round ${latest})`;
  if (needsReworkStory(body, latest, "review") !== undefined) return `needs-rework (round ${latest})`;
  return `approved (round ${latest})`;
}

/** Pull requests without a forge: records under `.sandcastle/local-prs/`, and a merge that is `git merge --squash` into the integration branch. */
export class LocalPullRequests implements PullRequestSeam {
  constructor(private readonly deps: LocalPullRequestDeps) {}

  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined {
    const record = this.read(repo, branch);
    if (!record || record.state !== "OPEN") return undefined;
    if (baseBranch !== undefined && record.baseBranch !== baseBranch) return undefined;
    return this.toRef(repo, record);
  }

  createDraftPullRequest(input: CreateDraftPrInput): PullRequestRef {
    return this.create(input, true);
  }

  createPullRequest(input: CreateDraftPrInput): PullRequestRef {
    return this.create(input, false);
  }

  appendToPullRequestBody(repo: TargetRepo, pullRequest: PullRequestRef, addition: string): void {
    const record = this.recordOf(repo, pullRequest);
    record.body = `${record.body}\n${addition}`;
    this.write(repo, record);
    this.recordReview(repo, record.branch, this.fullBody(repo, record));
  }

  commentOnPullRequest(repo: TargetRepo, pullRequest: PullRequestRef, body: string): void {
    this.appendToPullRequestBody(repo, pullRequest, `### Comment\n${body}`);
  }

  mergePullRequest(itemNumber: number): MergedPullRequest {
    const { repo, branch } = this.deps.locate(itemNumber);
    const record = this.read(repo, branch);
    if (!record || record.state !== "OPEN") throw new Error(`#${itemNumber}: no open local pull request for ${branch} in ${repo} to merge`);
    this.recordReview(repo, branch, this.fullBody(repo, record));
    const sha = this.squashMerge(repo, record);
    this.write(repo, { ...record, state: "MERGED", isDraft: false });
    this.deps.store.updateIssue(itemNumber, "merged", sha);
    this.deps.log(`merged ${record.url} (${sha.slice(0, 9)})`);
    return { url: record.url };
  }

  private squashMerge(repo: TargetRepo, record: LocalPrRecord): string {
    const { runner, fs, layout } = this.deps;
    const cwd = repoRoot(layout, repo);
    const target = worktreePath(layout, repo, `merge-${record.branch}`);
    const git = (where: string, args: readonly string[]) => runner.run({ command: "git", args, cwd: where }).stdout;
    git(cwd, ["fetch", "origin", "--prune"]);
    if (fs.exists(target)) removeWorktreeTree({ runner, fs }, cwd, target);
    fs.makeDirectory(dirname(target));
    git(cwd, ["worktree", "add", "--force", "--detach", target, `origin/${record.baseBranch}`]);
    try {
      try {
        git(target, ["merge", "--squash", `origin/${record.branch}`]);
      } catch (cause) {
        throw new Error(`${record.branch} does not squash-merge cleanly into ${record.baseBranch}: ${messageOf(cause)}`);
      }
      if (git(target, ["status", "--porcelain"]).trim().length > 0) {
        git(target, [...this.identity(target), "commit", "--no-verify", "-m", record.title]);
      }
      const sha = git(target, ["rev-parse", "HEAD"]).trim();
      git(target, ["push", "origin", `HEAD:refs/heads/${record.baseBranch}`]);
      this.deleteRemoteBranch(target, record.branch);
      return sha;
    } finally {
      removeWorktreeTree({ runner, fs }, cwd, target);
    }
  }

  private identity(cwd: string): string[] {
    try {
      const email = this.deps.runner.run({ command: "git", args: ["config", "user.email"], cwd }).stdout.trim();
      return email.length > 0 ? [] : FALLBACK_IDENTITY;
    } catch {
      return FALLBACK_IDENTITY;
    }
  }

  private deleteRemoteBranch(cwd: string, branch: string): void {
    try {
      this.deps.runner.run({ command: "git", args: ["push", "origin", "--delete", branch], cwd });
    } catch (cause) {
      this.deps.log(`[warn] merged, but could not delete origin/${branch}: ${messageOf(cause)}`);
    }
  }

  private recordReview(repo: TargetRepo, branch: string, body: string): void {
    const verdict = reviewVerdict(body);
    const itemNumber = this.deps.itemOfBranch(repo, branch);
    if (verdict === undefined || itemNumber === undefined) return;
    this.deps.store.updateIssue(itemNumber, "review", verdict);
  }

  private create(input: CreateDraftPrInput, isDraft: boolean): PullRequestRef {
    const existing = this.read(input.repo, input.branch);
    const record: LocalPrRecord = {
      number: existing?.number ?? this.nextNumber(input.repo),
      url: `${URL_PREFIX}${input.repo}/${input.branch}`,
      state: "OPEN",
      isDraft,
      title: input.title,
      body: input.body,
      branch: input.branch,
      baseBranch: input.baseBranch,
    };
    this.write(input.repo, record);
    return this.toRef(input.repo, record);
  }

  private recordOf(repo: TargetRepo, pullRequest: PullRequestRef): LocalPrRecord {
    const branch = pullRequest.url.slice(`${URL_PREFIX}${repo}/`.length);
    const found = pullRequest.url.startsWith(URL_PREFIX) ? this.read(repo, branch) : undefined;
    if (!found) throw new Error(`no local pull request ${pullRequest.url} in ${repo}`);
    return found;
  }

  private toRef(repo: TargetRepo, record: LocalPrRecord): PullRequestRef {
    return {
      number: record.number,
      url: record.url,
      state: record.state,
      isDraft: record.isDraft,
      title: record.title,
      body: this.fullBody(repo, record),
    };
  }

  private fullBody(repo: TargetRepo, record: LocalPrRecord): string {
    const notes = this.deps.fs.readText(join(worktreePath(this.deps.layout, repo, record.branch), LOCAL_PR_NOTES_FILE));
    return notes ? `${record.body}\n${notes}` : record.body;
  }

  private dir(repo: TargetRepo): string {
    return join(this.deps.layout.sandcastleDir, LOCAL_PRS_FOLDER, repo);
  }

  private file(repo: TargetRepo, branch: string): string {
    return join(this.dir(repo), `${sanitizeBranch(branch)}.json`);
  }

  private read(repo: TargetRepo, branch: string): LocalPrRecord | undefined {
    const text = this.deps.fs.readText(this.file(repo, branch));
    return text === undefined ? undefined : (JSON.parse(text) as LocalPrRecord);
  }

  private write(repo: TargetRepo, record: LocalPrRecord): void {
    this.deps.fs.makeDirectory(this.dir(repo));
    this.deps.fs.writeText(this.file(repo, record.branch), `${JSON.stringify(record, null, 2)}\n`);
  }

  private nextNumber(repo: TargetRepo): number {
    const counter = join(this.dir(repo), COUNTER_FILE);
    const next = Number(this.deps.fs.readText(counter) ?? "0") + 1;
    this.deps.fs.makeDirectory(this.dir(repo));
    this.deps.fs.writeText(counter, String(next));
    return next;
  }
}
