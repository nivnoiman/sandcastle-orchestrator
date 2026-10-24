import { join } from "node:path";
import type { FileSystemPort } from "./fileSystem.js";
import type { SandcastleLayout } from "./paths.js";

export const ATTEMPT_ID = /^(\d+)-([a-z][a-z0-9-]*)-(\d+)$/;
export const LOG_READ_LIMIT = 512 * 1024;

export interface AttemptRecord {
  id: string;
  itemNumber: number;
  stage: string;
  attempt: number;
  startedAt: string;
  endedAt: string | undefined;
  outcome: string | undefined;
  bytes: number;
  file: string;
}

export interface AttemptChunk {
  id: string;
  from: number;
  next: number;
  chunk: string;
  running: boolean;
}

export interface AttemptWriter {
  record: AttemptRecord;
  write(chunk: string): void;
  finish(outcome: string): void;
}

export function logsDir(layout: SandcastleLayout): string {
  return join(layout.sandcastleDir, "logs");
}

export function parentLogsDir(layout: SandcastleLayout, parentNumber: number): string {
  return join(logsDir(layout), String(parentNumber));
}

export function attemptId(itemNumber: number, stage: string, attempt: number): string {
  return `${itemNumber}-${stage}-${attempt}`;
}

export function parseAttemptId(id: string): { itemNumber: number; stage: string; attempt: number } | undefined {
  const match = ATTEMPT_ID.exec(id);
  if (!match) return undefined;
  return { itemNumber: Number(match[1]), stage: match[2]!, attempt: Number(match[3]) };
}

export interface AttemptLogDeps {
  fs: FileSystemPort;
  layout: SandcastleLayout;
  parentNumber: number;
  now?: () => Date;
}

export class AttemptLogStore {
  private readonly records = new Map<string, AttemptRecord>();
  private readonly counts = new Map<string, number>();

  constructor(private readonly deps: AttemptLogDeps) {}

  private timestamp(): string {
    return (this.deps.now ?? ((): Date => new Date()))().toISOString();
  }

  private firstAttemptWithoutLeftoverTranscript(directory: string, stage: string, firstCandidate: number): number {
    let attempt = firstCandidate;
    while (this.deps.fs.exists(join(directory, `${stage}-${attempt}.jsonl`))) attempt += 1;
    return attempt;
  }

  begin(itemNumber: number, stage: string): AttemptWriter {
    const key = `${itemNumber}-${stage}`;
    const directory = join(parentLogsDir(this.deps.layout, this.deps.parentNumber), String(itemNumber));
    const attempt = this.firstAttemptWithoutLeftoverTranscript(directory, stage, (this.counts.get(key) ?? 0) + 1);
    this.counts.set(key, attempt);
    const id = attemptId(itemNumber, stage, attempt);
    const file = join(directory, `${stage}-${attempt}.jsonl`);
    this.deps.fs.makeDirectory(directory);
    this.deps.fs.writeText(file, "");
    const record: AttemptRecord = {
      id,
      itemNumber,
      stage,
      attempt,
      startedAt: this.timestamp(),
      endedAt: undefined,
      outcome: undefined,
      bytes: 0,
      file,
    };
    this.records.set(id, record);
    return {
      record,
      write: (chunk) => {
        if (chunk.length === 0) return;
        this.deps.fs.appendText(file, chunk);
        record.bytes += Buffer.byteLength(chunk, "utf8");
      },
      finish: (outcome) => {
        record.outcome = outcome;
        record.endedAt = this.timestamp();
      },
    };
  }

  list(itemNumber?: number): AttemptRecord[] {
    return [...this.records.values()]
      .filter((record) => itemNumber === undefined || record.itemNumber === itemNumber)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map((record) => ({ ...record }));
  }

  read(id: string, from = 0): AttemptChunk {
    const record = this.records.get(id);
    if (!record) throw new Error(`no such attempt log: ${id}`);
    const start = Math.max(0, Math.min(from, record.bytes));
    const { chunk, next } = this.deps.fs.readChunk(record.file, start, LOG_READ_LIMIT);
    return { id, from: start, next, chunk, running: record.endedAt === undefined };
  }
}
