import { fetchSandcastleParents } from "../gh/parents.js";
import { fetchRunSnapshot } from "../gh/snapshot.js";
import type { RunReader } from "./types.js";

export function createGitHubRunReader(hubRepo: string): RunReader {
  return {
    fetchRunSnapshot: (parentNumber) => fetchRunSnapshot(hubRepo, parentNumber),
    listParents: () => fetchSandcastleParents(hubRepo),
  };
}
