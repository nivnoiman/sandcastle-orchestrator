import { isFixedStageLabel, isStageLabel, type GhClient, type MergedPullRequest, type StageLabel } from "../engine/adapters.js";
import type { TargetRepo } from "../model/runModel.js";
import { integrationBase, repoSlug } from "../project/projectConfig.js";
import type { CommandRunner } from "./commandRunner.js";
import { messageOf } from "../messageOf.js";

export function closingComment(mergedPullRequestUrl: string): string {
  return [
    `Merged into the integration branch: ${mergedPullRequestUrl}`,
    "",
    "sandcastle closes this sub-issue from here because a pull request into an integration branch never auto-closes an issue.",
    `The parent issue stays open until a human merges the integration branch into ${integrationBase()}.`,
  ].join("\n");
}

export function serviceRepoSlug(repo: TargetRepo): string {
  return repoSlug(repo);
}

export function hubIssueUrl(hubRepo: string, itemNumber: number): string {
  return `https://github.com/${hubRepo}/issues/${itemNumber}`;
}

export const PR_JSON_FIELDS = "number,url,state,isDraft,body,title";

export interface PullRequestRef {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  body: string;
  title: string;
}

export interface CreateDraftPrInput {
  repo: TargetRepo;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface PullRequestOps {
  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined;
  createDraftPullRequest(input: CreateDraftPrInput): PullRequestRef;
  appendToPullRequestBody(repo: TargetRepo, pullRequest: PullRequestRef, addition: string): void;
}

export interface FeatureVerifyPullRequests {
  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined;
  createPullRequest(input: CreateDraftPrInput): PullRequestRef;
}

export interface GhClientDeps {
  runner: CommandRunner;
  hubRepo: string;
  locate: (itemNumber: number) => { repo: TargetRepo; branch: string };
  log: (message: string) => void;
  warn: (itemNumber: number, message: string) => void;
}

function parsePullRequest(value: unknown): PullRequestRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const { number, url, state, isDraft, body, title } = candidate;
  if (typeof number !== "number" || typeof url !== "string") return undefined;
  if (typeof body !== "string") {
    throw new Error(
      `gh returned pull request #${number} without a string body — refusing to read a stage section off a body sandcastle cannot see`,
    );
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error(
      `gh returned pull request #${number} without a title — refusing to squash-merge with a subject sandcastle cannot see`,
    );
  }
  return {
    number,
    url,
    state: typeof state === "string" ? state : "UNKNOWN",
    isDraft: isDraft === true,
    body,
    title,
  };
}

function parseCommentBodies(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return [];
  const comments = (parsed as Record<string, unknown>)["comments"];
  if (!Array.isArray(comments)) return [];
  return comments
    .map((comment) => (typeof comment === "object" && comment !== null ? (comment as Record<string, unknown>)["body"] : undefined))
    .filter((body): body is string => typeof body === "string");
}

function parseLabelNames(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return [];
  const labels = (parsed as Record<string, unknown>)["labels"];
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => (typeof label === "object" && label !== null ? (label as Record<string, unknown>)["name"] : undefined))
    .filter((name): name is string => typeof name === "string");
}

const CUSTOM_STAGE_LABEL_COLOR = "5319E7";
const UPSERT_LABEL_FLAG = "--force";

interface PendingLabelWrite {
  description: string;
  write: () => void;
}

export class RealGhClient implements GhClient, PullRequestOps {
  private readonly pendingLabels = new Map<number, PendingLabelWrite[]>();
  private readonly createdLabels = new Set<string>();

  constructor(private readonly deps: GhClientDeps) {}

  setStageLabel(itemNumber: number, label: StageLabel): void {
    this.mirror(itemNumber, `set ${label}`, () => {
      this.ensureCustomLabel(label);
      const stale = this.currentLabels(itemNumber).filter((name) => isStageLabel(name) && name !== label);
      const args = ["issue", "edit", String(itemNumber), "--repo", this.deps.hubRepo, "--add-label", label];
      for (const name of stale) args.push("--remove-label", name);
      this.gh(args);
    });
  }

  addLabel(itemNumber: number, label: string): void {
    this.mirror(itemNumber, `add ${label}`, () => {
      this.gh(["issue", "edit", String(itemNumber), "--repo", this.deps.hubRepo, "--add-label", label]);
    });
  }

  removeLabel(itemNumber: number, label: string): void {
    this.mirror(itemNumber, `remove ${label}`, () => {
      this.gh(["issue", "edit", String(itemNumber), "--repo", this.deps.hubRepo, "--remove-label", label]);
    });
  }

  swapLabels(itemNumber: number, removeLabel: string, addLabel: string): void {
    this.mirror(itemNumber, `swap ${removeLabel} → ${addLabel}`, () => {
      this.gh([
        "issue", "edit", String(itemNumber), "--repo", this.deps.hubRepo,
        "--add-label", addLabel, "--remove-label", removeLabel,
      ]);
    });
  }

  comment(itemNumber: number, body: string): void {
    this.deps.runner.run({
      command: "gh",
      args: ["issue", "comment", String(itemNumber), "--repo", this.deps.hubRepo, "--body-file", "-"],
      input: body,
    });
  }

  mergePullRequest(itemNumber: number): MergedPullRequest {
    const { repo, branch } = this.deps.locate(itemNumber);
    const pullRequest = this.findPullRequest(repo, branch);
    if (!pullRequest) throw new Error(`#${itemNumber}: no pull request for ${branch} on ${serviceRepoSlug(repo)} to merge`);
    const slug = serviceRepoSlug(repo);
    if (pullRequest.isDraft) this.gh(["pr", "ready", String(pullRequest.number), "--repo", slug]);
    this.gh([
      "pr", "merge", String(pullRequest.number), "--repo", slug,
      "--squash", "--subject", pullRequest.title, "--delete-branch",
    ]);
    this.deps.log(`merged ${pullRequest.url}`);
    return { url: pullRequest.url };
  }

  closeIssue(itemNumber: number, mergedPullRequestUrl: string): void {
    this.comment(itemNumber, closingComment(mergedPullRequestUrl));
    this.gh(["issue", "close", String(itemNumber), "--repo", this.deps.hubRepo]);
  }

  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined {
    const base = baseBranch ? ["--base", baseBranch] : [];
    const { stdout } = this.gh([
      "pr", "list", "--repo", serviceRepoSlug(repo), "--head", branch, ...base, "--state", "open",
      "--json", PR_JSON_FIELDS, "--limit", "1",
    ]);
    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    if (!Array.isArray(parsed)) return undefined;
    return parsePullRequest(parsed[0]);
  }

  createDraftPullRequest(input: CreateDraftPrInput): PullRequestRef {
    return this.openPullRequest(input, ["--draft"]);
  }

  createPullRequest(input: CreateDraftPrInput): PullRequestRef {
    return this.openPullRequest(input, []);
  }

  private openPullRequest(input: CreateDraftPrInput, extraArgs: readonly string[]): PullRequestRef {
    this.deps.runner.run({
      command: "gh",
      args: [
        "pr", "create", "--repo", serviceRepoSlug(input.repo), ...extraArgs,
        "--base", input.baseBranch, "--head", input.branch, "--title", input.title, "--body-file", "-",
      ],
      input: input.body,
    });
    const created = this.findPullRequest(input.repo, input.branch, input.baseBranch);
    if (!created) {
      throw new Error(`gh pr create reported success but no open pull request exists for ${input.branch} → ${input.baseBranch}`);
    }
    return created;
  }

  appendToPullRequestBody(repo: TargetRepo, pullRequest: PullRequestRef, addition: string): void {
    this.deps.runner.run({
      command: "gh",
      args: ["pr", "edit", String(pullRequest.number), "--repo", serviceRepoSlug(repo), "--body-file", "-"],
      input: `${pullRequest.body}\n${addition}`,
    });
  }

  commentOnPullRequest(repo: TargetRepo, pullRequest: PullRequestRef, body: string): void {
    this.deps.runner.run({
      command: "gh",
      args: ["pr", "comment", String(pullRequest.number), "--repo", serviceRepoSlug(repo), "--body-file", "-"],
      input: body,
    });
  }

  issueComments(itemNumber: number): string[] {
    const { stdout } = this.gh(["issue", "view", String(itemNumber), "--repo", this.deps.hubRepo, "--json", "comments"]);
    return parseCommentBodies(stdout.trim() || "{}");
  }

  stageLabels(itemNumber: number): StageLabel[] {
    return this.currentLabels(itemNumber).filter(isStageLabel);
  }

  private ensureCustomLabel(label: StageLabel): void {
    if (isFixedStageLabel(label) || this.createdLabels.has(label)) return;
    this.gh([
      "label", "create", label, "--repo", this.deps.hubRepo, UPSERT_LABEL_FLAG,
      "--color", CUSTOM_STAGE_LABEL_COLOR, "--description", `sandcastle custom stage ${label.slice("sc:".length)}`,
    ]);
    this.createdLabels.add(label);
  }

  private currentLabels(itemNumber: number): string[] {
    const { stdout } = this.gh(["issue", "view", String(itemNumber), "--repo", this.deps.hubRepo, "--json", "labels"]);
    return parseLabelNames(stdout.trim() || "{}");
  }

  flushPendingLabels(): void {
    for (const [itemNumber, writes] of [...this.pendingLabels]) {
      while (writes.length > 0) {
        const next = writes[0]!;
        try {
          next.write();
        } catch {
          break;
        }
        writes.shift();
      }
      if (writes.length === 0) {
        this.pendingLabels.delete(itemNumber);
        this.deps.log(`#${itemNumber} label mirror caught up after an earlier failure`);
      }
    }
  }

  private mirror(itemNumber: number, description: string, write: () => void): void {
    const queued = this.pendingLabels.get(itemNumber);
    if (queued) {
      queued.push({ description, write });
      return;
    }
    try {
      write();
    } catch (cause) {
      const reason = messageOf(cause);
      this.pendingLabels.set(itemNumber, [{ description, write }]);
      this.deps.warn(itemNumber, `label mirror failed (${description}), retrying on the next poll: ${reason.slice(0, 200)}`);
    }
  }

  private gh(args: readonly string[]): { stdout: string } {
    return this.deps.runner.run({ command: "gh", args });
  }
}
