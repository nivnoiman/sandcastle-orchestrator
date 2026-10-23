import { join } from "node:path";
import type { TargetRepo } from "../../../src/model/runModel.js";
import type { VerifyWorktrees } from "../../../src/real/gitOps.js";
import { WORKTREES_DIR } from "../support.js";

export const VERIFY_SLUG = "verify-integration-toy-demo";

export function verifyWorktree(repo: TargetRepo): string {
  return join(WORKTREES_DIR, repo, VERIFY_SLUG);
}

export class FakeWorktrees implements VerifyWorktrees {
  readonly created: { repo: TargetRepo; ref: string; slug: string }[] = [];
  readonly dropped: { repo: TargetRepo; target: string }[] = [];
  missingIntegration = new Set<TargetRepo>();
  createFailure: Error | undefined;

  createDetachedWorktree(repo: TargetRepo, ref: string, slug: string): string {
    if (this.createFailure) throw this.createFailure;
    this.created.push({ repo, ref, slug });
    return verifyWorktree(repo);
  }

  dropWorktree(repo: TargetRepo, target: string): void {
    this.dropped.push({ repo, target });
  }

  remoteRefExists(repo: TargetRepo): boolean {
    return !this.missingIntegration.has(repo);
  }
}
