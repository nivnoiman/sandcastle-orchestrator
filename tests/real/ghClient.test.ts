import { describe, expect, it } from "vitest";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import { PR_JSON_FIELDS, RealGhClient, serviceRepoSlug } from "../../src/real/ghClient.js";

const HUB = "example-org/hub";
const BRANCH = "feat/17-toy-slice";

function harness() {
  const runner = new RecordingCommandRunner();
  const warnings: string[] = [];
  const logs: string[] = [];
  const gh = new RealGhClient({
    runner,
    hubRepo: HUB,
    locate: () => ({ repo: "api", branch: BRANCH }),
    log: (message) => logs.push(message),
    warn: (itemNumber, message) => warnings.push(`#${itemNumber} ${message}`),
  });
  return { runner, gh, warnings, logs };
}

function labelsJson(...names: string[]): string {
  return JSON.stringify({ labels: names.map((name) => ({ name })) });
}

const PR_URL = "https://github.com/example-org/api/pull/42";

function prJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    { number: 42, url: PR_URL, state: "OPEN", isDraft: true, body: "", title: "feat: toy slice", ...overrides },
  ]);
}

describe("setStageLabel", () => {
  it("removes the other sc:* labels and adds the target in one edit", () => {
    const { runner, gh } = harness();
    runner.respond("issue view", labelsJson("sc:queued", "repo:api", "ready-for-agent"));
    gh.setStageLabel(17, "sc:developing");
    expect(runner.find("issue edit")?.line).toBe(
      `gh issue edit 17 --repo ${HUB} --add-label sc:developing --remove-label sc:queued`,
    );
  });

  it("leaves non-sandcastle labels alone", () => {
    const { runner, gh } = harness();
    runner.respond("issue view", labelsJson("repo:api", "ready-for-agent", "needs-triage"));
    gh.setStageLabel(17, "sc:queued");
    expect(runner.find("issue edit")?.line).toBe(`gh issue edit 17 --repo ${HUB} --add-label sc:queued`);
  });

  it("never removes the label it is about to add", () => {
    const { runner, gh } = harness();
    runner.respond("issue view", labelsJson("sc:developing"));
    gh.setStageLabel(17, "sc:developing");
    expect(runner.find("issue edit")?.line).not.toContain("--remove-label");
  });

  it("warns instead of crashing the run when the mirror write fails", () => {
    const { runner, gh, warnings } = harness();
    runner.respond("issue view", labelsJson());
    runner.fail("issue edit", new CommandFailure("gh", ["issue", "edit"], 1, "", "rate limited"));
    gh.setStageLabel(17, "sc:developing");
    expect(warnings[0]).toMatch(/label mirror failed \(set sc:developing\).*rate limited/);
  });

  it("queues label writes behind a failed one and replays them in order once GitHub answers", () => {
    const { runner, gh, warnings } = harness();
    runner.respond("issue view", labelsJson());
    runner.fail("issue edit", new CommandFailure("gh", ["issue", "edit"], 1, "", "error connecting to api.github.com"), 2);
    gh.setStageLabel(17, "sc:developing");
    gh.setStageLabel(17, "sc:simplifying");
    expect(runner.findAll("issue edit")).toHaveLength(1);
    expect(warnings).toHaveLength(1);

    gh.flushPendingLabels();
    expect(runner.findAll("issue edit")).toHaveLength(2);

    gh.flushPendingLabels();
    const edits = runner.findAll("issue edit").map((call) => call.line);
    expect(edits.slice(2)).toEqual([
      expect.stringContaining("--add-label sc:developing"),
      expect.stringContaining("--add-label sc:simplifying"),
    ]);

    gh.flushPendingLabels();
    expect(runner.findAll("issue edit")).toHaveLength(4);
  });
});

describe("label and comment writes", () => {
  it("adds, removes and swaps labels through gh issue edit", () => {
    const { runner, gh } = harness();
    gh.addLabel(17, "sc:needs-human");
    gh.removeLabel(17, "sc:needs-human");
    gh.swapLabels(17, "ready-for-agent", "ready-for-human");
    expect(runner.lines).toEqual([
      `gh issue edit 17 --repo ${HUB} --add-label sc:needs-human`,
      `gh issue edit 17 --repo ${HUB} --remove-label sc:needs-human`,
      `gh issue edit 17 --repo ${HUB} --add-label ready-for-human --remove-label ready-for-agent`,
    ]);
  });

  it("pipes comment bodies through stdin so markdown survives", () => {
    const { runner, gh } = harness();
    gh.comment(17, "sandcastle parked this item: develop stage failed.");
    const call = runner.find("issue comment");
    expect(call?.line).toBe(`gh issue comment 17 --repo ${HUB} --body-file -`);
    expect(call?.input).toBe("sandcastle parked this item: develop stage failed.");
  });

  it("throws when the park comment cannot be posted — the human must see why an item parked", () => {
    const { runner, gh, warnings } = harness();
    runner.fail("issue comment", new CommandFailure("gh", ["issue", "comment"], 1, "", "rate limited"));
    expect(() => gh.comment(17, "sandcastle parked this item")).toThrow(/rate limited/);
    expect(warnings).toEqual([]);
  });
});

describe("pull requests", () => {
  it("marks a draft ready then squash-merges it on the service repo with the pull request title as the subject", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", prJson());
    const merged = gh.mergePullRequest(17);
    expect(runner.lines).toEqual([
      `gh pr list --repo ${serviceRepoSlug("api")} --head ${BRANCH} --state open --json ${PR_JSON_FIELDS} --limit 1`,
      `gh pr ready 42 --repo ${serviceRepoSlug("api")}`,
      `gh pr merge 42 --repo ${serviceRepoSlug("api")} --squash --subject feat: toy slice --delete-branch`,
    ]);
    expect(merged.url).toBe(PR_URL);
  });

  it("never merges against the hub repo — pull requests live on api/web", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", prJson());
    gh.mergePullRequest(17);
    expect(runner.lines.some((line) => line.startsWith("gh pr ") && line.includes(HUB))).toBe(false);
  });

  it("skips gh pr ready for a pull request that is already ready", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", prJson({ isDraft: false }));
    gh.mergePullRequest(17);
    expect(runner.findAll("pr ready")).toHaveLength(0);
  });

  it("refuses to squash a pull request gh reported without a title", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", JSON.stringify([{ number: 42, url: PR_URL, state: "OPEN", isDraft: true, body: "" }]));
    expect(() => gh.mergePullRequest(17)).toThrow(/without a title/);
  });

  it("fails fast when there is nothing to merge", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", "[]");
    expect(() => gh.mergePullRequest(17)).toThrow(/no pull request for feat\/17-toy-slice/);
  });

  it("creates a draft pull request against the integration branch", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", prJson());
    const created = gh.createDraftPullRequest({
      repo: "api",
      branch: BRANCH,
      baseBranch: "integration/toy-demo",
      title: "feat: toy slice",
      body: "## What changed\n- things",
    });
    const call = runner.find("pr create");
    expect(call?.line).toBe(
      `gh pr create --repo ${serviceRepoSlug("api")} --draft --base integration/toy-demo --head ${BRANCH} --title feat: toy slice --body-file -`,
    );
    expect(call?.input).toContain("## What changed");
    expect(created.number).toBe(42);
  });

  it("returns undefined rather than guessing when gh reports no pull request", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", "[]");
    expect(gh.findPullRequest("api", BRANCH)).toBeUndefined();
  });

  it("only ever looks at open pull requests, so a closed one cannot be reused or merged", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", "[]");
    gh.findPullRequest("api", BRANCH);
    expect(runner.find("pr list")?.line).toContain("--state open");
    expect(runner.find("pr list")?.line).not.toContain("--state all");
  });

  it("filters by base branch when one is given, so a wrong-base pull request cannot be adopted", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", "[]");
    gh.findPullRequest("api", BRANCH, "dev");
    expect(runner.find("pr list")?.line).toBe(
      `gh pr list --repo ${serviceRepoSlug("api")} --head ${BRANCH} --base dev --state open --json ${PR_JSON_FIELDS} --limit 1`,
    );
  });

  it("carries the pull request body so the stage sections on it can be read back", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", prJson({ body: "## What changed\n- things\n\n<!-- sandcastle:review -->\n## Review\n- fixed it" }));
    expect(gh.findPullRequest("api", BRANCH)?.body).toContain("<!-- sandcastle:review -->");
  });

  it("fails fast when gh hands back a pull request without a string body", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", JSON.stringify([{ number: 42, url: "https://x/42", state: "OPEN", isDraft: true }]));
    expect(() => gh.findPullRequest("api", BRANCH)).toThrow(/without a string body/);
  });

  it("appends to the existing body through stdin rather than replacing it", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", prJson({ body: "## What changed\n- things" }));
    const pullRequest = gh.findPullRequest("api", BRANCH);
    if (!pullRequest) throw new Error("expected a pull request");
    gh.appendToPullRequestBody("api", pullRequest, "<!-- sandcastle:review -->\n## Review\n- recorded");
    const call = runner.find("pr edit");
    expect(call?.line).toBe(`gh pr edit 42 --repo ${serviceRepoSlug("api")} --body-file -`);
    expect(call?.input).toContain("## What changed");
    expect(call?.input).toContain("<!-- sandcastle:review -->");
  });

  it("comments on a pull request through its number", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", prJson({ body: "## What changed" }));
    const pullRequest = gh.findPullRequest("api", BRANCH);
    if (!pullRequest) throw new Error("expected a pull request");
    gh.commentOnPullRequest("api", pullRequest, "polish reverted");
    const call = runner.find("pr comment");
    expect(call?.line).toBe(`gh pr comment 42 --repo ${serviceRepoSlug("api")} --body-file -`);
    expect(call?.input).toBe("polish reverted");
  });
});

describe("issueComments", () => {
  it("reads every comment body on a hub issue, oldest first", () => {
    const { runner, gh } = harness();
    runner.respond("--json comments", JSON.stringify({ comments: [{ body: "first" }, { body: "second" }, { author: "x" }] }));
    expect(gh.issueComments(16)).toEqual(["first", "second"]);
    expect(runner.find("--json comments")?.line).toContain("issue view 16 --repo example-org/hub");
  });
});

describe("closeIssue", () => {
  it("comments the merged pull request link on the hub sub-issue before closing it", () => {
    const { runner, gh } = harness();
    gh.closeIssue(17, PR_URL);
    expect(runner.lines).toEqual([
      `gh issue comment 17 --repo ${HUB} --body-file -`,
      `gh issue close 17 --repo ${HUB}`,
    ]);
    expect(runner.find("issue comment")?.input).toContain(PR_URL);
  });

  it("says why the close is explicit and that the parent stays open", () => {
    const { runner, gh } = harness();
    gh.closeIssue(17, PR_URL);
    const body = runner.find("issue comment")?.input ?? "";
    expect(body).toMatch(/never auto-closes an issue/);
    expect(body).toMatch(/parent issue stays open/);
  });

  it("does not close when the link comment cannot be posted", () => {
    const { runner, gh } = harness();
    runner.fail("issue comment", new CommandFailure("gh", ["issue", "comment"], 1, "", "rate limited"));
    expect(() => gh.closeIssue(17, PR_URL)).toThrow(/rate limited/);
    expect(runner.findAll("issue close")).toHaveLength(0);
  });

  it("lets a failing close surface", () => {
    const { runner, gh } = harness();
    runner.fail("issue close", new CommandFailure("gh", ["issue", "close"], 1, "", "boom"));
    expect(() => gh.closeIssue(17, PR_URL)).toThrow(/boom/);
  });

  it("never touches the parent issue", () => {
    const { runner, gh } = harness();
    gh.closeIssue(17, PR_URL);
    expect(runner.lines.every((line) => line.includes(" 17 "))).toBe(true);
  });
});

describe("createPullRequest", () => {
  it("opens a ready-for-review pull request against dev, unlike the draft item PRs", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", prJson({ isDraft: false }));
    gh.createPullRequest({
      repo: "api",
      branch: "integration/toy-demo",
      baseBranch: "dev",
      title: "feat: toy-demo",
      body: "report",
    });
    const created = runner.find("pr create");
    expect(created?.line).toBe(
      `gh pr create --repo ${serviceRepoSlug("api")} --base dev --head integration/toy-demo --title feat: toy-demo --body-file -`,
    );
    expect(created?.line).not.toContain("--draft");
    expect(created?.input).toBe("report");
  });

  it("still refuses to report success when gh opened nothing", () => {
    const { runner, gh } = harness();
    runner.respond("pr list", "[]");
    expect(() =>
      gh.createPullRequest({ repo: "api", branch: "integration/toy-demo", baseBranch: "dev", title: "t", body: "b" }),
    ).toThrow("no open pull request exists");
  });
});
