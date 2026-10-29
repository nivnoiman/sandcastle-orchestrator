import type { ProjectConfig } from "../project/projectConfig.js";
import { createGitHubRunReader } from "./github.js";
import { createLocalRunReader, toParentSummary } from "./local/snapshot.js";
import { LocalIssueStore, scratchRootOf } from "./local/store.js";
import type { RunReader } from "./types.js";

export * from "./types.js";
export { createGitHubRunReader, createLocalRunReader, toParentSummary };
export { LocalIssueStore, scratchRootOf };
export { ensureLocalRemote } from "./local/remotes.js";
export { LocalTrackerClient } from "./local/client.js";

export type RunReaderProject = Pick<ProjectConfig, "tracker" | "projectRoot" | "hubRepo">;

export function localIssueStore(project: Pick<ProjectConfig, "projectRoot">): LocalIssueStore {
  return new LocalIssueStore(scratchRootOf(project.projectRoot));
}

/** The run reader for a Project's Tracker; `hubRepo` overrides the configured hub for the github Tracker only. */
export function createRunReader(project: RunReaderProject, hubRepo?: string): RunReader {
  if (project.tracker === "local") return createLocalRunReader(localIssueStore(project), project.hubRepo);
  return createGitHubRunReader(hubRepo ?? project.hubRepo);
}
