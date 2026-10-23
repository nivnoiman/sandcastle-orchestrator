import { join } from "node:path";
import type { FileSystemPort } from "../real/fileSystem.js";
import type { SandcastleLayout } from "../real/paths.js";
import { isQueueFile, type QueueFile } from "./runQueue.js";

export function queueFilePath(layout: SandcastleLayout): string {
  return join(layout.sandcastleDir, ".queue.json");
}

function parseQueueFile(raw: string): QueueFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isQueueFile(parsed)) return undefined;
  const { mode, maxParallel, globalCap, parentCap, parents } = parsed;
  return { version: 1, mode, maxParallel, globalCap, parentCap, parents: [...parents] };
}

export function loadQueueFile(fs: FileSystemPort, path: string, warn: (message: string) => void): QueueFile | undefined {
  const raw = fs.readText(path);
  if (raw === undefined) return undefined;
  const file = parseQueueFile(raw);
  if (file !== undefined) return file;
  const asidePath = `${path}.bad`;
  fs.rename(path, asidePath);
  warn(`queue file ${path} is invalid; moved to ${asidePath} and starting with an empty queue`);
  return undefined;
}

export function saveQueueFile(fs: FileSystemPort, path: string, file: QueueFile): void {
  const tempPath = `${path}.tmp`;
  fs.writeText(tempPath, `${JSON.stringify(file, null, 2)}\n`);
  try {
    fs.rename(tempPath, path);
  } catch (error) {
    fs.removeFile(tempPath);
    throw error;
  }
}
