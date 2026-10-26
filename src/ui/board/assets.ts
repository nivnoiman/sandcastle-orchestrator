import express, { type Express, type Response } from "express";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const BOARD_DIR = import.meta.dirname;
const ENTRY_FILE = join(BOARD_DIR, "entry.ts");
const CSS_FILE = join(BOARD_DIR, "board.css");
const FONTS_DIR = join(BOARD_DIR, "fonts");

/** Global the bundle assigns; the page shell calls `SandcastleBoard.mountBoard(...)`. */
export const BOARD_GLOBAL = "SandcastleBoard";

export interface BoardAssets {
  js: string;
  css: string;
}

async function buildAssets(): Promise<BoardAssets> {
  const result = await build({
    entryPoints: [ENTRY_FILE],
    bundle: true,
    write: false,
    format: "iife",
    globalName: BOARD_GLOBAL,
    platform: "browser",
    target: "es2022",
    sourcemap: "inline",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("esbuild produced no board bundle");
  return { js: output.text, css: await readFile(CSS_FILE, "utf8") };
}

let cached: Promise<BoardAssets> | undefined;

/** The Board View bundle and stylesheet, built once in memory (ADR 0002); a failed build is retried on the next request. */
export function boardAssets(): Promise<BoardAssets> {
  if (process.env["SANDCASTLE_BOARD_DEV"]) return buildAssets();
  cached ??= buildAssets().catch((cause: unknown) => {
    cached = undefined;
    throw cause;
  });
  return cached;
}

/** Start bundling now so the first page load does not pay for it. */
export function warmBoardAssets(): void {
  boardAssets().catch(() => undefined);
}

export interface BoardPageOptions {
  title?: string;
  /** JS run once the bundle has loaded; defaults to mounting a Project Server board. */
  mountScript?: string;
}

const DEFAULT_MOUNT = `${BOARD_GLOBAL}.mountBoard({ root: document.getElementById("board"), scope: "project" });`;

/** HTML shell for the Board View: sets the stored theme before paint, then loads `/board/board.js`. */
export function boardPage(options: BoardPageOptions = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${options.title ?? "Sandcastle"}</title>
<link rel="preload" as="font" type="font/woff2" href="/board/fonts/Geist-Variable.woff2" crossorigin />
<link rel="stylesheet" href="/board/board.css" />
<script>try{var t=localStorage.getItem("sandcastle.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<div id="board"></div>
<script src="/board/board.js"></script>
<script>${options.mountScript ?? DEFAULT_MOUNT}</script>
</body>
</html>
`;
}

function sendAsset(response: Response, type: string, body: Promise<string>): void {
  body.then(
    (text) => response.type(type).set("cache-control", "no-cache").send(text),
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      response.status(500).type("text/plain").send(`board bundle failed: ${message}`);
    },
  );
}

/** Routes that serve the Board View assets: `/board/board.js`, `/board/board.css`, `/board/fonts/*`. */
export function mountBoardAssets(app: Express): void {
  app.get("/board/board.js", (_request, response) => {
    sendAsset(response, "application/javascript", boardAssets().then((assets) => assets.js));
  });
  app.get("/board/board.css", (_request, response) => {
    sendAsset(response, "text/css", boardAssets().then((assets) => assets.css));
  });
  app.use("/board/fonts", express.static(FONTS_DIR, { maxAge: "7d", immutable: true }));
}
