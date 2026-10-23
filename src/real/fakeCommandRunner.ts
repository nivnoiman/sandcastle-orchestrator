import {
  CommandFailure,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type RunningCommand,
  type StartRequest,
} from "./commandRunner.js";

export interface RecordedCall {
  command: string;
  args: string[];
  cwd: string | undefined;
  input: string | undefined;
  env: Readonly<Record<string, string>> | undefined;
  line: string;
}

export interface HeldCommand {
  readonly call: RecordedCall;
  readonly killed: boolean;
  emit(chunk: string): void;
  finish(result?: Partial<CommandResult>): void;
  fail(error: Error): void;
}

type Matcher = string | RegExp;

interface Script {
  matcher: Matcher;
  kind: "result" | "failure" | "hold";
  result: CommandResult;
  error: Error | undefined;
  remaining: number;
}

function toCall(request: CommandRequest): RecordedCall {
  return {
    command: request.command,
    args: [...request.args],
    cwd: request.cwd,
    input: request.input,
    env: request.env,
    line: [request.command, ...request.args].join(" "),
  };
}

function matches(matcher: Matcher, line: string): boolean {
  return typeof matcher === "string" ? line.includes(matcher) : matcher.test(line);
}

export class RecordingCommandRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  readonly held: HeldCommand[] = [];
  private readonly scripts: Script[] = [];

  get lines(): string[] {
    return this.calls.map((call) => call.line);
  }

  respond(matcher: Matcher, stdout: string, times = Number.POSITIVE_INFINITY): this {
    this.scripts.push({ matcher, kind: "result", result: { stdout, stderr: "" }, error: undefined, remaining: times });
    return this;
  }

  fail(matcher: Matcher, error: Error, times = Number.POSITIVE_INFINITY): this {
    this.scripts.push({ matcher, kind: "failure", result: { stdout: "", stderr: "" }, error, remaining: times });
    return this;
  }

  hold(matcher: Matcher, times = Number.POSITIVE_INFINITY): this {
    this.scripts.push({ matcher, kind: "hold", result: { stdout: "", stderr: "" }, error: undefined, remaining: times });
    return this;
  }

  find(matcher: Matcher): RecordedCall | undefined {
    return this.calls.find((call) => matches(matcher, call.line));
  }

  findAll(matcher: Matcher): RecordedCall[] {
    return this.calls.filter((call) => matches(matcher, call.line));
  }

  run(request: CommandRequest): CommandResult {
    const call = toCall(request);
    this.calls.push(call);
    const script = this.take(call.line);
    if (!script) return { stdout: "", stderr: "" };
    if (script.kind === "failure") throw script.error ?? new Error(`scripted failure for ${call.line}`);
    return script.result;
  }

  start(request: StartRequest): RunningCommand {
    const call = toCall(request);
    this.calls.push(call);
    const script = this.take(call.line);

    if (script?.kind === "hold") return this.holdCommand(call, request);

    if (script?.kind === "failure") {
      const error = script.error ?? new Error(`scripted failure for ${call.line}`);
      if (error instanceof CommandFailure && error.stdout) request.onOutput?.(error.stdout);
      return { wait: () => Promise.reject(error), kill: () => undefined };
    }

    const result = script?.result ?? { stdout: "", stderr: "" };
    if (result.stdout) request.onOutput?.(result.stdout);
    return { wait: () => Promise.resolve(result), kill: () => undefined };
  }

  private holdCommand(call: RecordedCall, request: StartRequest): RunningCommand {
    let settle: ((result: CommandResult) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    const waited = new Promise<CommandResult>((resolveFn, rejectFn) => {
      settle = resolveFn;
      reject = rejectFn;
    });
    const entry = {
      call,
      killed: false,
      emit: (chunk: string) => request.onOutput?.(chunk),
      finish: (result?: Partial<CommandResult>) => settle?.({ stdout: "", stderr: "", ...result }),
      fail: (error: Error) => reject?.(error),
    };
    this.held.push(entry);
    return {
      wait: () => waited,
      kill: () => {
        entry.killed = true;
        reject?.(new CommandFailure(call.command, call.args, 137, "", "killed"));
      },
    };
  }

  private take(line: string): Script | undefined {
    const script = this.scripts.find((candidate) => candidate.remaining > 0 && matches(candidate.matcher, line));
    if (!script) return undefined;
    script.remaining -= 1;
    return script;
  }
}
