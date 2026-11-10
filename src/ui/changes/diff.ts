/** Unified-diff parser for the drawer's Changes tab: pure, capped, and secret-redacting. */

export type FileStatus = "A" | "M" | "D" | "R";
export type LineKind = "ctx" | "add" | "del" | "note";

export interface DiffLine {
  kind: LineKind;
  /** Line number in the old file; absent for added lines and notes. */
  old?: number;
  /** Line number in the new file; absent for removed lines and notes. */
  new?: number;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** Previous path of a rename. */
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  /** Lockfile or minified bundle: hunks are left out unless the caller asked for them. */
  generated: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Some lines of this file were dropped by a cap. */
  truncated: boolean;
}

export interface DiffCaps {
  maxFiles: number;
  maxLines: number;
  maxLinesPerFile: number;
  maxLineLength: number;
}

export const DEFAULT_CAPS: DiffCaps = { maxFiles: 300, maxLines: 8000, maxLinesPerFile: 2000, maxLineLength: 2000 };

export interface ParsedDiff {
  files: DiffFile[];
  /** Totals over every file in the input, including files cut by a cap. */
  totals: { files: number; additions: number; deletions: number };
  /** Files or lines were dropped by a cap. */
  truncated: boolean;
}

export interface ParseOptions {
  caps?: Partial<DiffCaps>;
  /** Keep hunks of lockfiles and minified bundles. */
  includeGenerated?: boolean;
}

const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Pipfile\.lock)$|\.min\.(js|css)$|\.map$/;

export function isGeneratedPath(path: string): boolean {
  return GENERATED.test(path);
}

const SECRET = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|xox[abps]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET, "[redacted]");
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(path: string): string {
  const trimmed = path.replace(/\t.*$/, "");
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

function stripPrefix(path: string): string {
  return unquote(path).replace(/^[ab]\//, "");
}

/** `diff --git a/x b/x`: only used when no ---/+++ or rename lines name the path (binary and mode-only files). */
function pathsOfHeader(line: string): { oldPath: string; path: string } {
  const rest = line.slice("diff --git ".length);
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0 && rest.startsWith("a/") && rest.slice(2 + half, 5 + half) === " b/" && rest.slice(2, 2 + half) === rest.slice(5 + half)) {
    const same = rest.slice(2, 2 + half);
    return { oldPath: same, path: same };
  }
  const middle = rest.indexOf(" b/");
  if (middle === -1) return { oldPath: stripPrefix(rest), path: stripPrefix(rest) };
  return { oldPath: stripPrefix(rest.slice(0, middle)), path: stripPrefix(rest.slice(middle + 1)) };
}

function emptyFile(header: string): DiffFile {
  const { oldPath, path } = pathsOfHeader(header);
  const file: DiffFile = { path, status: "M", binary: false, generated: false, additions: 0, deletions: 0, hunks: [], truncated: false };
  if (oldPath !== path) file.oldPath = oldPath;
  return file;
}

export function parseDiff(text: string, options: ParseOptions = {}): ParsedDiff {
  const caps = { ...DEFAULT_CAPS, ...options.caps };
  const files: DiffFile[] = [];
  const totals = { files: 0, additions: 0, deletions: 0 };
  let truncated = false;
  let current: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let keep = false;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let linesKept = 0;
  let linesInFile = 0;

  const finish = (): void => {
    if (!current) return;
    current.generated = isGeneratedPath(current.path);
    totals.files += 1;
    totals.additions += current.additions;
    totals.deletions += current.deletions;
    const hidden = current.binary || (current.generated && !options.includeGenerated);
    if (hidden) current.hunks = [];
    if (files.length >= caps.maxFiles) truncated = true;
    else files.push(current);
    current = undefined;
    hunk = undefined;
  };

  const clipLine = (text: string): string => (text.length > caps.maxLineLength ? `${text.slice(0, caps.maxLineLength)}… (line cut)` : text);

  const addLine = (line: DiffLine): void => {
    if (!current || !hunk) return;
    const hidden = current.binary || (isGeneratedPath(current.path) && !options.includeGenerated);
    if (hidden || files.length >= caps.maxFiles) return;
    if (linesKept >= caps.maxLines || linesInFile >= caps.maxLinesPerFile) {
      current.truncated = true;
      truncated = true;
      return;
    }
    linesKept += 1;
    linesInFile += 1;
    hunk.lines.push({ ...line, text: clipLine(redactSecrets(line.text)) });
  };

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      finish();
      current = emptyFile(line);
      keep = false;
      linesInFile = 0;
      continue;
    }
    if (!current) continue;
    if (hunk && keep) {
      const marker = line === "" ? " " : line[0];
      const inHunk = oldLeft > 0 || newLeft > 0;
      if ((inHunk && (marker === "+" || marker === "-" || marker === " ")) || marker === "\\") {
        if (marker === "+") {
          newLeft -= 1;
          current.additions += 1;
          addLine({ kind: "add", new: newNo, text: line.slice(1) });
          newNo += 1;
        } else if (marker === "-") {
          oldLeft -= 1;
          current.deletions += 1;
          addLine({ kind: "del", old: oldNo, text: line.slice(1) });
          oldNo += 1;
        } else if (marker === " ") {
          oldLeft -= 1;
          newLeft -= 1;
          addLine({ kind: "ctx", old: oldNo, new: newNo, text: line.slice(1) });
          oldNo += 1;
          newNo += 1;
        } else addLine({ kind: "note", text: line.slice(1).trim() });
        continue;
      }
    }
    const header = HUNK.exec(line);
    if (header) {
      keep = true;
      oldNo = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newNo = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { header: clipLine(redactSecrets(line)), lines: [] };
      if (files.length < caps.maxFiles) current.hunks.push(hunk);
      continue;
    }
    keep = false;
    if (line.startsWith("new file mode")) current.status = "A";
    else if (line.startsWith("deleted file mode")) current.status = "D";
    else if (line.startsWith("rename from ")) {
      current.status = "R";
      current.oldPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) current.path = unquote(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) current.binary = true;
    else if (line.startsWith("--- ") && line !== "--- /dev/null") {
      const old = stripPrefix(line.slice(4));
      if (current.status !== "R") current.oldPath = old === current.path ? undefined : current.oldPath;
    } else if (line.startsWith("+++ ") && line !== "+++ /dev/null" && current.status !== "R") current.path = stripPrefix(line.slice(4));
    else if (line.startsWith("--- /dev/null")) current.status = "A";
    else if (line.startsWith("+++ /dev/null")) current.status = "D";
  }
  finish();
  for (const file of files) if (file.oldPath === undefined) delete file.oldPath;
  return { files, totals, truncated };
}
