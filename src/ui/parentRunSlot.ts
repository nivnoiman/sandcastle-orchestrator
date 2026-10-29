import { stallParts } from "../cli/report.js";
import type { Engine, ItemView } from "../engine/engine.js";
import { OperatorError } from "../engine/operatorError.js";
import type { QuietInfo } from "./quiet.js";
import type { RunModel } from "../model/runModel.js";
import type { AttemptChunk, AttemptRecord } from "../real/attemptLog.js";
import {
  featureVerifyLabel,
  idleFeatureVerify,
  idlePolish,
  phaseCounts,
  polishLabel,
  uiHold,
  uiItems,
  uiParent,
  type IssueUrlOf,
  type FeatureVerifyStatus,
  type FeedKind,
  type PolishStatus,
  type UiRun,
} from "./state.js";

export type QuietFor = (view: ItemView, attempts: AttemptReader | undefined) => QuietInfo | undefined;

export interface AttemptReader {
  list(itemNumber?: number): AttemptRecord[];
  read(id: string, from?: number): AttemptChunk;
  lastOutputAt?(itemNumber: number): number | undefined;
}

export interface Session {
  engine: Engine;
  featureVerify?: () => FeatureVerifyStatus;
  polish?: () => PolishStatus;
  finished?: Promise<void>;
  attempts?: AttemptReader;
  tick(): void;
  stop(): void;
}

export type SlotNote = (kind: FeedKind, itemNumber: number | undefined, message: string) => void;

export const SLOT_LIMIT = 10;

export class ParentRunSlot {
  private finishedSettled = false;
  private stopped = false;
  private lastStallSignature = "";
  private lastVerifyPhase: FeatureVerifyStatus["phase"] = "idle";
  private lastPolishPhase: PolishStatus["phase"] = "idle";

  constructor(
    readonly model: RunModel,
    readonly session: Session,
  ) {}

  get parentNumber(): number {
    return this.model.parentNumber;
  }

  get engine(): Engine {
    return this.session.engine;
  }

  settled(): boolean {
    if (this.session.finished !== undefined) return this.finishedSettled;
    return this.stopped || this.engine.complete();
  }

  markSettled(): void {
    this.finishedSettled = true;
  }

  itemsInFlight(): boolean {
    return !this.stopped && !this.settled() && !this.engine.complete();
  }

  owns(itemNumber: number): boolean {
    return this.model.items.some((item) => item.number === itemNumber);
  }

  stop(): void {
    this.stopped = true;
    this.session.stop();
  }

  featureVerify(): FeatureVerifyStatus {
    const read = this.session.featureVerify;
    return read ? read() : idleFeatureVerify();
  }

  polish(): PolishStatus {
    const read = this.session.polish;
    return read ? read() : idlePolish();
  }

  noteChanges(note: SlotNote): void {
    this.noteStall(note);
    this.noteFeatureVerify(note);
    this.notePolish(note);
  }

  view(urlOf: IssueUrlOf, quietFor?: QuietFor): UiRun {
    const views = this.engine.view();
    return {
      parent: uiParent(urlOf, this.model),
      cap: this.engine.cap(),
      paused: this.engine.newStartsArePaused(),
      started: true,
      complete: this.engine.complete(),
      settled: this.settled(),
      running: this.engine.running(),
      stalled: this.engine.stalled(),
      hold: uiHold(this.engine),
      featureVerify: this.featureVerify(),
      polish: this.polish(),
      phaseCounts: phaseCounts(views),
      items: uiItems(urlOf, views, (item) => quietFor?.(item, this.session.attempts)),
    };
  }

  private noteStall(note: SlotNote): void {
    const summary = this.engine.stalled();
    const signature = summary ? JSON.stringify(summary) : "";
    if (signature === this.lastStallSignature) return;
    this.lastStallSignature = signature;
    if (summary) note("stall", undefined, `${stallParts(summary)} — nothing advances until a human acts`);
  }

  private noteFeatureVerify(note: SlotNote): void {
    const status = this.featureVerify();
    if (status.phase === this.lastVerifyPhase) return;
    this.lastVerifyPhase = status.phase;
    if (status.phase === "idle") return;
    note(status.phase === "red" ? "warn" : "note", undefined, featureVerifyLabel(status));
  }

  private notePolish(note: SlotNote): void {
    const status = this.polish();
    if (status.phase === this.lastPolishPhase) return;
    this.lastPolishPhase = status.phase;
    if (status.phase === "idle") return;
    note(status.phase === "reverted" ? "warn" : "note", undefined, polishLabel(status));
  }
}

export class ParentRunSlots {
  private readonly slots = new Map<number, ParentRunSlot>();
  private readonly starting = new Set<number>();

  async whileStarting(parent: number, work: () => Promise<void>): Promise<void> {
    this.starting.add(parent);
    try {
      await work();
    } finally {
      this.starting.delete(parent);
    }
  }

  all(): ParentRunSlot[] {
    return [...this.slots.values()];
  }

  get(parent: number): ParentRunSlot | undefined {
    return this.slots.get(parent);
  }

  isCurrent(slot: ParentRunSlot): boolean {
    return this.slots.get(slot.parentNumber) === slot;
  }

  primary(): ParentRunSlot | undefined {
    const slots = this.all();
    return slots.filter((slot) => !slot.settled()).at(-1) ?? slots.at(-1);
  }

  isRunning(parent: number): boolean {
    if (this.starting.has(parent)) return true;
    const slot = this.slots.get(parent);
    return slot !== undefined && !slot.settled();
  }

  anyLive(): boolean {
    if (this.starting.size > 0) return true;
    return this.all().some((slot) => !slot.settled());
  }

  itemsInFlightRuns(): number {
    return this.starting.size + this.all().filter((slot) => slot.itemsInFlight()).length;
  }

  replace(slot: ParentRunSlot): void {
    const previous = this.slots.get(slot.parentNumber);
    if (previous) {
      previous.stop();
      this.slots.delete(slot.parentNumber);
    }
    this.slots.set(slot.parentNumber, slot);
    this.forgetOldestSettled(slot);
  }

  forItem(itemNumber: number): ParentRunSlot | undefined {
    return this.all().reverse().find((slot) => slot.owns(itemNumber));
  }

  forAttempts(number: number): ParentRunSlot | undefined {
    return this.forItem(number) ?? this.slots.get(number);
  }

  require(parent: number): ParentRunSlot {
    const slot = this.slots.get(parent);
    if (!slot) throw new OperatorError(`#${parent} has no run on this control plane`);
    return slot;
  }

  requireForItem(itemNumber: number): ParentRunSlot {
    if (this.slots.size === 0) throw new OperatorError("no run has started yet");
    const slot = this.forItem(itemNumber);
    if (!slot) throw new OperatorError(`#${itemNumber} is not an item of any run on this control plane`);
    return slot;
  }

  requireLive(): ParentRunSlot[] {
    if (this.slots.size === 0) throw new OperatorError("no run has started yet");
    const live = this.all().filter((slot) => !slot.settled());
    if (live.length === 0) throw new OperatorError("no run is live — every run has settled");
    return live;
  }

  private forgetOldestSettled(newest: ParentRunSlot): void {
    for (const slot of this.all()) {
      if (this.slots.size <= SLOT_LIMIT) return;
      if (slot === newest || !slot.settled()) continue;
      slot.stop();
      this.slots.delete(slot.parentNumber);
    }
  }
}
