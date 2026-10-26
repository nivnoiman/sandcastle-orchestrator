import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { UiController } from "../../src/ui/controller.js";
import { dryRunSession } from "../../src/ui/sessions.js";
import { PAGE_FILE, startUiServer, type UiServer } from "../../src/ui/server.js";
import { snapshot } from "../fixtures.js";

let server: UiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(): Promise<UiServer> {
  const controller = new UiController({
    mode: "dry",
    hubRepo: "example-org/hub",
    startCap: 1,
    listParents: () => Promise.resolve([]),
    loadSnapshot: () => Promise.resolve(snapshot()),
    startSession: (request) => dryRunSession(request, { now: () => 0, delayMs: () => 1000 }),
    now: () => new Date("2026-08-15T09:00:00.000Z"),
  });
  server = await startUiServer(controller, 0);
  return server;
}

async function text(path: string): Promise<{ status: number; type: string; body: string }> {
  const response = await fetch(`${server?.url}${path}`);
  return { status: response.status, type: response.headers.get("content-type") ?? "", body: await response.text() };
}

describe("Board View routes", () => {
  it("serves the Board View at / and the untouched Legacy View at /legacy", async () => {
    await boot();
    const board = await text("/");
    expect(board.status).toBe(200);
    expect(board.body).toContain('<div id="board">');
    expect(board.body).toContain("/board/board.js");

    const legacy = await text("/legacy");
    expect(legacy.status).toBe(200);
    expect(legacy.body).toBe(readFileSync(PAGE_FILE, "utf8"));
  });

  it("bundles the Board View with esbuild and serves its stylesheet and fonts", async () => {
    await boot();
    const script = await text("/board/board.js");
    expect(script.status).toBe(200);
    expect(script.type).toContain("javascript");
    expect(script.body).toContain("SandcastleBoard");
    expect(script.body).toContain("mountBoard");

    const css = await text("/board/board.css");
    expect(css.type).toContain("text/css");
    expect(css.body).toContain("@font-face");

    const font = await fetch(`${server?.url}/board/fonts/Geist-Variable.woff2`);
    expect(font.status).toBe(200);
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  });
});
