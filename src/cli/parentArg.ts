import type { ProjectConfig } from "../project/projectConfig.js";
import { localIssueStore } from "../tracker/index.js";

type ParentArgProject = Pick<ProjectConfig, "tracker" | "projectRoot">;

const GITHUB_ISSUE_NUMBER = /^#?\d+$/;

/** Whether a CLI argument names an Orchestration Issue rather than a fixture file. */
export function isParentHandle(project: Pick<ProjectConfig, "tracker">, raw: string): boolean {
  if (project.tracker === "local") return !raw.toLowerCase().endsWith(".json");
  return GITHUB_ISSUE_NUMBER.test(raw);
}

/** An issue number, or with the local Tracker also a feature slug, `#n` or the path of an issue file, as the parent's number. */
export function resolveParentHandle(project: ParentArgProject, raw: string): number {
  if (project.tracker === "local") return localIssueStore(project).resolve(raw);
  if (!GITHUB_ISSUE_NUMBER.test(raw)) throw new Error(`"${raw}" is not an issue number`);
  return Number(raw.replace("#", ""));
}

/** The parent a command line names, or exit 2 with the usage text when it is missing or unresolvable. */
export function parentFromArgs(project: ParentArgProject, raw: string | undefined, usage: string): number {
  if (raw === undefined || !isParentHandle(project, raw)) {
    console.error(usage);
    process.exit(2);
  }
  try {
    return resolveParentHandle(project, raw);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(2);
  }
}
