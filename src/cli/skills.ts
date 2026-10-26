import { homedir } from "node:os";
import { join } from "node:path";
import { messageOf } from "../messageOf.js";
import { TOOL_DIR } from "../real/paths.js";
import { checkSkills, installSkills, needsInstall, type EntryStatus } from "../skills/install.js";
import { updateVendor } from "../skills/vendor.js";
import { fail } from "./args.js";

const USAGE = [
  "usage: sandcastle skills <install | update-vendor> [options]",
  "  install [--check] [--force] [--target=<dir>]",
  "      copy the shipped skills and commands into ~/.claude (or --target), skipping locally modified copies",
  "      --check   change nothing; exit 1 if any are missing or outdated",
  "      --force   overwrite locally modified copies too",
  "  update-vendor [--ref=<git ref>]",
  "      re-fetch the vendored mattpocock/skills at upstream HEAD (or --ref) and rewrite skills/vendor/mattpocock/SOURCE",
].join("\n");

const args = process.argv.slice(2);
const [subcommand, ...flags] = args;

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return flags.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function label({ entry }: EntryStatus): string {
  return `${entry.kind} ${entry.name}`;
}

function runInstall(): void {
  const claudeDir = flagValue("target") ?? join(homedir(), ".claude");
  const options = { sourceRoot: TOOL_DIR, claudeDir };

  if (flags.includes("--check")) {
    const statuses = checkSkills(options);
    const stale = statuses.filter(needsInstall);
    for (const status of statuses.filter((item) => item.state === "modified")) {
      console.log(`  kept     ${label(status)} (modified locally)`);
    }
    if (stale.length === 0) {
      console.log(`skills ok in ${claudeDir}`);
      return;
    }
    for (const status of stale) console.error(`  ${status.state.padEnd(8)} ${label(status)}`);
    fail(`${stale.length} skill file(s) missing or outdated in ${claudeDir} — run: sandcastle skills install`);
  }

  const result = installSkills({ ...options, force: flags.includes("--force") });
  for (const entry of result.installed) console.log(`  installed ${entry.kind} ${entry.name}`);
  for (const entry of result.skipped) {
    console.log(`  skipped   ${entry.kind} ${entry.name} (modified locally — sandcastle skills install --force to overwrite)`);
  }
  console.log(`skills: ${result.installed.length} installed, ${result.skipped.length} skipped, into ${claudeDir}`);
}

function runUpdateVendor(): void {
  try {
    const commit = updateVendor(TOOL_DIR, flagValue("ref"));
    console.log(`vendored mattpocock/skills at ${commit} — review the diff, then commit`);
  } catch (cause) {
    fail(`update-vendor failed — ${messageOf(cause)}`);
  }
}

if (subcommand === "install") runInstall();
else if (subcommand === "update-vendor") runUpdateVendor();
else fail(USAGE);
