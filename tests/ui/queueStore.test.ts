import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/real/fileSystem.js";
import { layoutFrom } from "../../src/real/paths.js";
import type { QueueFile } from "../../src/ui/runQueue.js";
import { loadQueueFile, queueFilePath, saveQueueFile } from "../../src/ui/queueStore.js";

const path = queueFilePath(layoutFrom(join("S:", "sandcastle"), join("H:", "home")));
const file: QueueFile = { version: 1, mode: "parallel", maxParallel: 2, globalCap: 4, parentCap: 2, parents: [3, 5] };

function warnings() {
  const messages: string[] = [];
  return { messages, warn: (message: string) => messages.push(message) };
}

describe("queueStore", () => {
  it("lives in the sandcastle dir", () => {
    expect(path).toBe(join("S:", "sandcastle", ".queue.json"));
  });

  it("round trips through an atomic tmp + rename write", () => {
    const fs = new MemoryFileSystem();
    const renames: [string, string][] = [];
    const rename = fs.rename.bind(fs);
    fs.rename = (from, to) => {
      expect(fs.readText(from)).toBeDefined();
      renames.push([from, to]);
      rename(from, to);
    };
    saveQueueFile(fs, path, file);
    expect(renames).toEqual([[`${path}.tmp`, path]]);
    expect(fs.exists(`${path}.tmp`)).toBe(false);
    const { messages, warn } = warnings();
    expect(loadQueueFile(fs, path, warn)).toEqual(file);
    expect(messages).toEqual([]);
  });

  it("removes the tmp file and rethrows when rename fails", () => {
    const fs = new MemoryFileSystem({ [path]: "old" });
    fs.rename = () => {
      throw new Error("EPERM");
    };
    expect(() => saveQueueFile(fs, path, file)).toThrow("EPERM");
    expect(fs.exists(`${path}.tmp`)).toBe(false);
    expect(fs.readText(path)).toBe("old");
  });

  it("returns undefined for a missing file", () => {
    const { messages, warn } = warnings();
    expect(loadQueueFile(new MemoryFileSystem(), path, warn)).toBeUndefined();
    expect(messages).toEqual([]);
  });

  it.each([
    ["unparseable", "{not json"],
    ["wrong version", JSON.stringify({ ...file, version: 2 })],
    ["bad mode", JSON.stringify({ ...file, mode: "burst" })],
    ["bad parent", JSON.stringify({ ...file, parents: [1, -2] })],
    ["duplicate parent", JSON.stringify({ ...file, parents: [1, 1] })],
    ["bad cap", JSON.stringify({ ...file, globalCap: 0 })],
  ])("sets aside a %s file", (_label, content) => {
    const fs = new MemoryFileSystem({ [path]: content });
    const { messages, warn } = warnings();
    expect(loadQueueFile(fs, path, warn)).toBeUndefined();
    expect(fs.exists(path)).toBe(false);
    expect(fs.readText(`${path}.bad`)).toBe(content);
    expect(messages).toHaveLength(1);
  });
});
