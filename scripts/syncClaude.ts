import { bootProject } from "../src/project/boot.js";
import { syncClaudeHome } from "../src/real/claudeSync.js";
import { readEnvFileValues } from "../src/real/env.js";
import { nodeFileSystem } from "../src/real/fileSystem.js";
import { defaultLayout, sandcastleDirFrom } from "../src/real/paths.js";

bootProject();
const fileValues = readEnvFileValues(nodeFileSystem, sandcastleDirFrom());
const layout = defaultLayout(process.env, fileValues);
const source = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.env["SANDCASTLE_CLAUDE_SOURCE"] ?? fileValues["SANDCASTLE_CLAUDE_SOURCE"];

if (!source) {
  console.error(
    "usage: npm run sync-claude -- <source .claude dir>\n" +
      "  or set SANDCASTLE_CLAUDE_SOURCE in .env.orchestrator (e.g. /mnt/c/Users/<you>/.claude)",
  );
  process.exit(2);
}

try {
  const report = syncClaudeHome(nodeFileSystem, source, layout.claudeDir);
  console.log(`synced ${report.source} → ${report.target}`);
  for (const entry of report.copied) console.log(`  copied  ${entry}`);
  for (const entry of report.absent) console.log(`  absent  ${entry}`);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
