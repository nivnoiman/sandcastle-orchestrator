export * from "./types.js";
export { createGitHubRunReader } from "./github.js";

import { createGitHubRunReader } from "./github.js";
import type { RunReader } from "./types.js";

/** The run reader for a hub; GitHub is the only Tracker until the local one lands. */
export function createRunReader(hubRepo: string): RunReader {
  return createGitHubRunReader(hubRepo);
}
