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

const SECTION_HEADER = /^\s*\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/;
const KEY_LINE = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/;
const COMMENT_OR_BLANK = /^\s*(?:[#;].*)?$/;

/**
 * Parses the plain subset of git config syntax into entries; values stay raw. Returns undefined for
 * anything else (line continuations, malformed lines) so the caller treats any change as tampering.
 */
function parseGitConfig(text: string): ConfigEntry[] | undefined {
  const entries: ConfigEntry[] = [];
  let section: string | undefined;
  let subsection: string | undefined;
  for (const line of text.split(/\r?\n/)) {
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
    entries.push({ section, subsection, key: keyLine[1]!.toLowerCase(), value: (keyLine[2] ?? "").trim() });
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
