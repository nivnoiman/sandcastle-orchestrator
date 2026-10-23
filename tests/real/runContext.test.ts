import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMemories } from "../../src/real/memories.js";
import { acquireLock, lockPath } from "../../src/real/lock.js";
import { RunContext } from "../../src/real/runContext.js";
import { fsWith, HOME, testLayout, testRunModel, testWorkItem } from "./support.js";

const MEMORY_DIR = join(HOME, ".claude", "projects", "demo-project", "memory");

function context(overrides: { items?: ReturnType<typeof testWorkItem>[] } = {}) {
  const model = testRunModel(overrides.items ?? [testWorkItem()]);
  const asked: string[][] = [];
  const runContext = new RunContext(model, {
    loadMemories: (slugs) => {
      asked.push([...slugs]);
      return slugs.map((slug) => ({ slug, content: `body of ${slug}` }));
    },
    hubRepo: "example-org/hub",
  });
  return { model, runContext, asked };
}

describe("RunContext", () => {
  it("composes a prompt context from the run model and the spawn request", () => {
    const { runContext } = context();
    const prompt = runContext.promptContext({
      itemNumber: 17,
      stage: "develop",
      repo: "api",
      branch: "feat/17-toy-slice",
      integrationBranch: "integration/toy-demo",
    });
    expect(prompt.requiredReading).toEqual(["CLAUDE.md", "docs/agents/sandcastle.md"]);
    expect(prompt.memories.map((memory) => memory.slug)).toEqual(["feedback_no_code_comments"]);
    expect(prompt.parentNumber).toBe(16);
    expect(prompt.feature).toBe("toy-demo");
  });

  it("adds the item's extra memories to the run-wide load-bearing ones", () => {
    const { runContext, asked } = context({ items: [testWorkItem({ extraMemories: ["gotcha_shared_worktree_parallel_agents"] })] });
    runContext.memories(17);
    expect(asked[0]).toEqual(["feedback_no_code_comments", "gotcha_shared_worktree_parallel_agents"]);
  });

  it("caches resolved memories until a snapshot replaces the item", () => {
    const { runContext, asked, model } = context();
    runContext.memories(17);
    runContext.memories(17);
    expect(asked).toHaveLength(1);
    runContext.update(model);
    runContext.memories(17);
    expect(asked).toHaveLength(2);
  });

  it("prefers the branch the engine actually spawned over the derived one", () => {
    const { runContext } = context();
    expect(runContext.locate(17)).toEqual({ repo: "api", branch: "feat/17-feat-toy-slice" });
    runContext.rememberBranch(17, "feat/17-toy-slice");
    expect(runContext.locate(17).branch).toBe("feat/17-toy-slice");
  });

  it("fails fast for an item the run model does not contain", () => {
    const { runContext } = context();
    expect(() => runContext.item(999)).toThrow(/#999 is not in the current run model/);
  });

  it("returns no required reading for a repo the parent did not configure", () => {
    const { runContext } = context();
    expect(runContext.requiredReading("web")).toEqual([]);
  });
});

describe("loadMemories", () => {
  it("reads each slug from the host project memory directory", () => {
    const fs = fsWith({ [join(MEMORY_DIR, "feedback_no_code_comments.md")]: "  Comment-free code.  " });
    expect(loadMemories(fs, testLayout(), ["feedback_no_code_comments"])).toEqual([
      { slug: "feedback_no_code_comments", content: "Comment-free code." },
    ]);
  });

  it("de-duplicates slugs declared at both run and item level", () => {
    const fs = fsWith({ [join(MEMORY_DIR, "a.md")]: "A" });
    expect(loadMemories(fs, testLayout(), ["a", "a"])).toHaveLength(1);
  });

  it("fails fast naming every missing memory file", () => {
    const fs = fsWith({ [join(MEMORY_DIR, "a.md")]: "A" });
    expect(() => loadMemories(fs, testLayout(), ["a", "b", "c"])).toThrow(/not found: b .*, c /);
  });

  it("refuses a slug that could escape the memory directory", () => {
    expect(() => loadMemories(fsWith({}), testLayout(), ["../../../secrets"])).toThrow(/is not a bare file name/);
  });
});

describe("acquireLock", () => {
  const deps = (files: Record<string, string>, alive: boolean) => ({
    fs: fsWith(files),
    layout: testLayout(),
    pid: 4242,
    isAlive: () => alive,
    now: () => new Date("2026-08-14T12:00:00.000Z"),
  });

  it("writes the holder when no orchestrator is running", () => {
    const built = deps({}, false);
    const path = acquireLock(built);
    expect(path).toBe(lockPath(testLayout()));
    expect(built.fs.readText(path)).toBe('{"pid":4242,"startedAt":"2026-08-14T12:00:00.000Z"}');
  });

  it("refuses to start beside a live orchestrator", () => {
    const path = lockPath(testLayout());
    expect(() => acquireLock(deps({ [path]: '{"pid":7,"startedAt":"x"}' }, true))).toThrow(/garbage-collect each other/);
  });

  it("takes over a stale or unparseable lock", () => {
    const path = lockPath(testLayout());
    expect(() => acquireLock(deps({ [path]: '{"pid":7,"startedAt":"x"}' }, false))).not.toThrow();
    expect(() => acquireLock(deps({ [path]: "garbage" }, true))).not.toThrow();
  });
});
