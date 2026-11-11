import { describe, expect, it } from "vitest";
import { isGeneratedPath, parseDiff, redactSecrets } from "../../src/ui/changes/diff.js";
import { SAMPLE_DIFF } from "../../src/ui/changes/sample.js";
import { assertRef, assertRelativePath, ChangesError } from "../../src/ui/changes/source.js";

const MODIFIED = `diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 keep
-old
+new

 tail
`;

describe("parseDiff", () => {
  it("numbers lines, counts +/- and keeps blank context lines that git printed without the space", () => {
    const { files, totals } = parseDiff(MODIFIED);
    expect(totals).toEqual({ files: 1, additions: 1, deletions: 1 });
    const lines = files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((line) => [line.kind, line.old, line.new, line.text])).toEqual([
      ["ctx", 1, 1, "keep"],
      ["del", 2, undefined, "old"],
      ["add", undefined, 2, "new"],
      ["ctx", 3, 3, ""],
    ]);
  });

  it("reads status A, D and R with the old path", () => {
    const { files } = parseDiff(SAMPLE_DIFF);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
    expect(byPath["src/billing/csv.ts"]?.status).toBe("A");
    expect(byPath["src/billing/legacy.ts"]?.status).toBe("D");
    expect(byPath["src/billing/rows.ts"]).toMatchObject({ status: "R", oldPath: "src/billing/old-name.ts" });
    expect(byPath["src/billing/export.ts"]?.status).toBe("M");
    expect(byPath["src/billing/export.ts"]?.oldPath).toBeUndefined();
  });

  it("flags binary files without hunks", () => {
    const logo = parseDiff(SAMPLE_DIFF).files.find((file) => file.path === "assets/logo.png");
    expect(logo).toMatchObject({ binary: true, hunks: [] });
  });

  it("keeps a rename without content changes and a mode-only change", () => {
    const text = "diff --git a/x.ts b/y.ts\nsimilarity index 100%\nrename from x.ts\nrename to y.ts\ndiff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n";
    const { files } = parseDiff(text);
    expect(files.map((file) => [file.status, file.path, file.oldPath, file.hunks.length])).toEqual([
      ["R", "y.ts", "x.ts", 0],
      ["M", "run.sh", undefined, 0],
    ]);
  });

  it("marks no-newline-at-end-of-file as a note, not a line", () => {
    const csv = parseDiff(SAMPLE_DIFF).files.find((file) => file.path === "src/billing/csv.ts");
    const lines = csv?.hunks[0]?.lines ?? [];
    expect(lines.at(-1)).toEqual({ kind: "note", text: "No newline at end of file" });
    expect(csv?.additions).toBe(6);
  });

  it("hides lockfile hunks unless asked, but still counts them", () => {
    const hidden = parseDiff(SAMPLE_DIFF).files.find((file) => file.path === "package-lock.json");
    expect(hidden).toMatchObject({ generated: true, hunks: [], additions: 1, deletions: 1 });
    const shown = parseDiff(SAMPLE_DIFF, { includeGenerated: true }).files.find((file) => file.path === "package-lock.json");
    expect(shown?.hunks).toHaveLength(1);
    expect(isGeneratedPath("web/dist/app.min.js")).toBe(true);
    expect(isGeneratedPath("src/lock.ts")).toBe(false);
  });

  it("caps files, total lines, lines per file and line length, and flags truncation", () => {
    const body = (name: string, count: number): string =>
      `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, index) => `+line ${index}`).join("\n")}\n`;
    const files = parseDiff([body("a", 5), body("b", 5), body("c", 5)].join(""), { caps: { maxFiles: 2 } });
    expect(files.files.map((file) => file.path)).toEqual(["a", "b"]);
    expect(files.totals.files).toBe(3);
    expect(files.truncated).toBe(true);

    const perFile = parseDiff(body("big", 50), { caps: { maxLinesPerFile: 10 } });
    expect(perFile.files[0]?.hunks[0]?.lines).toHaveLength(10);
    expect(perFile.files[0]).toMatchObject({ truncated: true, additions: 50 });

    const total = parseDiff([body("a", 8), body("b", 8)].join(""), { caps: { maxLines: 10 } });
    expect(total.truncated).toBe(true);

    const long = parseDiff(`diff --git a/l b/l\n--- a/l\n+++ b/l\n@@ -0,0 +1 @@\n+${"x".repeat(50)}\n`, { caps: { maxLineLength: 10 } });
    expect(long.files[0]?.hunks[0]?.lines[0]?.text).toBe("xxxxxxxxxx… (line cut)");
  });

  it("is not fooled by content lines that look like headers", () => {
    const text = "diff --git a/n.md b/n.md\n--- a/n.md\n+++ b/n.md\n@@ -1,1 +1,2 @@\n ---\n+diff --git a/fake b/fake\n";
    const { files } = parseDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("n.md");
    expect(files[0]?.additions).toBe(1);
  });

  it("redacts obvious secrets in diff text", () => {
    expect(redactSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz0123 ok")).toBe("token=[redacted] ok");
    expect(redactSecrets("AKIAABCDEFGHIJKLMNOP")).toBe("[redacted]");
    const { files } = parseDiff("diff --git a/e b/e\n--- a/e\n+++ b/e\n@@ -0,0 +1 @@\n+KEY=sk-ant-abcdefghijklmnopqrstuvwxyz\n");
    expect(files[0]?.hunks[0]?.lines[0]?.text).toBe("KEY=[redacted]");
  });

  it("redacts secrets in hunk headers and keeps paths with spaces in binary headers", () => {
    const text = "diff --git a/my b/dir/x.png b/my b/dir/x.png\nBinary files a/my b/dir/x.png and b/my b/dir/x.png differ\ndiff --git a/e b/e\n--- a/e\n+++ b/e\n@@ -0,0 +1 @@ key=ghp_abcdefghijklmnopqrstuvwxyz0123\n+x\n";
    const { files } = parseDiff(text);
    expect(files[0]).toMatchObject({ path: "my b/dir/x.png", binary: true });
    expect(files[0]?.oldPath).toBeUndefined();
    expect(files[1]?.hunks[0]?.header).toBe("@@ -0,0 +1 @@ key=[redacted]");
  });

  it("returns nothing for empty input", () => {
    expect(parseDiff("")).toEqual({ files: [], totals: { files: 0, additions: 0, deletions: 0 }, truncated: false });
  });
});

describe("ref and path validation", () => {
  it.each(["main", "feat/21-api", "integration/eight-slice-demo", "v1.2_x"])("accepts %s", (ref) => {
    expect(assertRef(ref, "branch")).toBe(ref);
  });

  it.each(["", "-D", "--output=/x", "a..b", "a b", "a;rm -rf", "$(id)", "a`b`", "feat/", "x.lock", "a//b", "/abs", "a\nb"])("rejects ref %j", (ref) => {
    expect(() => assertRef(ref, "branch")).toThrow(ChangesError);
  });

  it.each(["src/a.ts", "docs/readme.md", "a b/c.md"])("accepts path %s", (path) => {
    expect(assertRelativePath(path)).toBe(path);
  });

  it.each(["", "../etc/passwd", "a/../../b", "/etc/passwd", "C:\\win", "..\\x", "-rf", "a//b", "a\0b", ".git/config", "x/.GIT/y", ".git. /x", "a.txt:stream", "a\nb"])("rejects path %j", (path) => {
    expect(() => assertRelativePath(path)).toThrow(ChangesError);
  });
});
