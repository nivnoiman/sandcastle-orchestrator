import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstanceRegistry, projectId } from "../../src/registry/index.js";

let registryDir: string;
let alive: Set<number>;

const registry = () => createInstanceRegistry({ registryDir, isAlive: (pid) => alive.has(pid) });

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), "sc-registry-"));
  alive = new Set([100, 200]);
});
afterEach(() => rmSync(registryDir, { recursive: true, force: true }));

describe("instance registry", () => {
  it("registers a running Project Server with pid/port/dir/mode", () => {
    const entry = registry().register({ dir: "/work/a", pid: 100, port: 7777, mode: "real" });
    expect(entry).toMatchObject({ id: projectId("/work/a"), pid: 100, port: 7777, mode: "real" });
    expect(registry().running()).toHaveLength(1);
  });

  it("deregister keeps the Known Project but marks it stopped", () => {
    const reg = registry();
    reg.register({ dir: "/work/a", pid: 100, port: 7777, mode: "real" });
    reg.deregister("/work/a", 100);
    expect(reg.running()).toHaveLength(0);
    expect(reg.list()).toEqual([expect.objectContaining({ pid: null, port: null, mode: null })]);
  });

  it("deregister by a non-owning pid is a no-op", () => {
    const reg = registry();
    reg.register({ dir: "/work/a", pid: 100, port: 7777, mode: "real" });
    reg.deregister("/work/a", 200);
    expect(reg.running()).toHaveLength(1);
  });

  it("cleans stale pids to stopped, retaining the Known Project", () => {
    registry().register({ dir: "/work/a", pid: 100, port: 7777, mode: "dry" });
    alive.delete(100);
    const reg = registry();
    expect(reg.running()).toHaveLength(0);
    expect(reg.list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(reg.file, "utf8"))[0].pid).toBeNull();
  });

  it("allows one entry per Project: live holder blocks, dead holder is replaced", () => {
    const reg = registry();
    reg.register({ dir: "/work/a", pid: 100, port: 7777, mode: "real" });
    expect(() => reg.register({ dir: "/work/a", pid: 200, port: 7778, mode: "real" })).toThrow(/already has a Project Server/);
    alive.delete(100);
    reg.register({ dir: "/work/a", pid: 200, port: 7778, mode: "real" });
    expect(reg.list()).toHaveLength(1);
    expect(reg.running()[0]).toMatchObject({ pid: 200, port: 7778 });
  });

  it("records mode per entry", () => {
    const reg = registry();
    reg.register({ dir: "/work/a", pid: 100, port: 7777, mode: "dry" });
    reg.register({ dir: "/work/b", pid: 200, port: 7778, mode: "real" });
    const modes = Object.fromEntries(reg.running().map((entry) => [basename(entry.dir), entry.mode]));
    expect(modes).toEqual({ a: "dry", b: "real" });
  });

  it("survives a corrupt file", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    writeFileSync(join(registryDir, "instances.json"), "{nope");
    expect(registry().list()).toEqual([]);
  });
});
