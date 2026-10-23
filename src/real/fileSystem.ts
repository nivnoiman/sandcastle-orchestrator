import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface CopyTreeOptions {
  private?: boolean;
}

export interface FileChunk {
  chunk: string;
  next: number;
}

export interface FileSystemPort {
  exists(path: string): boolean;
  readText(path: string): string | undefined;
  readChunk(path: string, start: number, limit: number): FileChunk;
  writeText(path: string, content: string): void;
  appendText(path: string, content: string): void;
  writePrivateText(path: string, content: string): void;
  copyFile(from: string, to: string): void;
  rename(from: string, to: string): void;
  copyTree(from: string, to: string, options?: CopyTreeOptions): void;
  makeDirectory(path: string): void;
  makeTempDirectory(prefix: string): string;
  removeFile(path: string): void;
  removeDirectory(path: string): void;
}

const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BYTE = 0x80;

function isContinuation(byte: number): boolean {
  return (byte & CONTINUATION_MASK) === CONTINUATION_BYTE;
}

function sequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xf0) return 4;
  if (byte >= 0xe0) return 3;
  return 2;
}

function wholeCharacters(raw: Buffer): { skipped: number; buffer: Buffer } {
  let head = 0;
  while (head < raw.length && isContinuation(raw[head]!)) head += 1;
  let end = raw.length;
  for (let index = raw.length - 1; index >= head && index > raw.length - 4; index -= 1) {
    if (isContinuation(raw[index]!)) continue;
    if (index + sequenceLength(raw[index]!) > raw.length) end = index;
    break;
  }
  return { skipped: head, buffer: raw.subarray(head, end) };
}

function decodeFrom(raw: Buffer, from: number): FileChunk {
  const { skipped, buffer } = wholeCharacters(raw);
  return { chunk: buffer.toString("utf8"), next: from + skipped + buffer.length };
}

function chunkOf(content: Buffer, start: number, limit: number): FileChunk {
  const from = Math.max(0, Math.min(start, content.length));
  return decodeFrom(content.subarray(from, from + limit), from);
}

export const nodeFileSystem: FileSystemPort = {
  exists: (path) => existsSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  },
  readChunk: (path, start, limit) => {
    let handle: number;
    try {
      handle = openSync(path, "r");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { chunk: "", next: Math.max(0, start) };
      throw cause;
    }
    try {
      const size = fstatSync(handle).size;
      const from = Math.max(0, Math.min(start, size));
      const buffer = Buffer.alloc(Math.max(0, Math.min(limit, size - from)));
      if (buffer.length > 0) readSync(handle, buffer, 0, buffer.length, from);
      return decodeFrom(buffer, from);
    } finally {
      closeSync(handle);
    }
  },
  writeText: (path, content) => writeFileSync(path, content, "utf8"),
  appendText: (path, content) => appendFileSync(path, content, "utf8"),
  writePrivateText: (path, content) => writeFileSync(path, content, { encoding: "utf8", mode: 0o600 }),
  copyFile: (from, to) => copyFileSync(from, to),
  rename: (from, to) => renameSync(from, to),
  copyTree: (from, to, options = {}) => {
    mkdirSync(statSync(from).isDirectory() ? to : dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, force: true });
    if (options.private) chmodSync(to, 0o600);
  },
  makeDirectory: (path) => {
    mkdirSync(path, { recursive: true });
  },
  makeTempDirectory: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  removeFile: (path) => {
    rmSync(path, { force: true });
  },
  removeDirectory: (path) => {
    rmSync(path, { force: true, recursive: true });
  },
};

export class MemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly privateFiles = new Set<string>();
  private tempCount = 0;

  constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content);
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.directories.has(path);
  }

  readText(path: string): string | undefined {
    return this.files.get(path);
  }

  readChunk(path: string, start: number, limit: number): FileChunk {
    return chunkOf(Buffer.from(this.files.get(path) ?? "", "utf8"), start, limit);
  }

  writeText(path: string, content: string): void {
    this.files.set(path, content);
  }

  appendText(path: string, content: string): void {
    this.files.set(path, (this.files.get(path) ?? "") + content);
  }

  writePrivateText(path: string, content: string): void {
    this.files.set(path, content);
    this.privateFiles.add(path);
  }

  copyFile(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`copyFile: ${from} does not exist`);
    this.files.set(to, content);
  }

  rename(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`rename: ${from} does not exist`);
    const wasPrivate = this.privateFiles.has(from);
    this.removeFile(from);
    this.removeFile(to);
    this.files.set(to, content);
    if (wasPrivate) this.privateFiles.add(to);
  }

  copyTree(from: string, to: string, options: CopyTreeOptions = {}): void {
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      if (options.private) this.privateFiles.add(to);
      return;
    }
    if (!this.directories.has(from)) throw new Error(`copyTree: ${from} does not exist`);
    this.directories.add(to);
    for (const [path, content] of [...this.files]) {
      if (!path.startsWith(`${from}/`) && !path.startsWith(`${from}\\`)) continue;
      this.files.set(join(to, path.slice(from.length + 1)), content);
    }
  }

  makeDirectory(path: string): void {
    this.directories.add(path);
  }

  makeTempDirectory(prefix: string): string {
    this.tempCount += 1;
    const path = join("T:", "temp", `${prefix}${this.tempCount}`);
    this.directories.add(path);
    return path;
  }

  removeFile(path: string): void {
    this.files.delete(path);
    this.privateFiles.delete(path);
  }

  removeDirectory(path: string): void {
    this.directories.delete(path);
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(path)) this.removeFile(file);
    }
  }
}
