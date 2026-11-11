import type { ChangesSource, ChangeTarget, FileText, RawDiff } from "./source.js";

/** Dry runs have no branches: serve a fixed sample so the Changes tab is demoable. */
export const SAMPLE_DIFF = `diff --git a/src/billing/export.ts b/src/billing/export.ts
index 1111111..2222222 100644
--- a/src/billing/export.ts
+++ b/src/billing/export.ts
@@ -1,5 +1,11 @@
 import { rows } from "./rows.js";
+import { toCsv } from "./csv.js";

-export function exportBilling(month: string): string {
-  return rows(month).join("\\n");
+export function exportBilling(month: string, currency = "USD"): string {
+  const lines = rows(month).map((row) => ({ ...row, currency }));
+  return toCsv(lines);
 }
+
+export function exportName(month: string): string {
+  return \`billing-\${month}.csv\`;
+}
diff --git a/src/billing/csv.ts b/src/billing/csv.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/billing/csv.ts
@@ -0,0 +1,6 @@
+export function toCsv(rows: Record<string, unknown>[]): string {
+  const head = Object.keys(rows[0] ?? {});
+  const body = rows.map((row) => head.map((key) => JSON.stringify(row[key] ?? "")).join(","));
+  return [head.join(","), ...body].join("\\n");
+}
+// no trailing newline
\\ No newline at end of file
diff --git a/src/billing/legacy.ts b/src/billing/legacy.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/billing/legacy.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function legacyExport(): string {
-  return "";
-}
diff --git a/src/billing/old-name.ts b/src/billing/rows.ts
similarity index 90%
rename from src/billing/old-name.ts
rename to src/billing/rows.ts
index 5555555..6666666 100644
--- a/src/billing/old-name.ts
+++ b/src/billing/rows.ts
@@ -1,3 +1,3 @@
-export const rows = (month: string): string[] => [month];
+export const rows = (month: string): { month: string }[] => [{ month }];
 // billing rows
 // one per month
diff --git a/docs/billing.md b/docs/billing.md
index 7777777..8888888 100644
--- a/docs/billing.md
+++ b/docs/billing.md
@@ -1,2 +1,9 @@
 # Billing export
-Exports a month as text.
+Exports a month as **CSV**.
+
+## Usage
+
+- \`exportBilling("2026-05")\` returns the CSV text
+- Pass a currency as the second argument
+
+> Files are named \`billing-<month>.csv\`.
diff --git a/assets/logo.png b/assets/logo.png
index 9999999..aaaaaaa 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/package-lock.json b/package-lock.json
index bbbbbbb..ccccccc 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "lockfileVersion": 2,
+  "lockfileVersion": 3,
   "packages": {}
`;

const SAMPLE_MD = `# Billing export

Exports a month as **CSV**.

## Usage

- \`exportBilling("2026-05")\` returns the CSV text
- Pass a currency as the second argument

> Files are named \`billing-<month>.csv\`.
`;

export class SampleChangesSource implements ChangesSource {
  diff(_target: ChangeTarget): Promise<RawDiff> {
    return Promise.resolve({ source: "branch", text: SAMPLE_DIFF, clipped: false });
  }

  file(_target: ChangeTarget, path: string): Promise<FileText> {
    if (path.endsWith(".md")) return Promise.resolve({ text: SAMPLE_MD, clipped: false, binary: false });
    return Promise.resolve({ text: "", clipped: false, binary: true });
  }
}
