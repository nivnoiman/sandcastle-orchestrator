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
}

export function snapshotGitControl(fs: FileSystemPort, gitDir: string): GitControlSnapshot {
  return { gitDir, files: new Map(GUARDED_GIT_FILES.map((file) => [file, fs.readText(join(gitDir, file))])) };
}

interface ConfigEntry {
  section: string;
  subsection: string | undefined;
  key: string;
  value: string;
}

// Mirrors git's config.c so nothing git rejects parses here: isspace() is ASCII-only (JS \s is not), only
// space/tab may sit between a key and '=', and the closing quote of a subsection must touch ']'.
const SECTION_HEADER = /^[ \t\v\f\r]*\[([A-Za-z0-9.-]+)(?:[ \t\v\f\r]+"((?:[^"\\]|\\.)*)")?\](.*)$/;
const KEY_LINE = /^[ \t\v\f\r]*([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=(.*))?$/;
const COMMENT_OR_BLANK = /^[ \t\v\f\r]*(?:[#;].*)?$/;
const VALUE_ESCAPES = new Set(["t", "b", "n", "\\", '"']);

/** Mirrors git's parse_value: an unknown escape or an unclosed quote makes git refuse the whole file. */
function isValidValue(raw: string): boolean {
  let quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (!quoted && (char === "#" || char === ";")) return true;
    if (char === '"') quoted = !quoted;
    else if (char === "\\" && !VALUE_ESCAPES.has(raw[++index] ?? "")) return false;
  }
  return !quoted;
}

/**
 * Parses the plain subset of git config syntax into entries; values stay raw. Returns undefined for
 * anything else (line continuations, malformed lines, syntax git itself rejects) so the caller treats
 * any change as tampering.
 */
function parseGitConfig(text: string): ConfigEntry[] | undefined {
  const entries: ConfigEntry[] = [];
  let section: string | undefined;
  let subsection: string | undefined;
  // git skips a UTF-8 BOM only at the very start of the file.
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
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
    const value = keyLine[2] ?? "";
    if (!isValidValue(value)) return undefined;
    entries.push({ section, subsection, key: keyLine[1]!.toLowerCase(), value: value.trim() });
  }
  return entries;
}

/** What `git push -u` and `gh pr create` write: branch tracking (`branch.<name>.*`) and `remote.<name>.gh-resolved`. */
function isBranchBookkeeping(entry: ConfigEntry): boolean {
  if (entry.subsection === undefined) return false;
  return entry.section === "branch" || (entry.section === "remote" && entry.key === "gh-resolved");
}

/** Comparable form of every non-bookkeeping entry; undefined when the config is unparseable. */
function guardedConfigFingerprint(text: string | undefined): string | undefined {
  const entries = parseGitConfig(text ?? "");
  return entries && JSON.stringify(entries.filter((entry) => !isBranchBookkeeping(entry)));
}

/** A config change confined to branch bookkeeping is harmless; any other change, or an unparseable file, is tampering. */
function configChangeAllowed(before: string | undefined, after: string | undefined): boolean {
  if (after === undefined) return false;
  const guardedBefore = guardedConfigFingerprint(before);
  return guardedBefore !== undefined && guardedBefore === guardedConfigFingerprint(after);
}

/** Restores every guarded file a container tampered with, then throws so the stage parks instead of merging. */
export function assertGitControlUnchanged(fs: FileSystemPort, snapshot: GitControlSnapshot): void {
  const changed: string[] = [];
  for (const [file, before] of snapshot.files) {
    const path = join(snapshot.gitDir, file);
    const after = fs.readText(path);
    if (after === before) continue;
    if (file === "config" && configChangeAllowed(before, after)) continue;
    changed.push(file);
    if (before === undefined) fs.removeFile(path);
    else fs.writeText(path, before);
  }
  if (changed.length > 0) throw new GitControlTampered(snapshot.gitDir, changed);
}
