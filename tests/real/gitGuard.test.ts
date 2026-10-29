import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertGitControlUnchanged,
  expectHostBranchTracking,
  GitControlTampered,
  hostGitEnv,
  releaseGitControl,
  resetGitControlRegistry,
  snapshotGitControl,
} from "../../src/real/gitGuard.js";
import { fsWith } from "./support.js";

const GIT_DIR = join("W:", "repo", ".git");
const CONFIG = join(GIT_DIR, "config");
const ATTRIBUTES = join(GIT_DIR, "info", "attributes");

describe("git control guard", () => {
  beforeEach(resetGitControlRegistry);

  it("passes when a container left config and attributes alone", () => {
    const fs = fsWith({ [CONFIG]: "[core]\n" });
    const snapshot = snapshotGitControl(fs, GIT_DIR);
    expect(() => assertGitControlUnchanged(fs, snapshot)).not.toThrow();
  });

  it("names the changed keys in the refusal without leaking their values", () => {
    const fs = fsWith({ [CONFIG]: "[core]\n" });
    const snapshot = snapshotGitControl(fs, GIT_DIR);
    fs.writeText(CONFIG, "[core]\n\thooksPath = https://user:secret@evil.test/x\n");

    const error = (() => {
      try {
        assertGitControlUnchanged(fs, snapshot);
      } catch (cause) {
        return cause as Error;
      }
    })();
    expect(error?.message).toContain("config +hooksPath");
    expect(error?.message).not.toContain("secret");
  });

  it("restores a tampered config, removes a planted attributes file, and refuses the stage", () => {
    const fs = fsWith({ [CONFIG]: "[core]\n" });
    const snapshot = snapshotGitControl(fs, GIT_DIR);
    fs.writeText(CONFIG, "[core]\n\tfsmonitor = ./evil.sh\n");
    fs.writeText(ATTRIBUTES, "* filter=evil\n");

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe("[core]\n");
    expect(fs.exists(ATTRIBUTES)).toBe(false);
  });

  const BASE_CONFIG = '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/acme/api.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
  const OWN_BRANCH = "x";

  it("passes the stage's own branch tracking written by push -u and gh pr create", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const snapshot = snapshotGitControl(fs, GIT_DIR, "sandcastle/hub-2");
    const after =
      BASE_CONFIG.replace("refs/remotes/origin/*\n", "refs/remotes/origin/*\n\tgh-resolved = base\n") +
      '[branch "sandcastle/hub-2"]\n\tremote = origin\n\tmerge = refs/heads/sandcastle/hub-2\n\tgh-merge-base = sandcastle/integration\n\tpushRemote = origin\n';
    fs.writeText(CONFIG, after);

    expect(() => assertGitControlUnchanged(fs, snapshot)).not.toThrow();
    expect(fs.readText(CONFIG)).toBe(after);
  });

  it("passes tracking the host wrote for a new worktree before that item's stage registered", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const running = snapshotGitControl(fs, GIT_DIR, "feat/a");
    expectHostBranchTracking(GIT_DIR, "feat/b");
    const after = `${BASE_CONFIG}[branch "feat/b"]
	remote = origin
	merge = refs/heads/integration/x
`;
    fs.writeText(CONFIG, after);

    const next = snapshotGitControl(fs, GIT_DIR, "feat/b");
    expect(() => assertGitControlUnchanged(fs, running)).not.toThrow();
    expect(() => assertGitControlUnchanged(fs, next)).not.toThrow();
    expect(fs.readText(CONFIG)).toBe(after);
  });

  it("does not trust host-expected tracking pointed at a URL remote", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const running = snapshotGitControl(fs, GIT_DIR, "feat/a");
    expectHostBranchTracking(GIT_DIR, "feat/b");
    fs.writeText(CONFIG, `${BASE_CONFIG}[branch "feat/b"]
	remote = https://evil.test/x.git
`);

    expect(() => assertGitControlUnchanged(fs, running)).toThrow(GitControlTampered);
  });

  it("passes a concurrent stage's branch tracking written while this stage runs", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const first = snapshotGitControl(fs, GIT_DIR, "feat/a");
    const second = snapshotGitControl(fs, GIT_DIR, "feat/b");
    const after = `${BASE_CONFIG}[branch "feat/b"]
	remote = origin
	merge = refs/heads/integration/x
`;
    fs.writeText(CONFIG, after);

    expect(() => assertGitControlUnchanged(fs, first)).not.toThrow();
    expect(() => assertGitControlUnchanged(fs, second)).not.toThrow();
    expect(fs.readText(CONFIG)).toBe(after);
  });

  it("still refuses a sibling branch pointing its remote at a URL", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const first = snapshotGitControl(fs, GIT_DIR, "feat/a");
    snapshotGitControl(fs, GIT_DIR, "feat/b");
    fs.writeText(CONFIG, `${BASE_CONFIG}[branch "feat/b"]
	remote = https://evil.test/x.git
`);

    expect(() => assertGitControlUnchanged(fs, first)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe(BASE_CONFIG);
  });

  it("does not let a concurrent stage's planted config become a later stage's baseline", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const first = snapshotGitControl(fs, GIT_DIR, "feat/a");
    fs.writeText(CONFIG, `${BASE_CONFIG}[core]
	sshCommand = sh evil.sh
`);

    expect(() => snapshotGitControl(fs, GIT_DIR, "feat/b")).toThrow(GitControlTampered);
    expect(() => assertGitControlUnchanged(fs, first)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe(BASE_CONFIG);
  });

  it("reads a fresh baseline once every stage on the git dir has finished", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const first = snapshotGitControl(fs, GIT_DIR, "feat/a");
    assertGitControlUnchanged(fs, first);
    const grown = `${BASE_CONFIG}[remote "fork"]
	url = https://github.com/acme/fork.git
`;
    fs.writeText(CONFIG, grown);

    const second = snapshotGitControl(fs, GIT_DIR, "feat/b");
    expect(() => assertGitControlUnchanged(fs, second)).not.toThrow();
    expect(fs.readText(CONFIG)).toBe(grown);
  });

  it("stops tolerating a finished stage's branch tracking", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const first = snapshotGitControl(fs, GIT_DIR, "feat/a");
    const second = snapshotGitControl(fs, GIT_DIR, "feat/b");
    releaseGitControl(second);
    fs.writeText(CONFIG, `${BASE_CONFIG}[branch "feat/b"]
	remote = origin
`);

    expect(() => assertGitControlUnchanged(fs, first)).toThrow(GitControlTampered);
  });

  it("treats two spellings of one git dir as the same", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const first = snapshotGitControl(fs, GIT_DIR, "feat/a");
    snapshotGitControl(fs, join(GIT_DIR, "..", ".git"), "feat/b");
    fs.writeText(CONFIG, `${BASE_CONFIG}[branch "feat/b"]
	remote = origin
`);

    expect(() => assertGitControlUnchanged(fs, first)).not.toThrow();
  });

  it.each([
    ["legacy sibling branch syntax", ["[branch.feat/b]", "\tremote = origin", ""].join("\n")],
    ["sibling branch pushurl", ['[branch "feat/b"]', "\tpushurl = https://evil.test/x.git", ""].join("\n")],
    ["unregistered branch next to a registered one", ['[branch "feat/c"]', "\tremote = origin", ""].join("\n")],
  ])("refuses a %s", (_name, extra) => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const first = snapshotGitControl(fs, GIT_DIR, "feat/a");
    snapshotGitControl(fs, GIT_DIR, "feat/b");
    fs.writeText(CONFIG, `${BASE_CONFIG}${extra}`);

    expect(() => assertGitControlUnchanged(fs, first)).toThrow(GitControlTampered);
  });

  it.each([
    ["core.hooksPath", `${BASE_CONFIG}[core]\n\thooksPath = /tmp/hooks\n`],
    ["alias", `${BASE_CONFIG}[alias]\n\tst = !sh evil.sh\n`],
    ["filter", `${BASE_CONFIG}[filter "lfs"]\n\tclean = sh evil.sh\n`],
    ["include", `${BASE_CONFIG}[include]\n\tpath = /tmp/evil.cfg\n`],
    ["remote url", BASE_CONFIG.replace("acme/api", "evil/api")],
    ["new remote", `${BASE_CONFIG}[remote "evil"]\n\turl = https://evil.test/x.git\n`],
    ["key smuggled after a branch header", `${BASE_CONFIG}[branch "x"]\n\tremote = origin\n[core] sshCommand = sh evil.sh\n`],
    ["line continuation", `${BASE_CONFIG}[branch "x"]\n\tremote = origin \\\n`],
    ["header stacked on a branch header", `${BASE_CONFIG}[branch "x"][core]hooksPath = /tmp/hooks\n`],
    ["upper-case core section", `${BASE_CONFIG}[CORE]\n\tHooksPath = /tmp/hooks\n`],
    ["legacy remote subsection", `${BASE_CONFIG}[remote.evil]\n\turl = https://evil.test/x.git\n`],
    ["non-ASCII-indented branch key git rejects", `${BASE_CONFIG}[branch "x"]\n remote = origin\n`],
    ["space before a subsection's closing bracket", `${BASE_CONFIG}[branch "x" ]\n\tremote = origin\n`],
    ["unclosed quote in a branch value", `${BASE_CONFIG}[branch "x"]\n\tremote = "origin\n`],
    ["unknown escape in a branch value", `${BASE_CONFIG}[branch "x"]\n\tremote = ori\\gin\n`],
    ["vertical tab between key and =", `${BASE_CONFIG}[branch "x"]\n\tremote\v= origin\n`],
    ["another branch's tracking", `${BASE_CONFIG}[branch "main"]\n\tremote = origin\n`],
    ["own branch remote set to a URL", `${BASE_CONFIG}[branch "x"]\n\tremote = https://evil.test/x.git\n`],
    ["own branch pushRemote set to a URL", `${BASE_CONFIG}[branch "x"]\n\tpushRemote = https://evil.test/x.git\n`],
    ["own branch remote naming an unknown remote", `${BASE_CONFIG}[branch "x"]\n\tremote = upstream\n`],
    ["gh-resolved on an unknown remote", `${BASE_CONFIG}[remote "evil"]\n\tgh-resolved = base\n`],
    ["own branch mergeOptions", `${BASE_CONFIG}[branch "x"]\n\tmergeOptions = -s evil\n`],
    ["own branch remote smuggled past a comment", `${BASE_CONFIG}[branch "x"]\n\tremote = "evil";origin\n`],
    ["own branch remote as a bare key", `${BASE_CONFIG}[branch "x"]\n\tremote\n`],
    ["own branch in different case", `${BASE_CONFIG}[branch "X"]\n\tremote = origin\n`],
    ["own branch via legacy subsection syntax", `${BASE_CONFIG}[branch.x]\n\tremote = https://evil.test/x.git\n`],
  ])("refuses and restores a %s change", (_name, tampered) => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const snapshot = snapshotGitControl(fs, GIT_DIR, OWN_BRANCH);
    fs.writeText(CONFIG, tampered);

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe(BASE_CONFIG);
  });

  it.each([
    ["BOM", `﻿${BASE_CONFIG}`],
    ["CRLF", BASE_CONFIG.replace(/\n/g, "\r\n")],
  ])("passes branch tracking added to a %s config", (_name, base) => {
    const fs = fsWith({ [CONFIG]: base });
    const snapshot = snapshotGitControl(fs, GIT_DIR, OWN_BRANCH);
    const after = `${base}[branch "x"]\n\tremote = origin\n\tmerge = refs/heads/x ; tracking\n\tdescription = "a; \\"b\\""\n`;
    fs.writeText(CONFIG, after);

    expect(() => assertGitControlUnchanged(fs, snapshot)).not.toThrow();
    expect(fs.readText(CONFIG)).toBe(after);
  });

  it.each([
    ["quoted", '"origin"'],
    ["trailing comment", "origin ; set by push -u"],
  ])("decodes a %s own-branch remote value as git does", (_name, value) => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const snapshot = snapshotGitControl(fs, GIT_DIR, OWN_BRANCH);
    fs.writeText(CONFIG, `${BASE_CONFIG}[branch "x"]\n\tremote = ${value}\n`);

    expect(() => assertGitControlUnchanged(fs, snapshot)).not.toThrow();
  });

  it("refuses a guarded key flipped between empty and bare (implicit true)", () => {
    const base = "[core]\n\tbare =\n";
    const fs = fsWith({ [CONFIG]: base });
    const snapshot = snapshotGitControl(fs, GIT_DIR, OWN_BRANCH);
    fs.writeText(CONFIG, "[core]\n\tbare\n");

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe(base);
  });

  it("refuses an own-branch remote naming a remote that has no url", () => {
    const base = `${BASE_CONFIG}[remote "upstream"]\n\tgh-resolved = base\n`;
    const fs = fsWith({ [CONFIG]: base });
    const snapshot = snapshotGitControl(fs, GIT_DIR, OWN_BRANCH);
    fs.writeText(CONFIG, `${base}[branch "x"]\n\tremote = upstream\n`);

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe(base);
  });

  it("refuses an own-branch remote naming a remote added in the same stage", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const snapshot = snapshotGitControl(fs, GIT_DIR, OWN_BRANCH);
    fs.writeText(CONFIG, `${BASE_CONFIG}[remote "evil"]\n\turl = https://evil.test/x.git\n[branch "x"]\n\tremote = evil\n`);

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe(BASE_CONFIG);
  });

  it("refuses any branch tracking when no stage on the git dir has a branch", () => {
    const quietGitDir = join("W:", "quiet", ".git");
    const quietConfig = join(quietGitDir, "config");
    const fs = fsWith({ [quietConfig]: BASE_CONFIG });
    const snapshot = snapshotGitControl(fs, quietGitDir);
    fs.writeText(quietConfig, `${BASE_CONFIG}[branch "x"]\n\tremote = origin\n`);

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(GitControlTampered);
    expect(fs.readText(quietConfig)).toBe(BASE_CONFIG);
  });

  it("refuses and restores a deleted config", () => {
    const original = '[branch "x"]\n\tremote = origin\n';
    const fs = fsWith({ [CONFIG]: original });
    const snapshot = snapshotGitControl(fs, GIT_DIR, OWN_BRANCH);
    fs.removeFile(CONFIG);

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe(original);
  });

  it("refuses an attributes change even when config only gained branch tracking", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const snapshot = snapshotGitControl(fs, GIT_DIR, OWN_BRANCH);
    fs.writeText(CONFIG, `${BASE_CONFIG}[branch "x"]\n\tremote = origin\n`);
    fs.writeText(ATTRIBUTES, "* filter=evil\n");

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(/info.attributes/);
    expect(fs.exists(ATTRIBUTES)).toBe(false);
  });

  it("turns hooks and fsmonitor off for every host git call", () => {
    expect(hostGitEnv()).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    });
  });
});
