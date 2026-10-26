import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VENDOR_REPO = "https://github.com/mattpocock/skills.git";
export const VENDORED_SKILLS = ["tdd", "to-spec", "to-tickets"] as const;
const UPSTREAM_SKILLS_PATH = ["skills", "engineering"];
const VENDOR_OWNER_DIR = ["skills", "vendor", "mattpocock"];

/** Rewrites applied to every vendored .md file so upstream naming matches this repo's conventions. */
export const LOCAL_PATCHES: readonly { readonly from: string; readonly to: string }[] = [
  { from: "GLOSSARY.md", to: "CONTEXT.md" },
];

function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function sourceFileContent(commit: string): string {
  return [
    `repo: ${VENDOR_REPO.replace(/\.git$/, "")}`,
    `commit: ${commit}`,
    `path: ${UPSTREAM_SKILLS_PATH.join("/")}/{${VENDORED_SKILLS.join(",")}}`,
    "license: MIT (see LICENSE)",
    `local patches: ${LOCAL_PATCHES.map(({ from, to }) => `${from} → ${to}`).join(", ")}`,
    "refresh: sandcastle skills update-vendor",
    "",
  ].join("\n");
}

export function applyLocalPatches(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      applyLocalPatches(path);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const original = readFileSync(path, "utf8");
    const patched = LOCAL_PATCHES.reduce((text, { from, to }) => text.replaceAll(from, to), original);
    if (patched !== original) writeFileSync(path, patched);
  }
}

/** Re-vendors the skills from upstream HEAD (or `ref`), applies LOCAL_PATCHES and rewrites SOURCE. Returns the new commit. */
export function updateVendor(sourceRoot: string, ref?: string, repo: string = VENDOR_REPO): string {
  const scratch = mkdtempSync(join(tmpdir(), "sandcastle-vendor-"));
  try {
    git(["clone", "--quiet", ...(ref === undefined ? ["--depth", "1"] : []), repo, scratch]);
    if (ref !== undefined) git(["checkout", "--quiet", ref], scratch);
    const commit = git(["rev-parse", "HEAD"], scratch);
    const target = join(sourceRoot, ...VENDOR_OWNER_DIR);
    for (const skill of VENDORED_SKILLS) {
      const upstream = join(scratch, ...UPSTREAM_SKILLS_PATH, skill);
      if (!existsSync(upstream)) throw new Error(`${skill} no longer exists at ${UPSTREAM_SKILLS_PATH.join("/")} upstream`);
      rmSync(join(target, skill), { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(upstream, join(target, skill), { recursive: true });
      applyLocalPatches(join(target, skill));
    }
    cpSync(join(scratch, "LICENSE"), join(target, "LICENSE"));
    writeFileSync(join(target, "SOURCE"), sourceFileContent(commit));
    return commit;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
