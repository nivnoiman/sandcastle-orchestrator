import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttemptLogStore, attemptId, parentLogsDir, parseAttemptId } from "../../src/real/attemptLog.js";
import { MemoryFileSystem } from "../../src/real/fileSystem.js";
import { testLayout } from "./support.js";

function store(): { store: AttemptLogStore; fs: MemoryFileSystem } {
  const fs = new MemoryFileSystem();
  let tick = 0;
  return {
    fs,
    store: new AttemptLogStore({
      fs,
      layout: testLayout(),
      parentNumber: 99,
      now: () => new Date(1_757_000_000_000 + tick++ * 1000),
    }),
  };
}

describe("attempt logs", () => {
  it("stamps receive time into complete JSON lines only", () => {
    const { store: logs, fs } = store();
    const writer = logs.begin(104, "develop");
    writer.write('{"type":"system"}\nplain\n{"type":"par');
    expect(fs.readText(writer.record.file)).toBe(
      `{"sc_ts":"${new Date(1_757_000_001_000).toISOString()}","type":"system"}\nplain\n{"type":"par`,
    );
  });

  it("does not stamp a continuation of a split line", () => {
    const { store: logs, fs } = store();
    const writer = logs.begin(104, "develop");
    writer.write('{"a":{"b":');
    writer.write('{"c":1}}\n');
    expect(fs.readText(writer.record.file)).toBe('{"a":{"b":{"c":1}}\n');
  });

  it("writes one file per attempt under the parent, numbered per stage", () => {
    const { store: logs, fs } = store();
    logs.begin(104, "develop").write("first");
    logs.begin(104, "develop").write("second");
    logs.begin(104, "review").write("third");

    const files = logs.list(104).map((record) => record.file);
    expect(files).toEqual([
      join(parentLogsDir(testLayout(), 99), "104", "develop-1.jsonl"),
      join(parentLogsDir(testLayout(), 99), "104", "develop-2.jsonl"),
      join(parentLogsDir(testLayout(), 99), "104", "review-1.jsonl"),
    ]);
    expect(fs.readText(files[0]!)).toBe("first");
  });

  it("appends chunks as they stream and reports the attempt as running until it finishes", () => {
    const { store: logs, fs } = store();
    const writer = logs.begin(104, "develop");
    writer.write('{"type":"system"}\n');
    writer.write('{"type":"result"}\n');

    expect(logs.read(writer.record.id).running).toBe(true);
    writer.finish("success");
    const record = logs.list(104)[0]!;
    expect(record.outcome).toBe("success");
    expect(record.bytes).toBe(fs.readText(record.file)!.length);
    expect(logs.read(record.id).running).toBe(false);
  });

  it("reads incrementally from a byte offset so the drawer can follow a live attempt", () => {
    const { store: logs } = store();
    const writer = logs.begin(104, "develop");
    writer.write("aaa");
    const first = logs.read(writer.record.id);
    expect(first).toMatchObject({ from: 0, next: 3, chunk: "aaa" });

    writer.write("bbb");
    expect(logs.read(writer.record.id, first.next)).toMatchObject({ from: 3, next: 6, chunk: "bbb" });
    expect(logs.read(writer.record.id, 6).chunk).toBe("");
  });

  it("counts offsets in bytes so a multibyte (UTF-8) tail resumes on a character boundary", () => {
    const { store: logs } = store();
    const writer = logs.begin(104, "develop");
    writer.write("שלום");

    expect(writer.record.bytes).toBe(8);
    const whole = logs.read(writer.record.id);
    expect(whole.chunk).toBe("שלום");
    expect(whole.next).toBe(8);
    const tail = logs.read(writer.record.id, 5);
    expect(tail.chunk).toBe("ם");
    expect(tail.next).toBe(8);
  });

  it("lists every item's attempts oldest first when no item is named", () => {
    const { store: logs } = store();
    logs.begin(104, "develop");
    logs.begin(105, "develop");

    expect(logs.list().map((record) => record.id)).toEqual(["104-develop-1", "105-develop-1"]);
  });

  it("refuses to read an attempt it never recorded", () => {
    expect(() => store().store.read("104-develop-9")).toThrow(/no such attempt log/);
  });

  it("round-trips an attempt id", () => {
    expect(parseAttemptId(attemptId(104, "simplify", 2))).toEqual({ itemNumber: 104, stage: "simplify", attempt: 2 });
    expect(parseAttemptId("../../etc/passwd")).toBeUndefined();
  });
});
