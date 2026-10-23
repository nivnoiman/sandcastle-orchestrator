import { join } from "node:path";
import type { FileSystemPort } from "./fileSystem.js";
import { memoryProjectSuffix } from "./paths.js";

export function syncedEntries(): readonly string[] {
  return [
    memoryProjectSuffix(),
    "skills",
    "commands",
    "agents",
    "CLAUDE.md",
    "settings.json",
    ".credentials.json",
  ];
}

export const PRIVATE_ENTRIES: readonly string[] = [".credentials.json"];

export interface ClaudeSyncReport {
  source: string;
  target: string;
  copied: string[];
  absent: string[];
}

export function syncClaudeHome(fs: FileSystemPort, source: string, target: string): ClaudeSyncReport {
  if (!fs.exists(source)) {
    throw new Error(
      `SANDCASTLE_CLAUDE_SOURCE points at ${source}, which does not exist — the orchestrator copies memories,` +
        " skills and credentials from there into the home the containers hydrate from",
    );
  }
  const report: ClaudeSyncReport = { source, target, copied: [], absent: [] };
  if (source === target) return report;
  for (const entry of syncedEntries()) {
    const from = join(source, entry);
    if (!fs.exists(from)) {
      report.absent.push(entry);
      continue;
    }
    fs.copyTree(from, join(target, entry), { private: PRIVATE_ENTRIES.includes(entry) });
    report.copied.push(entry);
  }
  return report;
}

