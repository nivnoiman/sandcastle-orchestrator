import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VENDOR_REPO = "https://github.com/mattpocock/skills.git";
export const VENDORED_SKILLS = ["tdd", "to-spec", "to-tickets"] as const;
const UPSTREAM_SKILLS_PATH = ["skills", "engineering"];
const VENDOR_OWNER_DIR = ["skills", "vendor", "mattpocock"];

function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function sourceFileContent(commit: string): string {
  return [
    `repo: ${VENDOR_REPO.replace(/\.git$/, "")}`,
    `commit: ${commit}`,
    `path: ${UPSTREAM_SKILLS_PATH.join("/")}/{${VENDORED_SKILLS.join(",")}}`,
    "license: MIT (see LICENSE)",
    "refresh: sandcastle skills update-vendor",
    "",
  ].join("\n");
}

/** Re-vendors the skills from upstream HEAD (or `ref`) and rewrites SOURCE. Returns the new commit. */
export function updateVendor(sourceRoot: string, ref?: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "sandcastle-vendor-"));
  try {
    git(["clone", "--quiet", ...(ref === undefined ? ["--depth", "1"] : []), VENDOR_REPO, scratch]);
    if (ref !== undefined) git(["checkout", "--quiet", ref], scratch);
    const commit = git(["rev-parse", "HEAD"], scratch);
    const target = join(sourceRoot, ...VENDOR_OWNER_DIR);
    for (const skill of VENDORED_SKILLS) {
      const upstream = join(scratch, ...UPSTREAM_SKILLS_PATH, skill);
      if (!existsSync(upstream)) throw new Error(`${skill} no longer exists at ${UPSTREAM_SKILLS_PATH.join("/")} upstream`);
      rmSync(join(target, skill), { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(upstream, join(target, skill), { recursive: true });
    }
    cpSync(join(scratch, "LICENSE"), join(target, "LICENSE"));
    writeFileSync(join(target, "SOURCE"), sourceFileContent(commit));
    return commit;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
