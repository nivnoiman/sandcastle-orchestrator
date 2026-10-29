import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TrackerKind } from "./projectConfig.js";

/** Where the engineering skills look up how this repo tracks issues. */
export const ISSUE_TRACKER_DOC = join("docs", "agents", "issue-tracker.md");

const GITHUB_DOC = (hubRepo: string): string =>
  [
    "# Issue tracker: GitHub",
    "",
    `Issues and pull requests for this repo live in GitHub issues of \`${hubRepo}\`, driven with the \`gh\` CLI. Sandcastle's Tracker is \`github\`.`,
    "",
    "## Conventions",
    "",
    "- Create an issue: `gh issue create --title \"...\" --body \"...\"`",
    "- Read an issue: `gh issue view <number> --comments`",
    "- Comment on an issue: `gh issue comment <number> --body \"...\"`",
    "- Apply or remove labels: `gh issue edit <number> --add-label \"...\"` / `--remove-label \"...\"`",
    "- Close: `gh issue close <number> --comment \"...\"`",
    "",
    "## When a skill says \"publish to the issue tracker\"",
    "",
    "Create a GitHub issue. An Orchestration Issue carries the `sandcastle` label and a `sandcastle: v1` yaml fence; its sub-issues are native GitHub sub-issues labelled `repo:<name>`.",
    "",
    "## When a skill says \"fetch the relevant ticket\"",
    "",
    "Run `gh issue view <number> --comments`.",
    "",
    "## Running it",
    "",
    "`sandcastle start <parent-issue-number>`: every item ends as a squash-merged pull request into `integration/<feature>`, and the Run ends with an integration pull request for you to merge.",
    "",
  ].join("\n");

const LOCAL_DOC = [
  "# Issue tracker: Local markdown",
  "",
  "Issues live as files under `.scratch/` in this repo; nothing talks to GitHub. Sandcastle's Tracker is `local`.",
  "",
  "## Conventions",
  "",
  "- One feature per directory: `.scratch/<feature-slug>/issues/`",
  "- The Orchestration Issue (parent) is `00-parent.md`; its items are `NN-<slug>.md` (`01-`, `02-`, ...)",
  "- A parent holds a yaml fence with `sandcastle: v1` and `feature: <feature-slug>`; the Run's integration branch is `integration/<feature-slug>`",
  "- Frontmatter on each file: `repo` (a repo from `.sandcastle/config.json`, items only), `blocked-by` (item numbers), and the keys sandcastle writes itself: `state`, `stage`, `labels`, `merged`, `review`, `number`",
  "- Numbers: parents are 100, 200, ... and an item is its parent's number plus its `NN`, so `#101` is item `01` of parent `#100`",
  "- Comments and park reasons are appended to the file as `## Sandcastle comment` sections; edit freely, sandcastle re-reads the files on every tick",
  "",
  "## When a skill says \"publish to the issue tracker\"",
  "",
  "Create the files above. `to-tickets` writes this layout; add the `repo:` frontmatter to each item.",
  "",
  "## When a skill says \"fetch the relevant ticket\"",
  "",
  "Read the file. The number, the feature slug (`billing-export`), `<slug>/<NN>` or the file path all identify it to the CLI.",
  "",
  "## Running it",
  "",
  "`sandcastle start <number | slug | path>`: agents commit to item branches, sandcastle squash-merges each into `integration/<feature-slug>`, and the Run ends with that branch for you to merge (`git merge origin/integration/<feature-slug>` from the base branch). No `gh` or `GH_TOKEN` is needed.",
  "",
].join("\n");

export function issueTrackerDoc(tracker: TrackerKind, hubRepo?: string): string {
  if (tracker === "local") return LOCAL_DOC;
  if (hubRepo === undefined) throw new Error("the github issue-tracker doc names the hub repo — pass hubRepo");
  return GITHUB_DOC(hubRepo);
}

export type TrackerDocResult = { written: true; path: string } | { written: false; path: string };

/** Writes `docs/agents/issue-tracker.md` in a project root; an existing file is left alone. */
export function writeIssueTrackerDoc(root: string, tracker: TrackerKind, hubRepo?: string): TrackerDocResult {
  const path = join(root, ISSUE_TRACKER_DOC);
  if (existsSync(path)) return { written: false, path };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, issueTrackerDoc(tracker, hubRepo));
  return { written: true, path };
}
