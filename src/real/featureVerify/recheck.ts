import type { TargetRepo } from "../../model/runModel.js";

export const RECHECK_BASE_ENV = "SANDCASTLE_RECHECK_BASE";

const RECHECK_GIT = "git -c user.name=sandcastle -c user.email=sandcastle@localhost -c commit.gpgsign=false";

export interface VerifiedCommit {
  sha: string;
  passed: boolean;
}

export class RecheckLedger {
  private readonly commits = new Map<TargetRepo, VerifiedCommit>();

  last(repo: TargetRepo): VerifiedCommit | undefined {
    return this.commits.get(repo);
  }

  record(repo: TargetRepo, sha: string | undefined, passed: boolean): void {
    if (!sha) {
      this.commits.delete(repo);
      return;
    }
    this.commits.set(repo, { sha, passed });
  }
}

export type VerifyCommandMode =
  | { kind: "full"; reason: string }
  | { kind: "affected"; base: string; head: string; command: string }
  | { kind: "skip"; base: string };

export interface VerifyModeInputs {
  recheck: string | undefined;
  last: VerifiedCommit | undefined;
  head: string | undefined;
  changedSince: (base: string) => string | undefined;
}

export function selectVerifyMode(inputs: VerifyModeInputs): VerifyCommandMode {
  const { recheck, last, head } = inputs;
  if (!recheck) return { kind: "full", reason: "no verify.recheck for it" };
  if (!last) return { kind: "full", reason: "first verify of this run" };
  if (!last.passed) return { kind: "full", reason: "it was red last round" };
  if (!head) return { kind: "full", reason: "its integration head is unknown" };
  if (head === last.sha) return { kind: "skip", base: last.sha };
  const changed = inputs.changedSince(last.sha);
  if (changed === undefined) return { kind: "full", reason: `last verified ${shortSha(last.sha)} is not reachable` };
  if (changed.trim().length === 0) return { kind: "skip", base: last.sha };
  return { kind: "affected", base: last.sha, head, command: recheck };
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function modeLabel(repo: TargetRepo, mode: VerifyCommandMode): string {
  if (mode.kind === "affected") return `${repo} verify command (affected since ${shortSha(mode.base)})`;
  if (mode.kind === "skip") return `${repo} verify command skipped (unchanged since ${shortSha(mode.base)}, green last round)`;
  return `${repo} verify command (full: ${mode.reason})`;
}

export function rawArchiveArgs(rev: string, outputPath: string): string[] {
  return ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", "-o", outputPath, rev];
}

function commitTree(archivePath: string, message: string): string[] {
  return [
    "find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +",
    `tar -xf ${archivePath}`,
    "git add -A -f",
    `${RECHECK_GIT} commit -q --no-verify --allow-empty -m "${message}"`,
  ];
}

export function seedRecheckHistoryCommand(sourcePath: string, baseArchive: string, headArchive: string): string {
  return [
    `rm -rf ${sourcePath}`,
    `mkdir -p ${sourcePath}`,
    `cd ${sourcePath}`,
    "git init -q",
    "git config core.autocrlf false",
    ...commitTree(baseArchive, "sandcastle recheck base"),
    ...commitTree(headArchive, "sandcastle recheck head"),
  ].join(" && ");
}

export function withRecheckBase(command: string): string {
  return `export ${RECHECK_BASE_ENV}="$(git rev-parse HEAD~1)" && ${command}`;
}
