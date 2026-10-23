import { describe, expect, it } from "vitest";
import { OperatorError } from "../../src/engine/operatorError.js";
import { SlotBroker, type BrokerSlots, type Refillable } from "../../src/ui/slotBroker.js";
import { harness, spawnOrder, testItem, testModel } from "../fixtures.js";

function manualScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (work: () => void) => {
      queue.push(work);
    },
    pending: () => queue.length,
    flush: () => {
      while (queue.length > 0) queue.shift()?.();
    },
  };
}

class FakeEngine {
  held = 0;
  refills = 0;
  readonly slots: BrokerSlots;
  constructor(
    broker: SlotBroker,
    private readonly demand: number,
  ) {
    this.slots = broker.slotsFor(this);
  }
  refill(): void {
    this.refills += 1;
    while (this.held < this.demand && this.slots.tryAcquire()) this.held += 1;
  }
  finish(): void {
    this.held -= 1;
    this.slots.release();
  }
}

function brokerWith(cap: number) {
  const scheduler = manualScheduler();
  return { broker: new SlotBroker(cap, { schedule: scheduler.schedule }), ...scheduler };
}

describe("slot broker", () => {
  it("grants up to the global cap", () => {
    const { broker } = brokerWith(2);
    const engine = new FakeEngine(broker, 5);
    engine.refill();

    expect(engine.held).toBe(2);
    expect(broker.used()).toBe(2);
  });

  it("defers the refill out of release and coalesces releases into one round", () => {
    const { broker, pending, flush } = brokerWith(2);
    const first = new FakeEngine(broker, 2);
    first.refill();
    const refillsBefore = first.refills;

    first.finish();
    first.finish();

    expect(first.refills).toBe(refillsBefore);
    expect(pending()).toBe(1);
    flush();
    expect(first.held).toBe(2);
  });

  it("reserves a freed slot for the refill round instead of the releasing engine", () => {
    const { broker, flush } = brokerWith(1);
    const first = new FakeEngine(broker, 1);
    const second = new FakeEngine(broker, 1);
    first.refill();
    second.refill();

    first.finish();
    first.refill();
    expect(first.held).toBe(0);

    flush();
    expect(second.held).toBe(1);
  });

  it("alternates competing engines across rounds", () => {
    const { broker, flush } = brokerWith(1);
    const first = new FakeEngine(broker, 3);
    const second = new FakeEngine(broker, 3);
    first.refill();
    const winners: string[] = [];

    for (let round = 0; round < 4; round += 1) {
      const holder = first.held > 0 ? first : second;
      holder.finish();
      flush();
      winners.push(first.held > 0 ? "first" : "second");
    }

    expect(winners).toEqual(["second", "first", "second", "first"]);
  });

  it("returns outstanding slots on detach and ignores the detached handle afterwards", () => {
    const { broker, flush } = brokerWith(2);
    const leaving = new FakeEngine(broker, 2);
    const staying = new FakeEngine(broker, 2);
    leaving.refill();

    leaving.slots.detach();
    expect(broker.used()).toBe(0);
    expect(leaving.slots.tryAcquire()).toBe(false);
    leaving.slots.release();
    flush();

    expect(staying.held).toBe(2);
    expect(leaving.refills).toBe(1);
  });

  it("throws on a release with nothing outstanding", () => {
    const { broker } = brokerWith(1);
    const engine = new FakeEngine(broker, 1);

    expect(() => engine.slots.release()).toThrow();
  });

  it("refills when the cap rises and never preempts when it falls", () => {
    const { broker, flush } = brokerWith(1);
    const engine = new FakeEngine(broker, 3);
    engine.refill();

    broker.setCap(3);
    flush();
    expect(engine.held).toBe(3);

    broker.setCap(1);
    expect(broker.used()).toBe(3);
    engine.finish();
    flush();
    expect(engine.held).toBe(2);
    expect(broker.cap()).toBe(1);
  });

  it("rejects a cap that is not a positive integer", () => {
    expect(() => new SlotBroker(0)).toThrow(OperatorError);
    const { broker } = brokerWith(1);
    expect(() => broker.setCap(1.5)).toThrow(OperatorError);
  });

  it("finishes the round for the other engines and rethrows when one engine's refill throws", () => {
    const { broker, flush } = brokerWith(2);
    const holder = new FakeEngine(broker, 2);
    let attempts = 0;
    const broken = broker.slotsFor({
      refill: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("refill blew up");
      },
    });
    const waiting = new FakeEngine(broker, 2);
    holder.refill();

    holder.finish();
    holder.finish();
    expect(flush).toThrow("refill blew up");

    expect(attempts).toBe(1);
    expect(broker.used()).toBe(2);
    expect(waiting.held).toBe(1);
    waiting.finish();
    flush();
    expect(broker.used()).toBe(2);
    expect(attempts).toBe(2);
  });

  it("reports a failed refill per engine instead of throwing when given a handler", () => {
    const scheduler = manualScheduler();
    const reported: [Refillable, unknown][] = [];
    const broker = new SlotBroker(1, {
      schedule: scheduler.schedule,
      onRefillError: (engine, cause) => reported.push([engine, cause]),
    });
    const holder = new FakeEngine(broker, 1);
    const failure = new Error("refill blew up");
    const brokenEngine: Refillable = {
      refill: () => {
        throw failure;
      },
    };
    broker.slotsFor(brokenEngine);
    holder.refill();

    holder.finish();
    expect(scheduler.flush).not.toThrow();
    expect(reported).toEqual([[brokenEngine, failure]]);
  });

  it("keeps the rotation position when the last granted engine detaches", () => {
    const { broker, flush } = brokerWith(1);
    const first = new FakeEngine(broker, 1);
    const second = new FakeEngine(broker, 1);
    const third = new FakeEngine(broker, 1);
    second.refill();

    second.slots.detach();
    flush();

    expect(third.held).toBe(1);
    expect(first.held).toBe(0);
  });

  it("refills on a real microtask by default", async () => {
    const broker = new SlotBroker(1);
    const engine = new FakeEngine(broker, 1);
    engine.refill();
    engine.finish();
    expect(engine.held).toBe(0);

    await Promise.resolve();
    expect(engine.held).toBe(1);
  });

  it("runs two engines one stage at a time and alternates parents", () => {
    const { broker, flush } = brokerWith(1);
    const model = () => testModel([testItem(17, "api"), testItem(18, "api")]);
    let first: ReturnType<typeof harness> | undefined;
    let second: ReturnType<typeof harness> | undefined;
    first = harness(model(), 2, broker.slotsFor({ refill: () => first?.engine.refill() }));
    second = harness(model(), 2, broker.slotsFor({ refill: () => second?.engine.refill() }));
    first.engine.start();
    second.engine.start();

    expect(spawnOrder(first.adapters.log)).toEqual(["spawn develop #17"]);
    expect(spawnOrder(second.adapters.log)).toEqual([]);

    first.complete(17, "develop");
    flush();
    expect(spawnOrder(first.adapters.log)).toHaveLength(1);
    expect(spawnOrder(second.adapters.log)).toEqual(["spawn develop #17"]);

    second.complete(17, "develop");
    flush();
    expect(spawnOrder(first.adapters.log)).toHaveLength(2);
    expect(spawnOrder(second.adapters.log)).toHaveLength(1);
    expect(first.engine.running() + second.engine.running()).toBe(1);
  });
});
