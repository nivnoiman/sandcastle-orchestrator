import { describe, expect, it } from "vitest";
import { OperatorError } from "../../src/engine/operatorError.js";
import { DEFAULT_MAX_PARALLEL, RunQueue, type QueueFile } from "../../src/ui/runQueue.js";

const defaults = { globalCap: 4, parentCap: 2 };

function queueWith(initial?: QueueFile) {
  const saved: QueueFile[] = [];
  const queue = new RunQueue(initial, defaults, (file) => saved.push(file));
  return { queue, saved };
}

describe("RunQueue", () => {
  it("adds parents, skipping duplicates and persisting", () => {
    const { queue, saved } = queueWith();
    expect(queue.add([5, 7])).toEqual([5, 7]);
    expect(queue.add([7, 9, 9])).toEqual([9]);
    expect(queue.parents()).toEqual([5, 7, 9]);
    expect(saved.at(-1)).toEqual({ version: 1, mode: "sequential", maxParallel: DEFAULT_MAX_PARALLEL, globalCap: 4, parentCap: 2, parents: [5, 7, 9] });
  });

  it("rejects invalid parents without persisting", () => {
    const { queue, saved } = queueWith();
    expect(() => queue.add([3, 0])).toThrow(OperatorError);
    expect(() => queue.add([1.5])).toThrow(OperatorError);
    expect(queue.parents()).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("removes queued parents and throws on unknown", () => {
    const { queue, saved } = queueWith();
    queue.add([1, 2]);
    queue.remove(1);
    expect(queue.parents()).toEqual([2]);
    expect(saved.at(-1)?.parents).toEqual([2]);
    expect(() => queue.remove(8)).toThrow(OperatorError);
  });

  it("reorders only by exact permutation", () => {
    const { queue, saved } = queueWith();
    queue.add([1, 2, 3]);
    const before = saved.length;
    expect(() => queue.reorder([3, 1])).toThrow(OperatorError);
    expect(() => queue.reorder([3, 1, 1])).toThrow(OperatorError);
    expect(() => queue.reorder([3, 1, 4])).toThrow(OperatorError);
    expect(saved.length).toBe(before);
    queue.reorder([3, 1, 2]);
    expect(queue.parents()).toEqual([3, 1, 2]);
    expect(saved.at(-1)?.parents).toEqual([3, 1, 2]);
  });

  it("clears the queue", () => {
    const { queue, saved } = queueWith();
    queue.add([1, 2]);
    queue.clear();
    expect(queue.parents()).toEqual([]);
    expect(saved.at(-1)?.parents).toEqual([]);
  });

  it("offers the head sequentially only when nothing runs", () => {
    const { queue } = queueWith();
    expect(queue.next(0)).toBeUndefined();
    queue.add([4, 6]);
    expect(queue.next(0)).toBe(4);
    expect(queue.next(1)).toBeUndefined();
    expect(queue.parents()).toEqual([4, 6]);
  });

  it("offers the head in parallel below maxParallel", () => {
    const { queue, saved } = queueWith();
    queue.add([4, 6]);
    queue.setMode("parallel");
    expect(queue.settings().maxParallel).toBe(2);
    expect(queue.next(1)).toBe(4);
    expect(queue.next(2)).toBeUndefined();
    queue.setMode("parallel", 3);
    expect(queue.next(2)).toBe(4);
    expect(saved.at(-1)).toMatchObject({ mode: "parallel", maxParallel: 3 });
  });

  it("keeps maxParallel when setMode omits it", () => {
    const { queue, saved } = queueWith();
    queue.setMode("parallel", 5);
    queue.setMode("sequential");
    queue.setMode("parallel");
    expect(queue.settings()).toMatchObject({ mode: "parallel", maxParallel: 5 });
    expect(saved.at(-1)).toMatchObject({ mode: "parallel", maxParallel: 5 });
  });

  it("leaves state unchanged when persisting fails", () => {
    const queue = new RunQueue(undefined, defaults, () => {
      throw new Error("disk full");
    });
    expect(() => queue.add([1])).toThrow("disk full");
    expect(() => queue.setMode("parallel", 4)).toThrow("disk full");
    expect(queue.parents()).toEqual([]);
    expect(queue.settings()).toMatchObject({ mode: "sequential", maxParallel: DEFAULT_MAX_PARALLEL });
  });

  it("takes a starting parent out of the queue", () => {
    const { queue, saved } = queueWith();
    queue.add([4, 6]);
    queue.take(4);
    expect(queue.parents()).toEqual([6]);
    expect(saved.at(-1)?.parents).toEqual([6]);
    expect(() => queue.take(4)).toThrow(OperatorError);
  });

  it("puts a parent back at the front, moving it there if already queued", () => {
    const { queue, saved } = queueWith();
    queue.add([4, 6]);
    queue.requeueFront(9);
    expect(queue.parents()).toEqual([9, 4, 6]);
    expect(saved.at(-1)?.parents).toEqual([9, 4, 6]);
    queue.requeueFront(6);
    expect(queue.parents()).toEqual([6, 9, 4]);
    expect(() => queue.requeueFront(0)).toThrow(OperatorError);
  });

  it("puts a parent back right behind the earlier ones still queued", () => {
    const { queue } = queueWith();
    queue.add([4, 6]);
    queue.requeueFront(9, [4]);
    expect(queue.parents()).toEqual([4, 9, 6]);
    queue.requeueFront(2, [7]);
    expect(queue.parents()).toEqual([2, 4, 9, 6]);
  });

  it("validates settings without persisting", () => {
    const { queue, saved } = queueWith();
    expect(() => queue.setMode("parallel", 0)).toThrow(OperatorError);
    expect(() => queue.setMode("bogus" as "parallel")).toThrow(OperatorError);
    expect(() => queue.setGlobalCap(-1)).toThrow(OperatorError);
    expect(() => queue.setParentCap(2.5)).toThrow(OperatorError);
    expect(saved).toEqual([]);
    queue.setGlobalCap(6);
    queue.setParentCap(3);
    expect(saved.at(-1)).toMatchObject({ globalCap: 6, parentCap: 3 });
  });

  it("restores state from a loaded file", () => {
    const file: QueueFile = { version: 1, mode: "parallel", maxParallel: 3, globalCap: 8, parentCap: 1, parents: [9, 2] };
    const { queue } = queueWith(file);
    expect(queue.parents()).toEqual([9, 2]);
    expect(queue.settings()).toEqual({ mode: "parallel", maxParallel: 3, globalCap: 8, parentCap: 1 });
  });
});
