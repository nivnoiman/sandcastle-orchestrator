import { hostGitEnv } from "./gitGuard.js";
import { execFileSync, spawn } from "node:child_process";

export interface CommandRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  input?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface StartRequest extends CommandRequest {
  onOutput?: (chunk: string) => void;
}

export interface RunningCommand {
  wait(): Promise<CommandResult>;
  kill(): void;
}

export interface CommandRunner {
  run(request: CommandRequest): CommandResult;
  start(request: StartRequest): RunningCommand;
}

const ENV_SHAPED_ARG = /^([A-Z][A-Z0-9_]*)=(.+)$/;

export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    const match = ENV_SHAPED_ARG.exec(arg);
    return match ? `${match[1]}=***` : arg;
  });
}

export const FAILURE_EXCERPT_LIMIT = 400;

export function failureExcerpt(stdout: string, stderr: string): string {
  const text = (stderr || stdout).trim();
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const last = lines.at(-1)?.trim() ?? "";
  const meaningful = lines.length > 1 && last.startsWith("{") ? last : text;
  return meaningful.length <= FAILURE_EXCERPT_LIMIT ? meaningful : `…${meaningful.slice(-FAILURE_EXCERPT_LIMIT)}`;
}

export class CommandFailure extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number | undefined,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} ${redactArgs(args).join(" ")} exited with ${exitCode ?? "signal"}: ${failureExcerpt(stdout, stderr)}`);
    this.name = "CommandFailure";
  }
}

export class AgentIdleTimeoutError extends Error {
  readonly agentIdleTimeout = true;

  constructor(
    readonly idleTimeoutSeconds: number,
    readonly command: string,
  ) {
    super(`agent produced no output for ${idleTimeoutSeconds}s (${command}) — killed`);
    this.name = "AgentIdleTimeoutError";
  }
}

export function isAgentIdleTimeout(cause: unknown): boolean {
  if (cause instanceof AgentIdleTimeoutError) return true;
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { agentIdleTimeout?: unknown }).agentIdleTimeout === true;
}

const MAX_BUFFER = 32 * 1024 * 1024;

function mergedEnv(command: string, env: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv | undefined {
  const hardening = command === "git" ? hostGitEnv() : undefined;
  if (!env && !hardening) return undefined;
  return { ...process.env, ...env, ...hardening };
}

function exitCodeOf(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const status = (cause as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function streamText(cause: unknown, key: "stdout" | "stderr"): string {
  if (typeof cause !== "object" || cause === null) return "";
  const value = (cause as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export class NodeCommandRunner implements CommandRunner {
  run(request: CommandRequest): CommandResult {
    try {
      const stdout = execFileSync(request.command, [...request.args], {
        cwd: request.cwd,
        env: mergedEnv(request.command, request.env),
        input: request.input,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { stdout, stderr: "" };
    } catch (cause) {
      throw new CommandFailure(
        request.command,
        request.args,
        exitCodeOf(cause),
        streamText(cause, "stdout"),
        streamText(cause, "stderr"),
      );
    }
  }

  start(request: StartRequest): RunningCommand {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: mergedEnv(request.command, request.env),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const collect = (target: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout = (stdout + text).slice(-MAX_BUFFER);
      else stderr = (stderr + text).slice(-MAX_BUFFER);
      request.onOutput?.(text);
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const settled = new Promise<CommandResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new CommandFailure(request.command, request.args, code ?? undefined, stdout, stderr));
      });
    });

    if (request.input !== undefined) child.stdin?.end(request.input);
    else child.stdin?.end();

    return {
      wait: () => settled,
      kill: () => {
        child.kill("SIGKILL");
      },
    };
  }
}

export const IDLE_TICK_MS = 15_000;
export const SUSPEND_GAP_FACTOR = 4;

export function silenceAfterTick(silentMs: number, elapsedMs: number, tickMs: number): number {
  if (elapsedMs < 0) return silentMs;
  if (elapsedMs > tickMs * SUSPEND_GAP_FACTOR) return silentMs + tickMs;
  return silentMs + elapsedMs;
}

export async function runWithIdleTimeout(
  runner: CommandRunner,
  request: StartRequest,
  idleTimeoutSeconds: number,
): Promise<CommandResult> {
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 1) {
    throw new Error(`idleTimeoutSeconds must be a positive number, got ${idleTimeoutSeconds}`);
  }
  const budgetMs = idleTimeoutSeconds * 1000;
  const tickMs = Math.min(IDLE_TICK_MS, budgetMs);
  let timedOut = false;
  let silentMs = 0;
  let lastTick = Date.now();

  const running = runner.start({
    ...request,
    onOutput: (chunk) => {
      request.onOutput?.(chunk);
      silentMs = 0;
      lastTick = Date.now();
    },
  });

  const ticker = setInterval(() => {
    if (timedOut) return;
    const now = Date.now();
    silentMs = silenceAfterTick(silentMs, now - lastTick, tickMs);
    lastTick = now;
    if (silentMs < budgetMs) return;
    timedOut = true;
    running.kill();
  }, tickMs);
  ticker.unref?.();

  try {
    return await running.wait();
  } catch (cause) {
    if (timedOut) throw new AgentIdleTimeoutError(idleTimeoutSeconds, request.command);
    throw cause;
  } finally {
    clearInterval(ticker);
  }
}
