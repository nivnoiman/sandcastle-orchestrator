import { hubIssueUrl, runPullRequests, type BoardProject } from "./model.js";
import { formatQuiet } from "./format.js";
import type { UiRun } from "../state.js";

/** What a human needs to decide on a parked item: why, where, and the links to look at. */
export interface ParkDetail {
  stage: string | undefined;
  reason: string;
  /** ISO instant the item parked. */
  since: string;
  issueUrl: string;
  pullRequestUrl: string | undefined;
}

/** Needs Attention kinds, in the fixed order they are listed. */
export const ATTENTION_KINDS = [
  "auth-hold",
  "parked",
  "verify-red",
  "stall",
  "quiet",
  "polish-reverted",
  "integration-ready",
  "rate-hold",
  "server-died",
] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export type AttentionTone = "red" | "amber" | "purple" | "info";

export type AttentionActionId = "requeue" | "hold" | "comment" | "log" | "cancel" | "open-run" | "open-link" | "feed" | "restart" | "recheck-auth";

export interface AttentionAction {
  id: AttentionActionId;
  label: string;
  itemNumber?: number;
  runNumber?: number;
  /** Set on link actions (open PR). */
  href?: string;
}

export interface AttentionEntry {
  key: string;
  kind: AttentionKind;
  /** 1-based position in the fixed kind order. */
  rank: number;
  projectId: string;
  projectName: string;
  tone: AttentionTone;
  /** Counts toward the rail badge (everything but rate-limit Holds). */
  counted: boolean;
  title: string;
  detail: string;
  runNumber?: number;
  itemNumber?: number;
  /** ISO instant a rate-limit Hold lifts. */
  until?: string;
  /** Set on parked entries. */
  park?: ParkDetail;
  auth?: { running: boolean; error: string | undefined };
  actions: AttentionAction[];
}

const TONES: Record<AttentionKind, AttentionTone> = {
  "auth-hold": "red",
  parked: "red",
  "verify-red": "red",
  stall: "amber",
  quiet: "amber",
  "polish-reverted": "red",
  "integration-ready": "purple",
  "rate-hold": "info",
  "server-died": "red",
};

function rankOf(kind: AttentionKind): number {
  return ATTENTION_KINDS.indexOf(kind) + 1;
}

type EntryInput = Omit<AttentionEntry, "rank" | "tone" | "counted" | "projectId" | "projectName" | "key"> & {
  scope: string;
};

function entry(project: BoardProject, input: EntryInput): AttentionEntry {
  const { scope, ...rest } = input;
  return {
    ...rest,
    key: `${project.id}:${input.kind}:${scope}`,
    rank: rankOf(input.kind),
    tone: TONES[input.kind],
    counted: input.kind !== "integration-ready" && input.kind !== "rate-hold",
    projectId: project.id,
    projectName: project.name,
  };
}

function runEntries(project: BoardProject, run: UiRun): AttentionEntry[] {
  const number = run.parent.number;
  const entries: AttentionEntry[] = [];
  const openRun: AttentionAction = { id: "open-run", label: "Open run", runNumber: number };

  for (const item of run.items) {
    if (item.phase === "parked") {
      const reason = item.parkReason ?? "parked with no recorded reason";
      entries.push(
        entry(project, {
          scope: `${number}:${item.number}`,
          kind: "parked",
          title: `#${item.number} ${item.title} parked${item.stage ? ` at ${item.stage}` : ""}`,
          detail: reason,
          runNumber: number,
          itemNumber: item.number,
          park: {
            stage: item.stage,
            reason,
            since: item.phaseSince,
            issueUrl: item.issueUrl,
            pullRequestUrl: item.pullRequestUrl,
          },
          actions: [
            { id: "log", label: "Transcript", itemNumber: item.number, runNumber: number },
            { id: "open-link", label: item.pullRequestUrl ? "Open PR" : "Open issue", href: item.pullRequestUrl ?? item.issueUrl },
            { id: "comment", label: "Add comment", itemNumber: item.number, runNumber: number },
            { id: "hold", label: "Hold", itemNumber: item.number, runNumber: number },
            { id: "requeue", label: "Re-queue", itemNumber: item.number, runNumber: number },
          ],
        }),
      );
    }
    if (item.quiet) {
      const silent = Math.floor(item.quiet.silentSeconds / 60);
      entries.push(
        entry(project, {
          scope: `${number}:${item.number}`,
          kind: "quiet",
          title: `#${item.number} ${item.title} is ${formatQuiet(item.quiet)}`,
          detail: `No agent output for ${silent}m; the idle timeout parks it.`,
          runNumber: number,
          itemNumber: item.number,
          actions: [
            { id: "log", label: "Log", itemNumber: item.number, runNumber: number },
            { id: "cancel", label: "Cancel", itemNumber: item.number, runNumber: number },
          ],
        }),
      );
    }
  }

  if (run.featureVerify.phase === "red") {
    const { counts, reason, rework } = run.featureVerify;
    const rounds = rework ? ` after ${rework.round}/${rework.limit} fix rounds` : "";
    entries.push(
      entry(project, {
        scope: String(number),
        kind: "verify-red",
        title: `Feature Verify red on #${number}${rounds}`,
        detail: reason ?? `${counts.pass} pass, ${counts.fail} fail, ${counts.requiresStg} requires-STG`,
        runNumber: number,
        actions: [openRun],
      }),
    );
  }

  if (run.stalled) {
    const { parked, held, blocked } = run.stalled;
    entries.push(
      entry(project, {
        scope: String(number),
        kind: "stall",
        title: `Run #${number} ${run.parent.title} is stalled`,
        detail: `${parked} parked, ${held} held, ${blocked} blocked — nothing can advance until you act`,
        runNumber: number,
        actions: [openRun],
      }),
    );
  }

  if (run.polish.phase === "reverted") {
    entries.push(
      entry(project, {
        scope: String(number),
        kind: "polish-reverted",
        title: `Polish reverted on #${number}`,
        detail: run.polish.reason ?? "polish changes were reverted",
        runNumber: number,
        actions: [openRun],
      }),
    );
  }
  return entries;
}

/** A parent whose sub-issues are all closed and whose Run (if any) finished verify and polish. */
function integrationReadyEntries(project: BoardProject): AttentionEntry[] {
  const state = project.state;
  if (!state) return [];
  const entries: AttentionEntry[] = [];
  for (const parent of project.parents) {
    if (parent.subIssues === 0 || parent.completedSubIssues !== parent.subIssues) continue;
    const run = state.runs.find((candidate) => candidate.parent.number === parent.number);
    if (run && !runIsReadyForMerge(run)) continue;
    const prs = run ? runPullRequests(run) : [];
    entries.push(
      entry(project, {
        scope: String(parent.number),
        kind: "integration-ready",
        title: `#${parent.number} ${parent.title} is ready for your merge`,
        detail: `All ${parent.subIssues} sub-issues are merged into the integration branch.`,
        runNumber: parent.number,
        actions: [{ id: "open-link", label: prs.length > 0 ? "Open PR" : "Open issue", href: prs[0] ?? hubIssueUrl(state.hubRepo, parent.number) }],
      }),
    );
  }
  return entries;
}

export function runIsReadyForMerge(run: UiRun): boolean {
  const verifyCleared = run.featureVerify.phase === "green" || run.featureVerify.phase === "skipped";
  const polishCleared = ["green", "skipped", "reverted"].includes(run.polish.phase);
  return verifyCleared && polishCleared;
}

function holdEntries(project: BoardProject): AttentionEntry[] {
  const state = project.state;
  if (!state) return [];
  const holds = [state.hold, ...state.runs.map((run) => run.hold)].filter((hold) => hold !== undefined);
  const entries: AttentionEntry[] = [];
  const authHold = holds.find((hold) => hold.reason === "auth");
  if (authHold) {
    const runNumber = state.runs.find((run) => run.hold?.reason === "auth")?.parent.number ?? state.parent?.number;
    entries.push(
      entry(project, {
        scope: "auth",
        kind: "auth-hold",
        title: "Held — agent credentials rejected",
        detail: "No new stages start. Sandcastle re-probes the credentials every ~10 minutes and resumes once they pass.",
        ...(runNumber === undefined ? {} : { runNumber }),
        auth: { running: authHold.probe?.running ?? false, error: authHold.probe?.error },
        actions: [
          ...(runNumber === undefined ? [] : [{ id: "recheck-auth" as const, label: "I re-logged in, check now", runNumber }]),
          { id: "feed", label: "Feed" },
        ],
      }),
    );
  }
  const rate = holds.find((hold) => hold.reason !== "auth");
  if (rate) {
    entries.push(
      entry(project, {
        scope: "rate",
        kind: "rate-hold",
        title: "Held — usage limit reached",
        detail: "No new stages start until the usage window reopens.",
        ...(rate.until === undefined ? {} : { until: rate.until }),
        actions: [],
      }),
    );
  }
  return entries;
}

function projectEntries(project: BoardProject): AttentionEntry[] {
  if (project.status === "died") {
    return [
      entry(project, {
        scope: "died",
        kind: "server-died",
        title: "Project Server died unexpectedly",
        detail: "It was running and is no longer reachable. Restart it to resume watching its runs.",
        actions: [{ id: "restart", label: "Restart" }],
      }),
    ];
  }
  const state = project.state;
  if (!state) return [];
  return [...holdEntries(project), ...state.runs.flatMap((run) => runEntries(project, run)), ...integrationReadyEntries(project)];
}

function compare(a: AttentionEntry, b: AttentionEntry): number {
  return a.rank - b.rank || (a.runNumber ?? 0) - (b.runNumber ?? 0) || (a.itemNumber ?? 0) - (b.itemNumber ?? 0);
}

/** Needs Attention across Projects: the current Project first, each group in the fixed kind order. */
export function buildAttention(projects: readonly BoardProject[], currentId: string): AttentionEntry[] {
  const current = projects.filter((project) => project.id === currentId);
  const others = projects.filter((project) => project.id !== currentId);
  return [...current, ...others].flatMap((project) => projectEntries(project).sort(compare));
}

export interface AttentionBadge {
  red: number;
  purple: number;
}

/** Rail badge: red for kinds 1-6 and 9, purple for Integrations ready for your merge. */
export function attentionBadge(entries: readonly AttentionEntry[], projectId: string): AttentionBadge {
  const own = entries.filter((candidate) => candidate.projectId === projectId);
  return {
    red: own.filter((candidate) => candidate.counted).length,
    purple: own.filter((candidate) => candidate.kind === "integration-ready").length,
  };
}
