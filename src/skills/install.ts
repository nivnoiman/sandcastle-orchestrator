import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const MANIFEST_FILE = ".sandcastle-installed.json";
const VENDOR_DIR = "vendor";

export type EntryKind = "skill" | "command";
export type EntryState = "missing" | "current" | "outdated" | "modified";

export interface SkillEntry {
  kind: EntryKind;
  name: string;
  source: string;
  dest: string;
  /** Path under the Claude home; the manifest key. */
  key: string;
}

export interface EntryStatus {
  entry: SkillEntry;
  state: EntryState;
}

export interface InstallOptions {
  sourceRoot: string;
  claudeDir: string;
  force?: boolean;
}

export interface InstallResult {
  statuses: EntryStatus[];
  installed: SkillEntry[];
  skipped: SkillEntry[];
}

type Manifest = Record<string, string>;

function subdirectories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort();
}

function skillDirsIn(parent: string): string[] {
  return subdirectories(parent).filter((name) => existsSync(join(parent, name, "SKILL.md")));
}

export function discoverEntries(sourceRoot: string, claudeDir: string): SkillEntry[] {
  const skillsRoot = join(sourceRoot, "skills");
  const skillSources: [string, string][] = skillDirsIn(skillsRoot).map((name) => [name, join(skillsRoot, name)]);
  const vendorRoot = join(skillsRoot, VENDOR_DIR);
  for (const owner of subdirectories(vendorRoot)) {
    for (const name of skillDirsIn(join(vendorRoot, owner))) skillSources.push([name, join(vendorRoot, owner, name)]);
  }
  const skills = skillSources.map(([name, source]): SkillEntry => {
    const key = `skills/${name}`;
    return { kind: "skill", name, source, dest: join(claudeDir, "skills", name), key };
  });

  const commandsRoot = join(sourceRoot, "commands");
  const commandFiles = existsSync(commandsRoot) ? readdirSync(commandsRoot).filter((file) => file.endsWith(".md")).sort() : [];
  const commands = commandFiles.map((file): SkillEntry => {
    const key = `commands/${file}`;
    return { kind: "command", name: file.replace(/\.md$/, ""), source: join(commandsRoot, file), dest: join(claudeDir, key), key };
  });
  return [...skills, ...commands];
}

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [""];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => relative(path, join(item.parentPath, item.name)).replaceAll("\\", "/"))
    .sort();
}

/** Line-ending-insensitive, so a Windows checkout and a Unix one hash alike. */
export function digestOf(path: string): string {
  const hash = createHash("sha256");
  for (const file of filesUnder(path)) {
    const content = readFileSync(file === "" ? path : join(path, file), "utf8").replaceAll("\r\n", "\n");
    hash.update(`${file}\0${content}\0`);
  }
  return hash.digest("hex");
}

function readManifest(claudeDir: string): Manifest {
  const path = join(claudeDir, MANIFEST_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Manifest) : {};
  } catch {
    return {};
  }
}

function stateOf(entry: SkillEntry, manifest: Manifest): EntryState {
  if (!existsSync(entry.dest)) return "missing";
  const installedDigest = digestOf(entry.dest);
  if (installedDigest === digestOf(entry.source)) return "current";
  return installedDigest === manifest[entry.key] ? "outdated" : "modified";
}

export function checkSkills(options: Pick<InstallOptions, "sourceRoot" | "claudeDir">): EntryStatus[] {
  const manifest = readManifest(options.claudeDir);
  return discoverEntries(options.sourceRoot, options.claudeDir).map((entry) => ({ entry, state: stateOf(entry, manifest) }));
}

/** What --check treats as not ready; a locally modified copy is the user's own and stays. */
export function needsInstall(status: EntryStatus): boolean {
  return status.state === "missing" || status.state === "outdated";
}

function copyEntry(entry: SkillEntry): void {
  rmSync(entry.dest, { recursive: true, force: true });
  mkdirSync(dirname(entry.dest), { recursive: true });
  cpSync(entry.source, entry.dest, { recursive: true });
}

export function installSkills(options: InstallOptions): InstallResult {
  const statuses = checkSkills(options);
  const manifest = readManifest(options.claudeDir);
  const installed: SkillEntry[] = [];
  const skipped: SkillEntry[] = [];
  for (const { entry, state } of statuses) {
    if (state === "modified" && !options.force) {
      skipped.push(entry);
      continue;
    }
    if (state !== "current") {
      copyEntry(entry);
      installed.push(entry);
    }
    manifest[entry.key] = digestOf(entry.source);
  }
  mkdirSync(options.claudeDir, { recursive: true });
  writeFileSync(join(options.claudeDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { statuses, installed, skipped };
}

/** `--check` in the shape preflight reports: every shipped file that is missing or outdated under the agent home. */
export function staleSkills(options: Pick<InstallOptions, "sourceRoot" | "claudeDir">): { stale: string[] } {
  const stale = checkSkills(options)
    .filter(needsInstall)
    .map(({ entry, state }) => `${entry.kind} ${entry.name} (${state})`);
  return { stale };
}
