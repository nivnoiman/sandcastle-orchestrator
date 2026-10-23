import { PacedDryRun, randomStageDelay } from "../engine/pacedDryRunner.js";
import type { PendingStage } from "../engine/fakes.js";
import type { ControlPlaneHost } from "../real/controlPlane.js";
import { startParentRun } from "../real/startRealRun.js";
import type { Session, StartSessionRequest } from "./controller.js";

export interface DryRunSessionOptions {
  now: () => number;
  delayMs?: () => number;
  failStage?: (pending: PendingStage) => string | undefined;
}

export function dryRunSession(request: StartSessionRequest, options: DryRunSessionOptions): Session {
  const paced = new PacedDryRun(request.model, {
    workerCap: request.workerCap,
    now: options.now,
    delayMs: options.delayMs ?? (() => randomStageDelay()),
    ui: request.sink,
    failStage: options.failStage,
  });
  paced.start();
  return {
    engine: paced.engine,
    tick: () => paced.tick(),
    stop: () => undefined,
  };
}

export interface RealSessionOptions {
  host: ControlPlaneHost;
  pollIntervalSeconds: number;
  skipVerify?: boolean | undefined;
  log: (message: string) => void;
}

export async function realSession(request: StartSessionRequest, options: RealSessionOptions): Promise<Session> {
  const run = await startParentRun(options.host, {
    model: request.model,
    workerCap: request.workerCap,
    pollIntervalSeconds: options.pollIntervalSeconds,
    skipVerify: options.skipVerify,
    log: options.log,
    ui: {
      warn: (itemNumber, message) => {
        options.log(`[warn] #${itemNumber} ${message}`);
        request.sink.warn(itemNumber, message);
      },
      note: (itemNumber, message) => {
        options.log(itemNumber === undefined ? `[note] ${message}` : `[note] #${itemNumber} ${message}`);
        request.sink.note(itemNumber, message);
      },
    },
  });

  return {
    engine: run.engine,
    featureVerify: () => run.featureVerify(),
    polish: () => run.polish(),
    finished: run.finished,
    attempts: {
      list: (itemNumber) => run.logs.list(itemNumber),
      read: (id, from) => run.logs.read(id, from),
    },
    tick: () => run.tick(),
    stop: () => run.stop(),
  };
}
