import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttemptRecord } from "../../src/real/attemptLog.js";
import { lastAgentMessage, MESSAGE_CAP, wholeLines } from "../../src/ui/summary.js";
import { mountSummaryRoutes, type SummaryRouteDeps } from "../../src/ui/summaryRoutes.js";
import { uiItem, uiRun, uiState } from "./board/fixtures.js";

const assistant = (text: string): string => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (text: string): string => JSON.stringify({ type: "result", num_turns: 3, result: text });

describe("lastAgentMessage", () => {
  it("prefers the final result text", () => {
    expect(lastAgentMessage([assistant("working"), result("Done: added the export")].join("\n"))).toEqual({ message: "Done: added the export", clipped: false });
  });

  it("falls back to the last agent turn, skipping tool noise", () => {
    const tool = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
    expect(lastAgentMessage([assistant("first"), assistant("second"), tool].join("\n")).message).toBe("second");
  });

  it("is empty for an empty or message-less log", () => {
    expect(lastAgentMessage("")).toEqual({ message: undefined, clipped: false });
    expect(lastAgentMessage("plain line\n{broken")).toEqual({ message: undefined, clipped: false });
  });

  it("caps long messages and redacts secrets", () => {
    const long = lastAgentMessage(assistant("x".repeat(MESSAGE_CAP * 2)));
    expect(long.clipped).toBe(true);
    expect(long.message?.length).toBeLessThanOrEqual(MESSAGE_CAP + 1);
    expect(lastAgentMessage(assistant("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end")).message).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("wholeLines", () => {
  it("drops the partial first line of a mid-file chunk only", () => {
    expect(wholeLines("rtial\nfull\n", false)).toBe("full\n");
    expect(wholeLines("rtial", false)).toBe("");
    expect(wholeLines("full\n", true)).toBe("full\n");
  });
});

const state = uiState([uiRun(10, [uiItem(1, "done")])]);

function record(id: string, bytes = 10): AttemptRecord {
  return { id, itemNumber: 1, stage: "implement", attempt: 1, startedAt: "t", endedAt: "t", outcome: "success", bytes, file: "f" };
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function get(deps: Partial<SummaryRouteDeps>, path: string): Promise<{ status: number; json: { ok: boolean; result?: any; error?: string } }> {
  const app = express();
  mountSummaryRoutes(app, { state: () => state, attempts: () => [], read: () => ({ id: "", from: 0, next: 0, chunk: "", running: false }), task: () => undefined, ...deps });
  server = createServer(app);
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  return { status: response.status, json: (await response.json()) as never };
}

describe("GET /api/summary", () => {
  it.each(["", "?item=", "?item=0", "?item=-1", "?item=1.5", "?item=abc", "?item=99999999999", "?item=1&item=2"])("rejects item param %j", async (query) => {
    const { status, json } = await get({}, `/api/summary${query}`);
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it("rejects an item that is not in the run", async () => {
    expect((await get({}, "/api/summary?item=77")).json.error).toMatch(/no longer in the run/);
  });

  it("returns the task and the tail of each attempt", async () => {
    const reads: [string, number][] = [];
    const read: SummaryRouteDeps["read"] = (id, from) => {
      reads.push([id, from]);
      return { id, from, next: 0, chunk: from > 0 ? `cut\n${result("fine")}\n` : result("small"), running: false };
    };
    const { status, json } = await get({ task: () => "Add the export", attempts: () => [record("1-implement-1", 100_000), record("1-review-1")], read }, "/api/summary?item=1");
    expect(status).toBe(200);
    expect(json.result.task).toBe("Add the export");
    expect(json.result.attempts.map((tail: { message: string }) => tail.message)).toEqual(["fine", "small"]);
    expect(reads[0]![1]).toBeGreaterThan(0);
    expect(reads[1]![1]).toBe(0);
  });

  it("answers for a parent number and tolerates missing task and unreadable logs", async () => {
    const read = (): never => {
      throw new Error("no transcripts");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { status, json } = await get({ attempts: () => [record("10-polish-1")], read }, "/api/summary?item=10");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("10-polish-1: no transcripts"));
    logged.mockRestore();
    expect(status).toBe(200);
    expect(json.result.task).toBeUndefined();
    expect(json.result.attempts).toEqual([{ id: "10-polish-1", message: undefined, clipped: false }]);
  });

  it("hides internal errors", async () => {
    const attempts = (): never => {
      throw new Error("secret path /x/y");
    };
    const { status, json } = await get({ attempts }, "/api/summary?item=1");
    expect(status).toBe(500);
    expect(json.error).toBe("could not read the summary");
  });
});
