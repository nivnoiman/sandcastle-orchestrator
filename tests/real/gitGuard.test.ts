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
