import { describe, expect, it } from "vitest";
import { VerifyMutex } from "../../src/real/verifyMutex.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

describe("VerifyMutex", () => {
  it("runs one work at a time, in FIFO order", async () => {
    const mutex = new VerifyMutex();
    const started: string[] = [];
    const first = deferred<string>();
    const second = deferred<string>();
    const runFirst = mutex.runExclusive(() => {
      started.push("first");
      return first.promise;
    });
    const runSecond = mutex.runExclusive(() => {
      started.push("second");
      return second.promise;
    });
    const runThird = mutex.runExclusive(async () => {
      started.push("third");
      return "third";
    });
    await flush();
    expect(started).toEqual(["first"]);
    expect(mutex.busy()).toBe(true);
    expect(mutex.waiting()).toBe(2);

    first.resolve("first");
    expect(await runFirst).toBe("first");
    await flush();
    expect(started).toEqual(["first", "second"]);
    expect(mutex.waiting()).toBe(1);

    second.resolve("second");
    expect(await runSecond).toBe("second");
    expect(await runThird).toBe("third");
    expect(started).toEqual(["first", "second", "third"]);
    expect(mutex.busy()).toBe(false);
    expect(mutex.waiting()).toBe(0);
  });

  it("releases the lock when the work rejects", async () => {
    const mutex = new VerifyMutex();
    const failing = mutex.runExclusive(async () => {
      throw new Error("compose up failed");
    });
    const next = mutex.runExclusive(async () => "next");
    await expect(failing).rejects.toThrow("compose up failed");
    expect(await next).toBe("next");
    expect(mutex.busy()).toBe(false);
  });

  it("releases the lock when the work throws synchronously", async () => {
    const mutex = new VerifyMutex();
    const failing = mutex.runExclusive((): Promise<string> => {
      throw new Error("bad harness");
    });
    await expect(failing).rejects.toThrow("bad harness");
    expect(mutex.busy()).toBe(false);
    expect(await mutex.runExclusive(async () => "after")).toBe("after");
  });
});
