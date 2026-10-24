import type { RunModel, WorkItem } from "../model/runModel.js";
import { knownRepos } from "../project/projectConfig.js";
import {
  isRebaseConflict,
  type Adapters,
  type ReworkBrief,
  type ReworkContext,
  type ReworkRequest,
  type StageCompletion,
  type StageLabel,
  type HoldReason,
  type StageName,
  type WaitReason,
} from "./adapters.js";
import { RunHold, type HoldState } from "./hold.js";
import { OperatorError } from "./operatorError.js";
import { parkComment } from "./parkComment.js";
import { resumePlacement, type ResumeEvidence } from "./resume.js";
import { REWORK_LIMIT_DEFAULT, reworkComment, reworkLimitDetail } from "./rework.js";
import { activeStageChain, commandFor, runningStageLabel, stageNames, type StageSpec } from "./stageChain.js";
import { LocalSlots, type WorkerSlots } from "./slots.js";
import { TRANSIENT_BACKOFF_MS, transientBackoffMs, transientSignature } from "./transient.js";
import { messageOf } from "../messageOf.js";

export { LocalSlots, type WorkerSlots } from "./slots.js";
export { RunHold, type HoldState } from "./hold.js";

export type ItemPhase = "held" | "blocked" | "queued" | "running" | "awaiting" | "waiting" | "parked" | "done";

export interface WaitState {
  reason: WaitReason;
  resumeAt: number | undefined;
}

export type ComparedField = Exclude<keyof WorkItem, "number">;

const KEEP_LABEL = "keep";
type LabelTarget = StageLabel | undefined | typeof KEEP_LABEL;

interface ItemState {
  item: WorkItem;
  phase: ItemPhase;
  nextStageIndex: number;
  branch: string;
  branchCreated: boolean;
  worktreeReady: boolean;
  resolveAttempted: boolean;
  conflictFiles: string[];
  label: StageLabel | undefined;
  warned: string | undefined;
  parkReason: string | undefined;
  wait: WaitState | undefined;
  pullRequestUrl: string | undefined;
  transientRetries: number;
  reworkRound: number;
  reworkLimit: number;
  reworkBriefs: ReworkBrief[];
}

export interface EngineOptions {
  workerCap: number;
  reworkLimit?: number;
  slots?: WorkerSlots;
  hold?: RunHold;
  /** The stage chain; defaults to the active project's (`stages` in config.json). */
  stages?: readonly StageSpec[];
}

export interface ItemView {
  number: number;
  title: string;
  repo: WorkItem["repo"];
  phase: ItemPhase;
  stage: StageName | undefined;
  stageIndex: number;
  branch: string;
  dependsOn: number[];
  blockers: number[];
  parkReason: string | undefined;
  waitReason: WaitReason | undefined;
  resumeAt: string | undefined;
  pullRequestUrl: string | undefined;
  reworkRound: number;
  reworkLimit: number;
}

export const CANCEL_REASON = "cancelled by operator";

export interface StallSummary {
  parked: number;
  held: number;
  blocked: number;
}

const PENDING_PHASES: readonly ItemPhase[] = ["held", "blocked", "queued"];
const STARTED_PHASES: readonly ItemPhase[] = ["running", "awaiting", "waiting", "parked"];
const ADVANCING_PHASES: readonly ItemPhase[] = ["queued", "awaiting", "running", "waiting"];

function stageFailureReason(stage: StageName): string {
  return stage === "verify" ? "verify gate red" : `${stage} stage failed`;
}

function rebaseFailureReason(cause: unknown, integrationBranch: string): string {
  if (!isRebaseConflict(cause)) return `verify gate red — rebase onto ${integrationBranch} failed`;
  return `verify gate red — merge conflict rebasing onto ${integrationBranch}`;
}

function rebaseFailureDetail(cause: unknown): string {
  if (!isRebaseConflict(cause)) return messageOf(cause);
  const files = cause.files.length > 0 ? ["", "conflicting files:", ...cause.files.map((file) => `- ${file}`)] : [];
  const output = cause.gitOutput.trim();
  return [cause.message, ...files, ...(output ? ["", output] : [])].join("\n");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function itemBranch(item: WorkItem): string {
  return `feat/${item.number}-${slugify(item.title)}`;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function changedFields(current: WorkItem, next: WorkItem): ComparedField[] {
  const changes: ComparedField[] = [];
  if (current.title !== next.title) changes.push("title");
  if (current.repo !== next.repo) changes.push("repo");
  if (current.admission !== next.admission) changes.push("admission");
  if (!sameNumbers(current.dependsOn, next.dependsOn)) changes.push("dependsOn");
  if (current.body !== next.body) changes.push("body");
  if (!sameStrings(current.extraMemories, next.extraMemories)) changes.push("extraMemories");
  return changes;
}

function validWorkerCap(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new OperatorError(`workerCap must be a positive integer, got ${value}`);
  }
  return value;
}

function withRework(rework: ReworkContext | undefined): { rework?: ReworkContext } {
  return rework ? { rework } : {};
}

function validReworkLimit(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new OperatorError(`reworkLimit must be a non-negative integer, got ${value}`);
  }
  return value;
}

function labelTargetFor(state: ItemState, stages: readonly StageSpec[]): LabelTarget {
  if (state.phase === "held") return undefined;
  if (state.phase === "blocked") return "sc:blocked";
  if (state.phase === "queued") return "sc:queued";
  if (state.phase === "done") return "sc:done";
  if (state.phase !== "running") return KEEP_LABEL;
  const stage = stages[state.nextStageIndex];
  return stage ? runningStageLabel(stage) : KEEP_LABEL;
}

export const RATE_LIMIT_FALLBACK_MS = 5 * 60_000;

export function waitMessage(wait: WaitState): string {
  if (wait.reason === "transient") {
    return "waiting — a transient infrastructure failure (network, GitHub or the Claude API); sandcastle retries the stage on its own with backoff";
  }
  if (wait.reason === "auth") {
    return "waiting — the agent credentials were rejected; sandcastle re-probes them every poll and resumes on its own once they work";
  }
  if (wait.resumeAt === undefined) return "waiting — five-hour usage limit reached";
  return `waiting — five-hour usage limit reached, resuming at ${new Date(wait.resumeAt).toISOString()}`;
}

export class Engine {
  private readonly states = new Map<number, ItemState>();
  private workerCap: number;
  private readonly reworkLimit: number;
  private readonly integrationBranch: string;
  private readonly parentNumber: number;
  private readonly slots: WorkerSlots;
  private runningCount = 0;
  private started = false;
  private newStartsPaused = false;
  private readonly runHold: RunHold;
  private readonly stages: readonly StageSpec[];

  constructor(
    model: RunModel,
    private readonly adapters: Adapters,
    options: EngineOptions = { workerCap: 1 },
  ) {
    this.workerCap = validWorkerCap(options.workerCap);
    this.reworkLimit = validReworkLimit(options.reworkLimit ?? REWORK_LIMIT_DEFAULT);
    this.integrationBranch = model.integrationBranch;
    this.parentNumber = model.parentNumber;
    this.slots = options.slots ?? new LocalSlots();
    this.runHold = options.hold ?? new RunHold();
    this.stages = options.stages ?? activeStageChain();
    for (const item of model.items) this.states.set(item.number, this.freshState(item));
    for (const state of this.states.values()) state.phase = this.initialPhase(state.item);
  }

  static resume(
    model: RunModel,
    adapters: Adapters,
    evidence: readonly ResumeEvidence[],
    options: EngineOptions = { workerCap: 1 },
  ): Engine {
    const engine = new Engine(model, adapters, options);
    engine.resumeFrom(evidence);
    return engine;
  }

  start(): void {
    if (this.started) throw new Error("engine already started");
    this.started = true;
    this.ensureIntegrationBranches();
    for (const state of this.statesByNumber()) this.reconcileLabel(state);
    this.fillSlots();
  }

  resumeFrom(evidence: readonly ResumeEvidence[]): void {
    if (this.started) throw new Error("engine already started");
    this.restore(evidence);
  }

  private ensureIntegrationBranches(): void {
    for (const repo of knownRepos()) {
      const involved = this.statesByNumber().some((state) => state.item.repo === repo && state.phase !== "done");
      if (involved) this.adapters.git.createIntegrationBranch(repo, this.integrationBranch);
    }
  }

  applySnapshot(next: RunModel): void {
    if (!this.started) throw new Error("applySnapshot before the run started; call start() or Engine.resume() first");
    if (next.parentNumber !== this.parentNumber) {
      throw new Error(`snapshot is for parent #${next.parentNumber} but this run is for #${this.parentNumber}`);
    }
    if (next.integrationBranch !== this.integrationBranch) {
      throw new Error(
        `integration branch changed mid-run: "${this.integrationBranch}" → "${next.integrationBranch}"`,
      );
    }
    const nextByNumber = new Map(next.items.map((item) => [item.number, item]));
    this.dropDeparted(nextByNumber);
    this.joinNewItems(next.items);
    this.adoptPendingItems(nextByNumber);
    for (const state of this.statesByNumber()) {
      if (!PENDING_PHASES.includes(state.phase)) continue;
      this.moveTo(state, this.initialPhase(state.item));
    }
    this.fillSlots();
  }

  handleStageCompletion(completion: StageCompletion): void {
    const state = this.states.get(completion.itemNumber);
    if (!state) throw new Error(`completion for unknown item #${completion.itemNumber}`);
    if (state.phase !== "running") {
      throw new Error(`completion for #${completion.itemNumber} but its phase is "${state.phase}"`);
    }
    const runningStage = this.stages[state.nextStageIndex]?.name;
    if (runningStage !== completion.stage) {
      throw new Error(
        `completion for #${completion.itemNumber} stage "${completion.stage}" but "${runningStage}" is running`,
      );
    }
    if (completion.pullRequestUrl) state.pullRequestUrl = completion.pullRequestUrl;
    if (completion.outcome === "success") state.transientRetries = 0;
    if (completion.resolved && completion.outcome === "success") {
      this.startVerify(state);
      return;
    }
    this.freeSlot();
    if (completion.outcome === "waiting") {
      this.hold(state, completion);
    } else if (completion.outcome === "failure" && completion.rework) {
      this.sendBackToDevelop(state, completion.rework);
    } else if (completion.outcome === "failure") {
      this.park(state, this.failureReason(state, completion.stage), this.failureDetail(state, completion.detail));
    } else if (completion.stage === "verify") {
      this.mergeItem(state);
    } else {
      state.nextStageIndex += 1;
      this.moveTo(state, "awaiting");
    }
    this.fillSlots();
  }

  cancelItem(itemNumber: number): void {
    const state = this.requireState(itemNumber);
    if (state.phase !== "running") {
      throw new OperatorError(`#${itemNumber} is ${state.phase}, not running — only a running item can be cancelled`);
    }
    this.adapters.sandbox.kill(itemNumber);
    this.freeSlot();
    this.park(state, CANCEL_REASON, undefined);
    this.fillSlots();
  }

  retryItem(itemNumber: number): void {
    const state = this.requireState(itemNumber);
    if (state.phase === "waiting") {
      const released = this.runHold.release();
      if (released) {
        this.adapters.ui.note(
          itemNumber,
          `retry released the ${released} hold for the whole run — every waiting item resumes and new stages start again`,
        );
      }
      this.resumeWaiting(state);
      this.fillSlots();
      return;
    }
    if (state.phase !== "parked") {
      throw new OperatorError(`#${itemNumber} is ${state.phase}, not parked — only a parked item can be retried`);
    }
    this.adapters.gh.swapLabels(itemNumber, "ready-for-human", "ready-for-agent");
    this.readmitParked(state);
    this.fillSlots();
  }

  tick(nowMs: number): void {
    if (!this.started) return;
    if (this.runHold.releaseReopenedWindow(nowMs, RATE_LIMIT_FALLBACK_MS)) {
      this.adapters.ui.note(undefined, "usage window reopened — resuming the stages that were waiting on it");
    }
    this.releaseTransientWaits(nowMs);
    if (this.runHold.reason === undefined) {
      for (const state of this.statesByNumber()) {
        if (state.phase !== "waiting" || state.wait?.reason !== "rate-limit") continue;
        if (state.wait.resumeAt !== undefined && nowMs < state.wait.resumeAt) continue;
        this.resumeWaiting(state);
      }
    }
    this.fillSlots();
  }

  releaseAuthHold(): void {
    const heldOnAuth = this.authHeld();
    const authWaiting = this.authWaitingStates();
    if (heldOnAuth) this.runHold.release();
    if (heldOnAuth || authWaiting.length > 0) {
      this.adapters.ui.note(undefined, "agent credentials work again — resuming the stages that were waiting on them");
    }
    for (const state of authWaiting) this.resumeWaiting(state);
    this.refill();
  }

  authHeld(): boolean {
    return this.runHold.reason === "auth";
  }

  waitingOnAuth(): boolean {
    return this.authWaitingStates().length > 0;
  }

  private authWaitingStates(): ItemState[] {
    return this.statesByNumber().filter((state) => state.phase === "waiting" && state.wait?.reason === "auth");
  }

  holdState(): HoldState | undefined {
    return this.runHold.state();
  }

  pauseNewStarts(): void {
    this.newStartsPaused = true;
  }

  resumeNewStarts(): void {
    this.newStartsPaused = false;
    this.fillSlots();
  }

  newStartsArePaused(): boolean {
    return this.newStartsPaused;
  }

  setWorkerCap(value: number): void {
    this.workerCap = validWorkerCap(value);
    this.fillSlots();
  }

  cap(): number {
    return this.workerCap;
  }

  running(): number {
    return this.runningCount;
  }

  phases(): ReadonlyMap<number, ItemPhase> {
    return new Map([...this.states].map(([number, state]) => [number, state.phase]));
  }

  view(): ItemView[] {
    return this.statesByNumber().map((state) => ({
      number: state.item.number,
      title: state.item.title,
      repo: state.item.repo,
      phase: state.phase,
      stage: state.phase === "done" ? undefined : this.stages[state.nextStageIndex]?.name,
      stageIndex: state.phase === "done" ? this.stages.length : state.nextStageIndex,
      branch: state.branch,
      dependsOn: [...state.item.dependsOn],
      blockers: this.blockersOf(state.item),
      parkReason: state.parkReason,
      waitReason: state.wait?.reason,
      resumeAt: state.wait?.resumeAt === undefined ? undefined : new Date(state.wait.resumeAt).toISOString(),
      pullRequestUrl: state.pullRequestUrl,
      reworkRound: state.reworkRound,
      reworkLimit: state.reworkLimit,
    }));
  }

  complete(): boolean {
    if (!this.started) return false;
    return [...this.states.values()].every((state) => state.phase === "done");
  }

  stalled(): StallSummary | undefined {
    if (!this.started || this.complete()) return undefined;
    const phases = [...this.states.values()].map((state) => state.phase);
    if (phases.some((phase) => ADVANCING_PHASES.includes(phase))) return undefined;
    const count = (phase: ItemPhase): number => phases.filter((candidate) => candidate === phase).length;
    return { parked: count("parked"), held: count("held"), blocked: count("blocked") };
  }

  private freshState(item: WorkItem): ItemState {
    return {
      item,
      phase: "blocked",
      nextStageIndex: 0,
      branch: itemBranch(item),
      branchCreated: false,
      worktreeReady: false,
      resolveAttempted: false,
      conflictFiles: [],
      label: item.admission === "done" ? "sc:done" : undefined,
      warned: undefined,
      parkReason: undefined,
      wait: undefined,
      pullRequestUrl: undefined,
      transientRetries: 0,
      reworkRound: 0,
      reworkLimit: this.reworkLimit,
      reworkBriefs: [],
    };
  }

  private sendBackToDevelop(state: ItemState, request: ReworkRequest): void {
    const brief: ReworkBrief = { round: state.reworkRound + 1, source: request.source, story: request.story };
    if (state.reworkRound >= state.reworkLimit) {
      this.park(
        state,
        `rework limit reached — ${request.source} still fails after ${state.reworkRound} rework round(s)`,
        reworkLimitDetail([...state.reworkBriefs, brief], state.reworkLimit),
      );
      return;
    }
    state.reworkRound = brief.round;
    state.reworkBriefs = [...state.reworkBriefs, brief];
    state.nextStageIndex = 0;
    state.resolveAttempted = false;
    state.conflictFiles = [];
    this.moveTo(state, "awaiting");
    this.adapters.ui.note(
      state.item.number,
      `${request.source} sent it back to develop — rework round ${brief.round}/${state.reworkLimit}`,
    );
    try {
      this.adapters.gh.comment(state.item.number, reworkComment(brief, state.reworkLimit, stageNames(this.stages)));
    } catch (cause) {
      this.adapters.ui.warn(
        state.item.number,
        `rework round ${brief.round} started but its hub comment failed: ${messageOf(cause)}`,
      );
    }
  }

  private reworkContext(state: ItemState): ReworkContext | undefined {
    if (state.reworkRound === 0) return undefined;
    return { round: state.reworkRound, limit: state.reworkLimit, briefs: [...state.reworkBriefs] };
  }

  private releaseTransientWaits(nowMs: number): void {
    for (const state of this.statesByNumber()) {
      if (state.phase !== "waiting" || state.wait?.reason !== "transient") continue;
      if (state.wait.resumeAt === undefined) {
        state.wait.resumeAt = nowMs + transientBackoffMs(state.transientRetries);
        continue;
      }
      if (nowMs >= state.wait.resumeAt) this.resumeWaiting(state);
    }
  }

  private holdTransient(state: ItemState, reason: string, detail: string | undefined): void {
    if (state.transientRetries >= TRANSIENT_BACKOFF_MS.length) {
      this.park(state, `${reason} — still failing after ${TRANSIENT_BACKOFF_MS.length} transient retries`, detail);
      return;
    }
    state.transientRetries += 1;
    state.wait = { reason: "transient", resumeAt: undefined };
    state.parkReason = undefined;
    this.moveTo(state, "waiting");
    this.adapters.ui.note(
      state.item.number,
      `${reason}: ${transientSignature(detail) ?? "transient failure"} — retry ${state.transientRetries}/${TRANSIENT_BACKOFF_MS.length} after ${transientBackoffMs(state.transientRetries) / 60_000}m`,
    );
  }

  private hold(state: ItemState, completion: StageCompletion): void {
    if (completion.waitReason === "transient") {
      this.holdTransient(state, `${completion.stage} stage hit a transient failure`, completion.detail);
      return;
    }
    const reason: HoldReason = completion.waitReason ?? "auth";
    const wait: WaitState = { reason, resumeAt: completion.resumeAt };
    state.wait = wait;
    state.parkReason = undefined;
    this.moveTo(state, "waiting");
    this.adapters.ui.note(state.item.number, waitMessage(wait));
    if (!this.runHold.raise(reason, completion.resumeAt)) return;
    this.adapters.ui.note(
      undefined,
      reason === "auth"
        ? "new stage starts held — the agent credentials were rejected; sandcastle re-probes them every poll"
        : `new stage starts held until the usage window reopens${
            completion.resumeAt === undefined ? "" : ` at ${new Date(completion.resumeAt).toISOString()}`
          }`,
    );
  }

  private resumeWaiting(state: ItemState): void {
    if (state.phase !== "waiting") return;
    state.wait = undefined;
    state.resolveAttempted = false;
    state.conflictFiles = [];
    this.moveTo(state, "awaiting");
  }

  private requireState(itemNumber: number): ItemState {
    const state = this.states.get(itemNumber);
    if (!state) throw new OperatorError(`#${itemNumber} is not in the run`);
    return state;
  }

  private moveTo(state: ItemState, phase: ItemPhase): void {
    state.phase = phase;
    this.reconcileLabel(state);
  }

  private reconcileLabel(state: ItemState): void {
    const target = labelTargetFor(state, this.stages);
    if (target === KEEP_LABEL) return;
    if (target === undefined) {
      this.forgetLabel(state);
      return;
    }
    if (state.label === target) return;
    state.label = target;
    this.adapters.gh.setStageLabel(state.item.number, target);
  }

  private forgetLabel(state: ItemState): void {
    const label = state.label;
    if (!label) return;
    state.label = undefined;
    this.adapters.gh.removeLabel(state.item.number, label);
  }

  private restore(evidence: readonly ResumeEvidence[]): void {
    this.started = true;
    const byNumber = new Map<number, ResumeEvidence>();
    for (const entry of evidence) {
      if (!this.states.has(entry.itemNumber)) {
        throw new Error(`resume evidence for #${entry.itemNumber}, which is not in the run model`);
      }
      if (byNumber.has(entry.itemNumber)) throw new Error(`duplicate resume evidence for #${entry.itemNumber}`);
      byNumber.set(entry.itemNumber, entry);
    }
    for (const state of this.statesByNumber()) {
      const found = byNumber.get(state.item.number);
      if (!found) continue;
      state.branchCreated = found.branchExists;
      this.restoreRework(state, found);
      const placement = resumePlacement(found, state.item.admission, this.stages);
      if (placement.kind === "recompute") continue;
      if (placement.kind === "done") {
        state.nextStageIndex = this.stages.length;
        this.moveTo(state, "done");
        continue;
      }
      state.nextStageIndex = placement.stageIndex;
      if (placement.kind === "parked") {
        if (placement.parkReason) this.park(state, placement.parkReason, undefined);
        else state.phase = "parked";
        continue;
      }
      state.phase = "awaiting";
      if (placement.wasParked) this.adapters.gh.removeLabel(state.item.number, "sc:needs-human");
    }
    for (const state of this.statesByNumber()) {
      if (state.phase !== "blocked") continue;
      if (this.dependenciesSatisfied(state.item)) state.phase = "queued";
    }
    for (const state of this.statesByNumber()) this.reconcileLabel(state);
    this.fillSlots();
  }

  private restoreRework(state: ItemState, evidence: ResumeEvidence): void {
    const briefs = [...(evidence.reworkBriefs ?? [])].sort((a, b) => a.round - b.round);
    const round = briefs.at(-1)?.round;
    if (round === undefined) return;
    state.reworkRound = round;
    state.reworkBriefs = briefs;
    state.reworkLimit = Math.max(state.reworkLimit, round);
  }

  private dropDeparted(nextByNumber: ReadonlyMap<number, WorkItem>): void {
    for (const state of this.statesByNumber()) {
      if (nextByNumber.has(state.item.number)) continue;
      if (state.phase === "done") continue;
      if (STARTED_PHASES.includes(state.phase)) {
        this.warn(
          state,
          `departed:${state.phase}`,
          `left the run model while ${state.phase}; sandcastle kept it — cancel it by hand to stop it`,
        );
        continue;
      }
      this.forgetLabel(state);
      this.states.delete(state.item.number);
    }
  }

  private joinNewItems(nextItems: readonly WorkItem[]): void {
    for (const item of nextItems) {
      if (this.states.has(item.number)) continue;
      this.states.set(item.number, this.freshState(item));
    }
  }

  private adoptPendingItems(nextByNumber: ReadonlyMap<number, WorkItem>): void {
    for (const state of this.statesByNumber()) {
      const nextItem = nextByNumber.get(state.item.number);
      if (!nextItem) continue;
      if (state.phase === "done") continue;
      if (state.phase === "parked") {
        this.syncParked(state, nextItem);
        continue;
      }
      if (STARTED_PHASES.includes(state.phase)) {
        this.warnIfChanged(state, nextItem, []);
        continue;
      }
      state.item = nextItem;
      if (!state.branchCreated) state.branch = itemBranch(nextItem);
      if (nextItem.admission === "done") this.moveTo(state, "done");
    }
  }

  private syncParked(state: ItemState, nextItem: WorkItem): void {
    if (nextItem.admission === "done") {
      state.item = nextItem;
      this.moveTo(state, "done");
      return;
    }
    this.warnIfChanged(state, nextItem, ["admission"]);
    if (nextItem.admission !== "queued") return;
    this.readmitParked(state);
  }

  private readmitParked(state: ItemState): void {
    state.item = { ...state.item, admission: "queued" };
    state.parkReason = undefined;
    state.wait = undefined;
    state.resolveAttempted = false;
    state.conflictFiles = [];
    state.reworkLimit = Math.max(state.reworkLimit, state.reworkRound + 1);
    this.moveTo(state, "awaiting");
    this.adapters.gh.removeLabel(state.item.number, "sc:needs-human");
  }

  private warnIfChanged(state: ItemState, nextItem: WorkItem, ignoredFields: readonly ComparedField[]): void {
    const changes = changedFields(state.item, nextItem).filter((field) => !ignoredFields.includes(field));
    if (changes.length === 0) {
      state.warned = undefined;
      return;
    }
    this.warn(
      state,
      `changed:${changes.join(",")}`,
      `changed while ${state.phase} (${changes.join(", ")}); sandcastle ignored the change`,
    );
  }

  private warn(state: ItemState, signature: string, message: string): void {
    if (state.warned === signature) return;
    state.warned = signature;
    this.adapters.ui.warn(state.item.number, message);
  }

  private initialPhase(item: WorkItem): ItemPhase {
    if (item.admission === "done") return "done";
    if (item.admission === "held") return "held";
    return this.dependenciesSatisfied(item) ? "queued" : "blocked";
  }

  private dependencySatisfied(item: WorkItem, dep: number): boolean {
    const depState = this.states.get(dep);
    if (!depState) throw new Error(`#${item.number} depends on #${dep}, which is not in the run model`);
    return depState.phase === "done" || depState.item.admission === "done";
  }

  private dependenciesSatisfied(item: WorkItem): boolean {
    return item.dependsOn.every((dep) => this.dependencySatisfied(item, dep));
  }

  private blockersOf(item: WorkItem): number[] {
    return item.dependsOn.filter((dep) => {
      try {
        return !this.dependencySatisfied(item, dep);
      } catch {
        return true;
      }
    });
  }

  private statesByNumber(): ItemState[] {
    return [...this.states.values()].sort((a, b) => a.item.number - b.item.number);
  }

  private blockedDependentsOf(state: ItemState): number {
    let count = 0;
    for (const candidate of this.states.values()) {
      if (candidate.phase === "blocked" && candidate.item.dependsOn.includes(state.item.number)) count += 1;
    }
    return count;
  }

  private byUnblockingPower(a: ItemState, b: ItemState): number {
    return this.blockedDependentsOf(b) - this.blockedDependentsOf(a) || a.item.number - b.item.number;
  }

  private pickNext(): ItemState | undefined {
    const awaiting = this.statesByNumber().filter((state) => state.phase === "awaiting");
    if (awaiting.length > 0) {
      return awaiting.sort((a, b) => b.nextStageIndex - a.nextStageIndex || this.byUnblockingPower(a, b))[0];
    }
    if (this.newStartsPaused) return undefined;
    const queued = this.statesByNumber().filter((state) => state.phase === "queued");
    return queued.sort((a, b) => this.byUnblockingPower(a, b))[0];
  }

  refill(): void {
    if (!this.started) return;
    this.fillSlots();
  }

  private fillSlots(): void {
    if (this.runHold.reason) return;
    while (this.runningCount < this.workerCap) {
      const next = this.pickNext();
      if (!next) return;
      if (!this.claimSlot()) return;
      this.startStage(next);
    }
  }

  private claimSlot(): boolean {
    if (!this.slots.tryAcquire()) return false;
    this.runningCount += 1;
    return true;
  }

  private freeSlot(): void {
    this.runningCount -= 1;
    this.slots.release();
  }

  private startStage(state: ItemState): void {
    this.skipInapplicableStages(state);
    const stage = this.stages[state.nextStageIndex];
    if (!stage) {
      this.freeSlot();
      throw new Error(`#${state.item.number} has no stage at index ${state.nextStageIndex}`);
    }
    if (stage.kind === "verify") {
      this.moveTo(state, "running");
      this.startVerify(state);
      return;
    }
    if (stage.kind === "command") {
      this.startCommandStage(state, stage, commandFor(stage, state.item.repo) ?? "");
      return;
    }
    this.startAgentStage(state, stage.name);
  }

  private skipInapplicableStages(state: ItemState): void {
    for (let stage = this.stages[state.nextStageIndex]; stage?.kind === "command"; stage = this.stages[state.nextStageIndex]) {
      if (commandFor(stage, state.item.repo) !== undefined) return;
      this.adapters.ui.note(state.item.number, `${stage.name} has no command for ${state.item.repo} — skipping it`);
      state.nextStageIndex += 1;
    }
  }

  private startCommandStage(state: ItemState, stage: StageSpec, command: string): void {
    this.moveTo(state, "running");
    if (!this.ensureWorktree(state, `${stage.name} stage`)) return;
    try {
      this.adapters.sandbox.spawnCommandStage({
        itemNumber: state.item.number,
        stage: stage.name,
        repo: state.item.repo,
        branch: state.branch,
        integrationBranch: this.integrationBranch,
        command,
        ...withRework(this.reworkContext(state)),
      });
    } catch (cause) {
      this.abandonStart(state, `${stage.name} stage could not start — the sandbox refused to spawn`, messageOf(cause));
    }
  }

  private startAgentStage(state: ItemState, stage: StageName): void {
    const { git, sandbox } = this.adapters;
    this.moveTo(state, "running");
    let rebaseConflicts: string[] = [];
    const freshBranch = !state.branchCreated;
    if (!this.ensureWorktree(state, `${stage} stage`)) return;
    if (!freshBranch) {
      try {
        rebaseConflicts = git.syncWithIntegration(state.item.repo, state.branch, this.integrationBranch);
      } catch (cause) {
        this.abandonStart(
          state,
          `${stage} stage could not start — rebasing ${state.branch} onto ${this.integrationBranch} failed`,
          messageOf(cause),
        );
        return;
      }
      if (rebaseConflicts.length > 0) {
        this.adapters.ui.note(
          state.item.number,
          `${stage} starts on a branch that no longer rebases cleanly (${rebaseConflicts.join(", ")}) —` +
            " its agent resolves the conflict as its first task",
        );
      }
    }
    try {
      sandbox.spawnStage({
        itemNumber: state.item.number,
        stage,
        repo: state.item.repo,
        branch: state.branch,
        integrationBranch: this.integrationBranch,
        rebaseConflicts,
        ...withRework(this.reworkContext(state)),
      });
    } catch (cause) {
      this.abandonStart(state, `${stage} stage could not start — the sandbox refused to spawn`, messageOf(cause));
    }
  }

  private ensureWorktree(state: ItemState, what: string): boolean {
    if (state.worktreeReady) return true;
    try {
      this.adapters.git.createItemBranch(state.item.repo, state.branch, this.integrationBranch);
    } catch (cause) {
      this.abandonStart(state, `${what} could not start — creating ${state.branch} failed`, messageOf(cause));
      return false;
    }
    state.branchCreated = true;
    state.worktreeReady = true;
    return true;
  }

  private startVerify(state: ItemState): void {
    const { git } = this.adapters;
    if (!this.ensureWorktree(state, "verify gate")) return;
    try {
      git.rebaseOntoIntegration(state.item.repo, state.branch, this.integrationBranch);
    } catch (cause) {
      if (isRebaseConflict(cause) && !state.resolveAttempted && this.startResolve(state, cause.files)) return;
      this.abandonStart(state, rebaseFailureReason(cause, this.integrationBranch), rebaseFailureDetail(cause));
      return;
    }
    state.conflictFiles = [];
    try {
      git.runChecks({
        itemNumber: state.item.number,
        repo: state.item.repo,
        branch: state.branch,
        integrationBranch: this.integrationBranch,
      });
    } catch (cause) {
      this.abandonStart(state, "verify gate could not start", messageOf(cause));
    }
  }

  private failureReason(state: ItemState, stage: StageName): string {
    if (stage !== "verify" || state.conflictFiles.length === 0) return stageFailureReason(stage);
    return `verify gate red — the merge conflict with ${this.integrationBranch} survived the resolve pass`;
  }

  private failureDetail(state: ItemState, detail: string | undefined): string | undefined {
    if (state.conflictFiles.length === 0) return detail;
    const files = ["conflicting files:", ...state.conflictFiles.map((file) => `- ${file}`)].join("\n");
    return detail ? `${detail}\n\n${files}` : files;
  }

  private startResolve(state: ItemState, files: readonly string[]): boolean {
    state.resolveAttempted = true;
    state.conflictFiles = [...files];
    this.adapters.ui.note(
      state.item.number,
      `verify gate: ${state.branch} conflicts with ${this.integrationBranch} in ${files.join(", ")} —` +
        " running a constrained resolve pass instead of parking",
    );
    try {
      this.adapters.sandbox.spawnResolve({
        itemNumber: state.item.number,
        repo: state.item.repo,
        branch: state.branch,
        integrationBranch: this.integrationBranch,
        files,
      });
      return true;
    } catch (cause) {
      this.adapters.ui.warn(state.item.number, `the resolve pass refused to spawn: ${messageOf(cause)}`);
      return false;
    }
  }

  private abandonStart(state: ItemState, reason: string, detail: string | undefined): void {
    this.freeSlot();
    if (transientSignature(detail)) {
      this.holdTransient(state, reason, detail);
      return;
    }
    this.park(state, reason, detail);
  }

  private park(state: ItemState, reason: string, detail: string | undefined): void {
    const { gh, ui } = this.adapters;
    const itemNumber = state.item.number;
    state.parkReason = reason;
    state.wait = undefined;
    this.moveTo(state, "parked");
    try {
      gh.addLabel(itemNumber, "sc:needs-human");
      gh.swapLabels(itemNumber, "ready-for-agent", "ready-for-human");
      gh.comment(itemNumber, parkComment(reason, detail));
    } catch (cause) {
      ui.warn(
        itemNumber,
        `parked (${reason}) but the hub write failed: ${messageOf(cause)}` +
          ` — flip the labels on #${itemNumber} by hand`,
      );
    }
  }

  private mergeItem(state: ItemState): void {
    const { gh, ui } = this.adapters;
    const itemNumber = state.item.number;
    let mergedUrl: string;
    try {
      mergedUrl = gh.mergePullRequest(itemNumber).url;
    } catch (cause) {
      this.park(state, `merge into ${this.integrationBranch} failed`, messageOf(cause));
      return;
    }
    state.pullRequestUrl = mergedUrl;
    try {
      gh.closeIssue(itemNumber, mergedUrl);
    } catch (cause) {
      ui.warn(
        itemNumber,
        `merged ${mergedUrl} but closing #${itemNumber} on the hub failed: ${messageOf(cause)}` +
          ` — the work is integrated, close #${itemNumber} by hand`,
      );
    }
    this.moveTo(state, "done");
    this.promoteUnblocked();
  }

  private promoteUnblocked(): void {
    for (const blocked of this.statesByNumber()) {
      if (blocked.phase !== "blocked") continue;
      if (!this.dependenciesSatisfied(blocked.item)) continue;
      this.moveTo(blocked, "queued");
    }
  }
}
