import { join } from "node:path";
import type { FileSystemPort } from "./fileSystem.js";

/** Files inside a mounted .git that make the HOST run code: an agent must never change them. */
export const GUARDED_GIT_FILES = ["config", join("info", "attributes")] as const;

/** Host git ignores hooks and fsmonitor, so a hook planted from inside a container never runs on the host. */
export const HOST_GIT_CONFIG: Readonly<Record<string, string>> = {
  "core.hooksPath": "/dev/null",
  "core.fsmonitor": "false",
};

export function hostGitEnv(): Record<string, string> {
  const entries = Object.entries(HOST_GIT_CONFIG);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export class GitControlTampered extends Error {
  constructor(readonly gitDir: string, readonly files: readonly string[]) {
    super(
      `an agent container changed ${files.join(", ")} under ${gitDir} — sandcastle restored the original and refuses the stage. ` +
        "Read the stage transcript before resuming this item.",
    );
    this.name = "GitControlTampered";
  }
}

export interface GitControlSnapshot {
  gitDir: string;
  files: ReadonlyMap<string, string | undefined>;
  /** The one branch whose tracking config the stage may write; undefined allows none. */
  ownBranch: string | undefined;
  /** Branches of every stage started on this git dir; concurrent stages write each other's tracking config. */
  stageBranches: ReadonlySet<string>;
}

const stageBranchesByGitDir = new Map<string, Set<string>>();

export function snapshotGitControl(fs: FileSystemPort, gitDir: string, ownBranch?: string): GitControlSnapshot {
  const stageBranches = stageBranchesByGitDir.get(gitDir) ?? new Set<string>();
  stageBranchesByGitDir.set(gitDir, stageBranches);
  if (ownBranch !== undefined) stageBranches.add(ownBranch);
  return { gitDir, ownBranch, stageBranches, files: new Map(GUARDED_GIT_FILES.map((file) => [file, fs.readText(join(gitDir, file))])) };
}

const BARE_KEY_IMPLICIT_TRUE = null;
type GitDecodedValueOrBareKey = string | typeof BARE_KEY_IMPLICIT_TRUE;

interface ConfigEntry {
  section: string;
  subsection: string | undefined;
  key: string;
  value: GitDecodedValueOrBareKey;
}

const GIT_ASCII_ISSPACE = String.raw`[ \t\v\f\r]`;
const KEY_EQUALS_PADDING = String.raw`[ \t]`;
const SECTION_HEADER = new RegExp(
  String.raw`^${GIT_ASCII_ISSPACE}*\[([A-Za-z0-9.-]+)(?:${GIT_ASCII_ISSPACE}+"((?:[^"\\]|\\.)*)")?\](.*)$`,
);
const KEY_LINE = new RegExp(String.raw`^${GIT_ASCII_ISSPACE}*([A-Za-z][A-Za-z0-9-]*)${KEY_EQUALS_PADDING}*(?:=(.*))?$`);
const COMMENT_OR_BLANK = new RegExp(String.raw`^${GIT_ASCII_ISSPACE}*(?:[#;].*)?$`);
const VALUE_ESCAPES: Readonly<Partial<Record<string, string>>> = { t: "\t", b: "\b", n: "\n", "\\": "\\", '"': '"' };

function stripLeadingBom(text: string): string {
  return text.replace(/^﻿/, "");
}

function isCollapsibleValueWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r";
}

function startsValueComment(char: string): boolean {
  return char === "#" || char === ";";
}

function decodeLikeGitParseValueOrUndefined(raw: string): string | undefined {
  let decoded = "";
  let quoted = false;
  let pendingSpaces = 0;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (!quoted && isCollapsibleValueWhitespace(char)) {
      if (decoded.length > 0) pendingSpaces++;
      continue;
    }
    if (!quoted && startsValueComment(char)) break;
    decoded += " ".repeat(pendingSpaces);
    pendingSpaces = 0;
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const escaped = VALUE_ESCAPES[raw[++index] ?? ""];
    if (escaped === undefined) return undefined;
    decoded += escaped;
  }
  return quoted ? undefined : decoded;
}

function parsePlainGitConfigOrUndefined(text: string): ConfigEntry[] | undefined {
  const entries: ConfigEntry[] = [];
  let section: string | undefined;
  let subsection: string | undefined;
  for (const line of stripLeadingBom(text).split(/\r?\n/)) {
    if (line.endsWith("\\")) return undefined;
    let rest = line;
    const header = SECTION_HEADER.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      subsection = header[2]?.replace(/\\(.)/g, "$1");
      rest = header[3]!;
    }
    if (COMMENT_OR_BLANK.test(rest)) continue;
    const keyLine = KEY_LINE.exec(rest);
    if (!keyLine || section === undefined) return undefined;
    const raw = keyLine[2];
    const value = raw === undefined ? BARE_KEY_IMPLICIT_TRUE : decodeLikeGitParseValueOrUndefined(raw);
    if (value === undefined) return undefined;
    entries.push({ section, subsection, key: keyLine[1]!.toLowerCase(), value });
  }
  return entries;
}

const GH_PR_CREATE_REMOTE_KEY = "gh-resolved";
const REMOTE_NAMING_BRANCH_KEYS = new Set(["remote", "pushremote"]);
const OWN_BRANCH_KEYS_WRITTEN_BY_PUSH_U_GH_PR_AND_BRANCH_TRACK = new Set([
  ...REMOTE_NAMING_BRANCH_KEYS,
  "merge",
  "rebase",
  "description",
  "gh-merge-base",
]);

function remoteNamesWithUrlSafeToName(entries: readonly ConfigEntry[]): ReadonlySet<string> {
  return new Set(
    entries.flatMap((entry) =>
      entry.section === "remote" && entry.subsection !== undefined && entry.key === "url" && entry.value ? [entry.subsection] : [],
    ),
  );
}

function isStageBranchBookkeeping(
  entry: ConfigEntry,
  stageBranches: ReadonlySet<string>,
  remotesSafeToName: ReadonlySet<string>,
): boolean {
  if (entry.subsection === undefined) return false;
  if (entry.section === "remote") return entry.key === GH_PR_CREATE_REMOTE_KEY && remotesSafeToName.has(entry.subsection);
  if (entry.section !== "branch" || !stageBranches.has(entry.subsection)) return false;
  if (!OWN_BRANCH_KEYS_WRITTEN_BY_PUSH_U_GH_PR_AND_BRANCH_TRACK.has(entry.key)) return false;
  return (
    !REMOTE_NAMING_BRANCH_KEYS.has(entry.key) || (entry.value !== BARE_KEY_IMPLICIT_TRUE && remotesSafeToName.has(entry.value))
  );
}

function configChangeIsOnlyStageBranchBookkeeping(
  before: string | undefined,
  after: string | undefined,
  stageBranches: ReadonlySet<string>,
): boolean {
  if (after === undefined) return false;
  const beforeEntries = parsePlainGitConfigOrUndefined(before ?? "");
  const afterEntries = parsePlainGitConfigOrUndefined(after);
  if (!beforeEntries || !afterEntries) return false;
  const remotesSafeToName = remoteNamesWithUrlSafeToName(beforeEntries);
  const guardedFingerprint = (entries: readonly ConfigEntry[]): string =>
    JSON.stringify(entries.filter((entry) => !isStageBranchBookkeeping(entry, stageBranches, remotesSafeToName)));
  return guardedFingerprint(beforeEntries) === guardedFingerprint(afterEntries);
}

/** Restores every guarded file a container tampered with, then throws so the stage parks instead of merging. */
export function assertGitControlUnchanged(fs: FileSystemPort, snapshot: GitControlSnapshot): void {
  const changed: string[] = [];
  for (const [file, before] of snapshot.files) {
    const path = join(snapshot.gitDir, file);
    const after = fs.readText(path);
    if (after === before) continue;
    if (file === "config" && configChangeIsOnlyStageBranchBookkeeping(before, after, snapshot.stageBranches)) continue;
    changed.push(file);
    if (before === undefined) fs.removeFile(path);
    else fs.writeText(path, before);
  }
  if (changed.length > 0) throw new GitControlTampered(snapshot.gitDir, changed);
}
