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

/** Restores every guarded file a container touched, then throws so the stage parks instead of merging. */
export function assertGitControlUnchanged(fs: FileSystemPort, snapshot: GitControlSnapshot): void {
  const changed: string[] = [];
  for (const [file, before] of snapshot.files) {
    const path = join(snapshot.gitDir, file);
    if (fs.readText(path) === before) continue;
    changed.push(file);
    if (before === undefined) fs.removeFile(path);
    else fs.writeText(path, before);
  }
  if (changed.length > 0) throw new GitControlTampered(snapshot.gitDir, changed);
}
