import { join, resolve } from "node:path";
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
  constructor(readonly gitDir: string, readonly files: readonly string[], readonly changes: readonly string[] = []) {
    const detail = changes.length > 0 ? ` (${changes.join("; ")})` : "";
    super(
      `an agent container changed ${files.join(", ")}${detail} under ${gitDir} — sandcastle restored the original and refuses the stage. ` +
        "Read the stage transcript before resuming this item.",
    );
    this.name = "GitControlTampered";
  }
}

export interface GitControlSnapshot {
  gitDir: string;
  /** The trusted baseline shared by every stage active on this git dir. */
  files: ReadonlyMap<string, string | undefined>;
}

interface ActiveGitDir {
  baseline: ReadonlyMap<string, string | undefined>;
  active: number;
}

const activeByGitDir = new Map<string, ActiveGitDir>();
const releasedSnapshots = new WeakSet<GitControlSnapshot>();

function registryKey(gitDir: string): string {
  const absolute = resolve(gitDir);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function readGuardedFiles(fs: FileSystemPort, gitDir: string): Map<string, string | undefined> {
  return new Map(GUARDED_GIT_FILES.map((file) => [file, fs.readText(join(gitDir, file))]));
}

/**
 * The first stage on a git dir reads the baseline from disk; stages that start while others run reuse it, so a
 * config a running container already tampered with can never become a later stage's trusted baseline.
 */
export function snapshotGitControl(fs: FileSystemPort, gitDir: string): GitControlSnapshot {
  const key = registryKey(gitDir);
  const current = activeByGitDir.get(key);
  if (current) {
    const drifted = [...current.baseline].filter(([file, trusted]) => !guardedFileUnchanged(fs, gitDir, file, trusted));
    if (drifted.length > 0) throw new GitControlTampered(gitDir, drifted.map(([file]) => file));
  }
  const entry = current ?? { baseline: readGuardedFiles(fs, gitDir), active: 0 };
  entry.active++;
  activeByGitDir.set(key, entry);
  return { gitDir, files: entry.baseline };
}

/** Ends a stage's hold on its git dir; idempotent. The last stage out clears the baseline. */
export function releaseGitControl(snapshot: GitControlSnapshot): void {
  if (releasedSnapshots.has(snapshot)) return;
  releasedSnapshots.add(snapshot);
  const key = registryKey(snapshot.gitDir);
  const entry = activeByGitDir.get(key);
  if (!entry) return;
  entry.active--;
  if (entry.active <= 0) activeByGitDir.delete(key);
}

export function resetGitControlRegistry(): void {
  activeByGitDir.clear();
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
const INERT_BRANCH_KEYS_WRITTEN_BY_GIT_TRACKING = new Set([
  ...REMOTE_NAMING_BRANCH_KEYS,
  "merge",
  "rebase",
  "description",
  "gh-merge-base",
  "vscode-merge-base",
]);

function remoteNamesWithUrlSafeToName(entries: readonly ConfigEntry[]): ReadonlySet<string> {
  return new Set(
    entries.flatMap((entry) =>
      entry.section === "remote" && entry.subsection !== undefined && entry.key === "url" && entry.value ? [entry.subsection] : [],
    ),
  );
}

function isInertBranchBookkeepingFromOtherGitUsers(entry: ConfigEntry, remotesSafeToName: ReadonlySet<string>): boolean {
  if (entry.subsection === undefined) return false;
  if (entry.section === "remote") return entry.key === GH_PR_CREATE_REMOTE_KEY && remotesSafeToName.has(entry.subsection);
  if (entry.section !== "branch") return false;
  if (!INERT_BRANCH_KEYS_WRITTEN_BY_GIT_TRACKING.has(entry.key)) return false;
  return (
    !REMOTE_NAMING_BRANCH_KEYS.has(entry.key) || (entry.value !== BARE_KEY_IMPLICIT_TRUE && remotesSafeToName.has(entry.value))
  );
}

function configChangeIsOnlyInertBookkeeping(before: string | undefined, after: string | undefined): boolean {
  if (after === undefined) return false;
  const beforeEntries = parsePlainGitConfigOrUndefined(before ?? "");
  const afterEntries = parsePlainGitConfigOrUndefined(after);
  if (!beforeEntries || !afterEntries) return false;
  const remotesSafeToName = remoteNamesWithUrlSafeToName(beforeEntries);
  const guardedFingerprint = (entries: readonly ConfigEntry[]): string =>
    JSON.stringify(entries.filter((entry) => !isInertBranchBookkeepingFromOtherGitUsers(entry, remotesSafeToName)));
  return guardedFingerprint(beforeEntries) === guardedFingerprint(afterEntries);
}

function guardedFileUnchanged(fs: FileSystemPort, gitDir: string, file: string, before: string | undefined): boolean {
  const after = fs.readText(join(gitDir, file));
  if (after === before) return true;
  return file === "config" && configChangeIsOnlyInertBookkeeping(before, after);
}

/** Restores every guarded file a container tampered with, then throws so the stage parks instead of merging. Always releases the stage. */
export function assertGitControlUnchanged(fs: FileSystemPort, snapshot: GitControlSnapshot): void {
  const changed: string[] = [];
  const changes: string[] = [];
  for (const [file, before] of snapshot.files) {
    if (guardedFileUnchanged(fs, snapshot.gitDir, file, before)) continue;
    const path = join(snapshot.gitDir, file);
    changed.push(file);
    changes.push(...describeChangedLabelsWithoutValues(file, before, fs.readText(path)));
    if (before === undefined) fs.removeFile(path);
    else fs.writeText(path, before);
  }
  releaseGitControl(snapshot);
  if (changed.length > 0) throw new GitControlTampered(snapshot.gitDir, changed, changes);
}

function describeChangedLabelsWithoutValues(file: string, before: string | undefined, after: string | undefined): string[] {
  const labelOf = (line: string): string => {
    const header = /^\s*\[([A-Za-z0-9.-]+)/.exec(line);
    if (header) return `[${header[1]}]`;
    return /^\s*([A-Za-z][A-Za-z0-9-]*)/.exec(line)?.[1] ?? "?";
  };
  const lines = (text: string | undefined): string[] => (text ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
  const beforeLines = new Set(lines(before));
  const afterLines = new Set(lines(after));
  const added = lines(after).filter((line) => !beforeLines.has(line));
  const removed = lines(before).filter((line) => !afterLines.has(line));
  return [...added.map((line) => `${file} +${labelOf(line)}`), ...removed.map((line) => `${file} -${labelOf(line)}`)].slice(0, 12);
}
