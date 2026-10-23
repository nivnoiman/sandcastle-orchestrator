import type { ItemPhase, StallSummary } from "../engine/engine.js";
import { integrationBase } from "../project/projectConfig.js";
import { countsLine } from "../real/featureVerify/verdict.js";
import type { FeatureVerifyStatus } from "../real/featureVerify/runFeatureVerify.js";
import type { PolishStatus } from "../real/polish/runPolish.js";

export function stallParts(summary: StallSummary): string {
  const parts = [
    summary.parked > 0 ? `${summary.parked} parked` : undefined,
    summary.held > 0 ? `${summary.held} held` : undefined,
    summary.blocked > 0 ? `${summary.blocked} blocked` : undefined,
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) throw new Error("stall line asked for a run with nothing waiting on a human");
  return parts.join(", ");
}

export function stallLine(summary: StallSummary): string {
  return `${stallParts(summary)} — waiting for label flips (Ctrl+C to exit)`;
}

export function featureVerifyLines(status: FeatureVerifyStatus): string[] {
  if (status.phase === "idle") return ["feature verify did not run — the run ended before every item was done"];
  if (status.phase === "skipped") {
    return [`feature verify SKIPPED (--skip-verify) — nothing was verified and no integration → ${integrationBase()} pull request was opened`];
  }
  if (status.phase === "waiting") return ["feature verify is waiting for another parent's verify — the run ended before it got the compose ports"];
  if (status.phase === "running") return ["feature verify is still running"];
  if (status.phase === "fixing") {
    const round = status.rework ? ` round ${status.rework.round}/${status.rework.limit}` : "";
    return [`feature verify is in fix${round} — the run ended before the fix agents finished`];
  }
  if (status.phase === "green") {
    return [
      `feature verify GREEN — ${countsLine(status.counts)}`,
      ...(status.pullRequests.length > 0
        ? status.pullRequests.map((url) => `  integration → ${integrationBase()}, waiting for a human to merge: ${url}`)
        : [`  no integration → ${integrationBase()} pull request was opened — check the report on the parent issue`]),
    ];
  }
  return [
    `feature verify RED — ${status.reason ?? "no usable report"} (${countsLine(status.counts)})${status.rework && status.rework.round > 1 ? ` after ${status.rework.round - 1} fix round(s)` : ""}`,
    "  the run is parked for human triage: the parent carries ready-for-human and no pull request was opened",
  ];
}

export function polishLines(status: PolishStatus): string[] {
  if (status.phase === "idle") return [];
  if (status.phase === "running") return ["polish is still running"];
  if (status.phase === "skipped") return [`polish skipped — ${status.reason ?? "nothing to polish"}`];
  if (status.phase === "green") return status.pullRequests.map((url) => `polish GREEN — ${url}`);
  return [
    `polish REVERTED — ${status.reason ?? "no reason recorded"}`,
    "  the polish commits were dropped; the pull requests hold what Feature Verify tested",
  ];
}

export function epilogueLines(phases: ReadonlyMap<number, ItemPhase>): string[] {
  const ordered = [...phases].sort(([left], [right]) => left - right);
  if (ordered.length === 0) return ["the run ended with no items left in the run model"];
  const lines = ordered.map(([number, phase]) => `#${number} ${phase.toUpperCase()}`);
  const unfinished = ordered.filter(([, phase]) => phase !== "done").map(([number]) => `#${number}`);
  if (unfinished.length === 0) {
    lines.push(`all ${ordered.length} item(s) merged into the integration branch`);
    return lines;
  }
  lines.push(`${unfinished.length} item(s) never reached done: ${unfinished.join(", ")}`);
  return lines;
}
