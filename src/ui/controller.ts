import type { UiSink } from "../engine/adapters.js";
import { OperatorError } from "../engine/operatorError.js";
import { activeStageChain } from "../engine/stageChain.js";
import { isParentReference, parseParentInputs, type ParentInput } from "../gh/parentInput.js";
import type { ParentSummary } from "../tracker/types.js";
import type { RunSnapshot } from "../tracker/types.js";
import { loadRunModel, type RunModel } from "../model/runModel.js";
import { parseAttemptId, type AttemptChunk, type AttemptRecord } from "../real/attemptLog.js";
import type { ResetPlan, ResetReport } from "../real/reset.js";
import { IDLE_TIMEOUT_DEFAULT } from "../real/env.js";
import { ParentRunSlot, ParentRunSlots, type QuietFor, type Session, type SlotNote } from "./parentRunSlot.js";
import { quietInfo } from "./quiet.js";
import { RunQueue, type QueueMode } from "./runQueue.js";
import {
  idleFeatureVerify,
  idlePolish,
  phaseCounts,
  uiHold,
  uiItems,
  uiParent,
  uiStageChain,
  type FeedKind,
  type RunMode,
  type UiFeedLine,
  type UiQueueSettings,
  type UiState,
} from "./state.js";
import { messageOf } from "../messageOf.js";

export type { AttemptReader, Session } from "./parentRunSlot.js";

export const FEED_LIMIT = 200;
export const ADDED_PARENT_LIMIT = 25;

export interface StartSessionRequest {
  model: RunModel;
  workerCap: number;
  sink: UiSink;
}

export interface ResetOps {
  plan: (parentNumber: number) => Promise<ResetPlan>;
  apply: (parentNumber: number) => Promise<ResetReport>;
}

export interface GlobalCapControl {
  get(): number;
  set(value: number): void;
}

export interface ControllerDeps {
  mode: RunMode;
  hubRepo: string;
  startCap: number;
  preselectedParent?: number;
  listParents: () => Promise<ParentSummary[]>;
  loadSnapshot: (parentNumber: number) => Promise<RunSnapshot>;
  startSession: (request: StartSessionRequest) => Session | Promise<Session>;
  queue?: RunQueue;
  globalCap?: GlobalCapControl | undefined;
  reset?: ResetOps | undefined;
  now: () => Date;
  /** Per-agent idle timeout in seconds; Quiet starts at half of it. */
  idleTimeoutSeconds?: number;
}

export type UiEvent = { kind: "state"; state: UiState } | { kind: "feed"; line: UiFeedLine };

export interface ParentCheck {
  input: string;
  number?: number;
  title?: string;
  ok: boolean;
  error?: string;
}

export interface StartRunRequest {
  parent: number;
  cap: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new OperatorError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

export function parentList(parents: readonly number[]): string {
  return parents.map((parent) => `#${parent}`).join(", ");
}

export class UiController {
  private readonly slots = new ParentRunSlots();
  private resetting = false;
  private queuePaused: boolean;
  private readonly queue: RunQueue;
  private readonly feed: UiFeedLine[] = [];
  private readonly listeners = new Set<(event: UiEvent) => void>();
  private lastStateJson = "";
  private revision = 0;
  private lastEmittedRevision = 0;
  private readonly boot = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly added = new Map<number, ParentSummary>();
  private readonly startingFromQueue = new Set<number>();
  private readonly removedWhileStarting = new Set<number>();

  constructor(private readonly deps: ControllerDeps) {
    this.queue =
      deps.queue ?? new RunQueue(undefined, { globalCap: deps.startCap, parentCap: deps.startCap }, () => undefined);
    const restored = this.queue.parents();
    this.queuePaused = restored.length > 0;
    if (this.queuePaused) {
      this.note("note", undefined, `restored queue ${parentList(restored)} — paused until you resume it`);
    }
  }

  get mode(): RunMode {
    return this.deps.mode;
  }

  subscribe(listener: (event: UiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async parents(): Promise<ParentSummary[]> {
    const listed = await this.deps.listParents();
    const known = new Set(listed.map((parent) => parent.number));
    return [...listed, ...[...this.added.values()].filter((parent) => !known.has(parent.number))];
  }

  async addParents(text: string): Promise<ParentCheck[]> {
    const parsed = parseParentInputs(text);
    if (parsed.length === 0) throw new OperatorError("nothing to add — give one issue number or issue url per line");
    return Promise.all(parsed.map((entry) => this.checkParent(entry)));
  }

  private async checkParent(entry: ParentInput): Promise<ParentCheck> {
    if (!isParentReference(entry)) return { input: entry.input, ok: false, error: entry.error };
    if (entry.repo && entry.repo.toLowerCase() !== this.deps.hubRepo.toLowerCase()) {
      return {
        input: entry.input,
        ok: false,
        error: `that issue lives in ${entry.repo}, and this control plane runs ${this.deps.hubRepo}`,
      };
    }
    try {
      const snapshot = await this.deps.loadSnapshot(entry.number);
      const result = loadRunModel(snapshot);
      if (!result.ok) {
        return { input: entry.input, number: entry.number, ok: false, error: result.errors.join("; ") };
      }
      const summary: ParentSummary = {
        number: result.model.parentNumber,
        title: result.model.title,
        subIssues: result.model.items.length,
        completedSubIssues: result.model.items.filter((item) => item.admission === "done").length,
      };
      this.added.set(summary.number, summary);
      this.forgetOldestAdded();
      this.note("note", undefined, `added #${summary.number} ${summary.title} to the parent list`);
      this.publish();
      return { input: entry.input, number: summary.number, title: summary.title, ok: true };
    } catch (cause) {
      return { input: entry.input, number: entry.number, ok: false, error: messageOf(cause) };
    }
  }

  private forgetOldestAdded(): void {
    for (const number of [...this.added.keys()].slice(0, this.added.size - ADDED_PARENT_LIMIT)) {
      this.added.delete(number);
    }
  }

  async queueRuns(parents: readonly number[], cap: number): Promise<void> {
    const wanted = parents.map((parent) => positiveInteger(parent, "parent"));
    if (wanted.length === 0) throw new OperatorError("pick at least one parent to queue");
    const parentCap = positiveInteger(cap, "cap");
    const running = wanted.filter((parent) => this.slots.isRunning(parent));
    if (running.length > 0) {
      throw new OperatorError(`${parentList(running)} is already running — it cannot be queued until its run settles`);
    }
    this.changeQueue(() => {
      this.queue.setParentCap(parentCap);
      this.queue.add(wanted);
    });
    await Promise.all(this.startQueued());
    const waiting = this.queue.parents();
    this.note("note", undefined, this.queuedNote(waiting, parentCap));
    this.publish();
  }

  private queuedNote(waiting: readonly number[], parentCap: number): string {
    if (waiting.length === 0) return "queue empty — nothing waits behind the runs in flight";
    const queued = `queued ${parentList(waiting)} to run next, cap ${parentCap}`;
    return this.queuePaused ? `${queued} — the queue is paused, resume it to start them` : queued;
  }

  removeQueued(parent: number): void {
    if (this.startingFromQueue.has(parent) && !this.queue.parents().includes(parent)) {
      this.removedWhileStarting.add(parent);
    } else {
      this.changeQueue(() => this.queue.remove(parent));
    }
    this.note("note", undefined, `#${parent} removed from the queue`);
    this.publish();
  }

  reorderQueue(parents: readonly number[]): void {
    this.changeQueue(() => this.queue.reorder(parents));
    this.note("note", undefined, `queue reordered — ${parentList(parents)}`);
    this.publish();
  }

  setQueueMode(mode: QueueMode, maxParallel?: number): void {
    this.changeQueue(() => this.queue.setMode(mode, maxParallel));
    const settings = this.queue.settings();
    this.note(
      "note",
      undefined,
      settings.mode === "parallel" ? `queue runs up to ${settings.maxParallel} parents at once` : "queue runs one parent at a time",
    );
    void this.startQueued();
    this.publish();
  }

  clearQueue(): void {
    this.changeQueue(() => this.queue.clear());
    for (const parent of this.startingFromQueue) this.removedWhileStarting.add(parent);
    this.note("note", undefined, "queue cleared");
    this.publish();
  }

  resumeQueue(): void {
    this.queuePaused = false;
    this.note("note", undefined, "queue resumed");
    void this.startQueued();
    this.publish();
  }

  /** Current state; bumps `rev` when it differs from the last one handed out, so `rev` is never stale. */
  state(): UiState {
    const body = this.stateBody();
    const json = JSON.stringify(body);
    if (json !== this.lastStateJson) {
      this.lastStateJson = json;
      this.revision += 1;
    }
    return { ...body, rev: this.revision, boot: this.boot };
  }

  private stateBody(): Omit<UiState, "rev" | "boot"> {
    const quietFor = this.quietResolver();
    const runs = this.slots.all().map((slot) => slot.view(this.deps.hubRepo, quietFor));
    const primary = this.slots.primary();
    const engine = primary?.engine;
    const views = engine ? engine.view() : [];
    return {
      version: 2,
      stages: uiStageChain(activeStageChain()),
      mode: this.deps.mode,
      hubRepo: this.deps.hubRepo,
      startCap: this.deps.startCap,
      preselectedParent: this.deps.preselectedParent,
      parent: primary ? uiParent(this.deps.hubRepo, primary.model) : undefined,
      cap: engine?.cap() ?? this.deps.startCap,
      paused: engine?.newStartsArePaused() ?? false,
      started: engine !== undefined,
      complete: engine?.complete() ?? false,
      running: engine?.running() ?? 0,
      stalled: engine?.stalled(),
      hold: uiHold(engine),
      canStart: this.startRefusal() === undefined,
      featureVerify: primary?.featureVerify() ?? idleFeatureVerify(),
      polish: primary?.polish() ?? idlePolish(),
      canReset: this.deps.reset !== undefined && !this.slots.anyLive() && !this.resetting,
      resetting: this.resetting,
      phaseCounts: phaseCounts(views),
      queue: [...this.queue.parents()],
      queueCap: this.queue.settings().parentCap,
      queueSettings: this.queueSettings(),
      runs,
      globalRunning: runs.reduce((sum, run) => sum + run.running, 0),
      items: uiItems(this.deps.hubRepo, views, (view) => quietFor(view, primary?.session.attempts)),
      feed: [...this.feed],
    };
  }

  private quietResolver(): QuietFor {
    const nowMs = this.deps.now().getTime();
    const timeoutSeconds = this.deps.idleTimeoutSeconds ?? IDLE_TIMEOUT_DEFAULT;
    return (view, attempts) =>
      quietInfo({ view, lastOutputAt: attempts?.lastOutputAt?.(view.number), nowMs, timeoutSeconds });
  }

  private queueSettings(): UiQueueSettings {
    const settings = this.queue.settings();
    return { ...settings, globalCap: this.deps.globalCap?.get() ?? settings.globalCap, paused: this.queuePaused };
  }

  async startRun(request: StartRunRequest): Promise<void> {
    const parent = positiveInteger(request.parent, "parent");
    const cap = positiveInteger(request.cap, "cap");
    const refusal = this.startRefusal();
    if (refusal) throw new OperatorError(refusal);
    if (this.slots.isRunning(parent)) {
      throw new OperatorError(`#${parent} is already running — wait for its run to settle before starting it again`);
    }
    const wasQueued = this.queue.parents().includes(parent);
    if (wasQueued) this.changeQueue(() => this.takeQueued(parent));
    try {
      await this.launch(parent, cap);
    } catch (cause) {
      if (wasQueued && this.settleQueuedStart(parent)) this.savingQueue(() => this.queue.requeueFront(parent));
      this.publish();
      throw cause;
    }
    if (wasQueued) this.confirmQueuedStart(parent);
    void this.startQueued();
    this.publish();
  }

  private startRefusal(): string | undefined {
    if (this.resetting) return "a reset is in flight — it would garbage-collect this run's containers, so wait for it";
    const inFlight = this.slots.itemsInFlightRuns();
    const settings = this.queue.settings();
    if (settings.mode === "sequential") {
      return inFlight > 0 ? "a run is already in flight — queue it instead" : undefined;
    }
    if (inFlight < settings.maxParallel) return undefined;
    return `${inFlight} runs are already in flight, the parallel limit of ${settings.maxParallel} — queue it instead`;
  }

  private launch(parent: number, cap: number): Promise<void> {
    return this.slots.whileStarting(parent, () => this.openSlot(parent, cap));
  }

  private async openSlot(parent: number, cap: number): Promise<void> {
    const snapshot = await this.deps.loadSnapshot(parent);
    const result = loadRunModel(snapshot);
    if (!result.ok) {
      throw new OperatorError(`#${parent} does not satisfy the publish contract:\n- ${result.errors.join("\n- ")}`);
    }
    const note = this.noteFor(parent);
    note("note", undefined, `${this.deps.mode} run starting — #${parent} ${result.model.title}, cap ${cap}`);
    const session = await this.deps.startSession({
      model: result.model,
      workerCap: cap,
      sink: {
        warn: (itemNumber, message) => note("warn", itemNumber, message),
        note: (itemNumber, message) => note("note", itemNumber, message),
      },
    });
    const slot = new ParentRunSlot(result.model, session);
    this.slots.replace(slot);
    session.finished?.then(
      () => this.settleSlot(slot, undefined),
      (cause: unknown) => this.settleSlot(slot, messageOf(cause)),
    );
    note("note", undefined, `${this.deps.mode} run started — #${parent} ${result.model.title}, cap ${cap}`);
  }

  private settleSlot(slot: ParentRunSlot, failure: string | undefined): void {
    slot.markSettled();
    if (!this.slots.isCurrent(slot)) return;
    if (failure) this.noteFor(slot.parentNumber)("warn", undefined, `the run ended with an error: ${failure}`);
    void this.startQueued();
    this.publish();
  }

  private startQueued(): Promise<void>[] {
    const launches: Promise<void>[] = [];
    const taken: number[] = [];
    while (!this.queuePaused && !this.resetting) {
      const next = this.queue.next(this.slots.itemsInFlightRuns());
      if (next === undefined || this.slots.isRunning(next)) break;
      if (!this.savingQueue(() => this.takeQueued(next))) break;
      const takenBefore = [...taken];
      taken.push(next);
      const launched = this.launch(next, this.queue.settings().parentCap)
        .then(
          () => this.confirmQueuedStart(next),
          (cause: unknown) => this.holdFailedStart(next, takenBefore, cause),
        )
        .finally(() => this.publish());
      launches.push(launched);
    }
    return launches;
  }

  private takeQueued(parent: number): void {
    this.queue.take(parent);
    this.startingFromQueue.add(parent);
  }

  private settleQueuedStart(parent: number): boolean {
    this.startingFromQueue.delete(parent);
    return !this.removedWhileStarting.delete(parent);
  }

  private confirmQueuedStart(parent: number): void {
    if (this.settleQueuedStart(parent)) return;
    this.noteFor(parent)(
      "note",
      undefined,
      `#${parent} started before it left the queue — stop it from its tab if it should not run`,
    );
  }

  private changeQueue(change: () => void): void {
    try {
      change();
    } catch (cause) {
      throw new OperatorError(this.pauseOnSaveFailure(cause));
    }
  }

  private savingQueue(change: () => void): boolean {
    try {
      change();
      return true;
    } catch (cause) {
      this.pauseOnSaveFailure(cause);
      return false;
    }
  }

  private pauseOnSaveFailure(cause: unknown): string {
    this.queuePaused = true;
    const message = `could not save the queue: ${messageOf(cause)} — the queue is paused`;
    this.note("warn", undefined, message);
    return message;
  }

  private holdFailedStart(parent: number, takenBefore: readonly number[], cause: unknown): void {
    const reason = messageOf(cause);
    if (!this.settleQueuedStart(parent)) {
      this.noteFor(parent)("warn", undefined, `queued run #${parent} could not start: ${reason} — it was removed from the queue, so it stays out`);
      return;
    }
    this.queuePaused = true;
    const requeued = this.savingQueue(() => this.queue.requeueFront(parent, takenBefore));
    const nextStep = requeued
      ? `resume it or remove #${parent}`
      : `re-queue #${parent} by hand once the queue file can be saved`;
    this.noteFor(parent)("warn", undefined, `queued run #${parent} could not start: ${reason} — the queue is paused; ${nextStep}`);
  }

  async resetPlan(parentNumber: number): Promise<ResetPlan> {
    const parent = positiveInteger(parentNumber, "parent");
    return this.holdingReset((ops) => ops.plan(parent));
  }

  async resetApply(parentNumber: number): Promise<ResetReport> {
    const parent = positiveInteger(parentNumber, "parent");
    return this.holdingReset(async (ops) => {
      this.note("note", undefined, `reset #${parent} — working; the control plane cannot answer until it finishes`);
      this.publish();
      const report = await ops.apply(parent);
      const failures = [...report.gc.failures, ...report.failures];
      this.note(
        failures.length > 0 ? "warn" : "note",
        undefined,
        `reset #${parent} — ${report.gc.containers.length} container(s), ${report.gc.worktrees.length} worktree(s),` +
          ` lock ${report.lockReclaimed ? "reclaimed" : "untouched"}, ${report.labelled.length} item(s) relabelled,` +
          ` ${report.deletedBranches.length} branch(es) deleted` +
          (failures.length > 0 ? `, ${failures.length} failure(s)` : ""),
      );
      for (const failure of failures) this.note("warn", undefined, `reset: ${failure}`);
      return report;
    });
  }

  private async holdingReset<T>(work: (ops: ResetOps) => Promise<T>): Promise<T> {
    const ops = this.deps.reset;
    if (!ops) throw new OperatorError("reset is only available in real mode — a dry run leaves nothing behind to clear");
    if (this.slots.anyLive()) {
      throw new OperatorError(
        "a run is still in flight or settling — stop it before resetting, or reset would garbage-collect its own containers",
      );
    }
    if (this.resetting) throw new OperatorError("a reset is already in flight");
    this.resetting = true;
    this.publish();
    try {
      return await work(ops);
    } finally {
      this.resetting = false;
      this.publish();
    }
  }

  attempts(itemNumber?: number): AttemptRecord[] {
    if (itemNumber === undefined) {
      return this.slots.all().flatMap((slot) => slot.session.attempts?.list() ?? []);
    }
    return this.slots.forAttempts(itemNumber)?.session.attempts?.list(itemNumber) ?? [];
  }

  attemptLog(id: string, from = 0): AttemptChunk {
    const parsed = parseAttemptId(id);
    if (!parsed) throw new OperatorError(`${id} is not an attempt id (item-stage-attempt)`);
    const slot = this.slots.forAttempts(parsed.itemNumber);
    if (!slot) throw new OperatorError(`no run on this control plane owns attempt ${id}`);
    const reader = slot.session.attempts;
    if (!reader) throw new OperatorError("this run keeps no agent transcripts — only a real run writes them");
    return reader.read(id, from);
  }

  cancelItem(itemNumber: number): void {
    this.slots.requireForItem(itemNumber).engine.cancelItem(itemNumber);
    this.publish();
  }

  retryItem(itemNumber: number): void {
    this.slots.requireForItem(itemNumber).engine.retryItem(itemNumber);
    this.publish();
  }

  commentItem(itemNumber: number, body: string): void {
    this.slots.requireForItem(itemNumber).engine.commentItem(itemNumber, body);
    this.publish();
  }

  pause(): void {
    for (const slot of this.slots.requireLive()) slot.engine.pauseNewStarts();
    this.note("note", undefined, "new starts paused — items already in flight keep advancing");
    this.publish();
  }

  resume(): void {
    for (const slot of this.slots.requireLive()) slot.engine.resumeNewStarts();
    this.note("note", undefined, "new starts resumed");
    this.publish();
  }

  pauseRun(parent: number): void {
    this.slots.require(parent).engine.pauseNewStarts();
    this.noteFor(parent)("note", undefined, `new starts paused for #${parent} — items already in flight keep advancing`);
    this.publish();
  }

  resumeRun(parent: number): void {
    this.slots.require(parent).engine.resumeNewStarts();
    this.noteFor(parent)("note", undefined, `new starts resumed for #${parent}`);
    this.publish();
  }

  setRunCap(parent: number, cap: number): void {
    const value = positiveInteger(cap, "cap");
    this.slots.require(parent).engine.setWorkerCap(value);
    this.noteFor(parent)("note", undefined, `worker cap for #${parent} set to ${value}`);
    this.publish();
  }

  stopRun(parent: number): void {
    this.slots.require(parent).stop();
    this.noteFor(parent)("note", undefined, `#${parent} stopped — no new stages start for it`);
    this.publish();
  }

  setCap(value: number): void {
    const globalCap = positiveInteger(value, "cap");
    this.changeQueue(() => this.queue.setGlobalCap(globalCap));
    this.deps.globalCap?.set(globalCap);
    this.note("note", undefined, `global worker cap set to ${globalCap} across every parent`);
    this.publish();
  }

  tick(): void {
    for (const slot of this.slots.all()) {
      if (!slot.settled()) slot.session.tick();
    }
    void this.startQueued();
    this.publish();
  }

  stop(): void {
    for (const slot of this.slots.all()) slot.stop();
    this.listeners.clear();
  }

  noteError(message: string): void {
    this.note("warn", undefined, message);
  }

  private noteFor(parentNumber: number): SlotNote {
    return (kind, itemNumber, message) => this.note(kind, itemNumber, message, parentNumber);
  }

  private note(kind: FeedKind, itemNumber: number | undefined, message: string, parentNumber?: number): void {
    const line: UiFeedLine = { at: this.deps.now().toISOString(), kind, itemNumber, parentNumber, message };
    this.feed.push(line);
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
    this.emit({ kind: "feed", line });
  }

  private publish(): void {
    for (const slot of this.slots.all()) slot.noteChanges(this.noteFor(slot.parentNumber));
    const state = this.state();
    if (state.rev === this.lastEmittedRevision) return;
    this.lastEmittedRevision = state.rev;
    this.emit({ kind: "state", state });
  }

  private emit(event: UiEvent): void {
    const dead: ((event: UiEvent) => void)[] = [];
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        dead.push(listener);
      }
    }
    if (dead.length === 0) return;
    for (const listener of dead) this.listeners.delete(listener);
    this.note("note", undefined, `dropped ${dead.length} event subscriber(s) that could no longer be written to`);
  }
}
