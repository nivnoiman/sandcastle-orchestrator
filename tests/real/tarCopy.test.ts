import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hydrateHomeCommand } from "../../src/real/agents/claude.js";
import { tarCopyCommand } from "../../src/real/skills.js";

function runWithStubbedTar(script: string, senderExit: number, receiverExit = 0) {
  const stub = `tar() { case "$*" in *-cf*) return ${senderExit};; *) cat >/dev/null; return ${receiverExit};; esac; }`;
  return spawnSync("bash", ["-c", `set -o pipefail; ${stub}; ${script}`]).status;
}

describe("tarCopyCommand", () => {
  const copy = tarCopyCommand("/from", ["skills", "commands"], "/to");

  it("builds one tar pipe over ./-prefixed entries", () => {
    expect(copy).toContain("tar -C /from --ignore-failed-read -cf - ./skills ./commands | tar -C /to -xf -");
  });

  it("passes when tar only warns (exit 1)", () => {
    expect(runWithStubbedTar(copy, 1)).toBe(0);
  });

  it("passes on clean exit", () => {
    expect(runWithStubbedTar(copy, 0)).toBe(0);
  });

  it("fails on a fatal sender (exit 2)", () => {
    expect(runWithStubbedTar(copy, 2)).not.toBe(0);
  });

  it("fails on a fatal receiver even when the sender only warned", () => {
    expect(runWithStubbedTar(copy, 1, 2)).not.toBe(0);
  });

  it("fails on a fatal sender even when the receiver only warned", () => {
    expect(runWithStubbedTar(copy, 2, 1)).not.toBe(0);
  });

  it("still fails the hydrate step when required SKILL.md files are missing", () => {
    const check = hydrateHomeCommand().split(" && ").filter((part) => part.startsWith("test -f"));
    expect(check).toHaveLength(3);
    expect(runWithStubbedTar(check.join(" && "), 0)).not.toBe(0);
  });
});
