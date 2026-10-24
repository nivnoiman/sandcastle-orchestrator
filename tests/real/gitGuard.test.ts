import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertGitControlUnchanged, GitControlTampered, hostGitEnv, snapshotGitControl } from "../../src/real/gitGuard.js";
import { fsWith } from "./support.js";

const GIT_DIR = join("W:", "repo", ".git");
const CONFIG = join(GIT_DIR, "config");
const ATTRIBUTES = join(GIT_DIR, "info", "attributes");

describe("git control guard", () => {
  it("passes when a container left config and attributes alone", () => {
    const fs = fsWith({ [CONFIG]: "[core]\n" });
    const snapshot = snapshotGitControl(fs, GIT_DIR);
    expect(() => assertGitControlUnchanged(fs, snapshot)).not.toThrow();
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

  it("refuses any branch tracking when the stage has no branch of its own", () => {
    const fs = fsWith({ [CONFIG]: BASE_CONFIG });
    const snapshot = snapshotGitControl(fs, GIT_DIR);
    fs.writeText(CONFIG, `${BASE_CONFIG}[branch "x"]\n\tremote = origin\n`);

    expect(() => assertGitControlUnchanged(fs, snapshot)).toThrow(GitControlTampered);
    expect(fs.readText(CONFIG)).toBe(BASE_CONFIG);
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
