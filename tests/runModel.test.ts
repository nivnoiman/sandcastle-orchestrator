import { describe, expect, it } from "vitest";
import { loadRunModel, parseBodyBlockedBy } from "../src/model/runModel.js";
import { item, parent, snapshot, VALID_FENCE } from "./fixtures.js";

function expectErrors(result: ReturnType<typeof loadRunModel>, ...fragments: string[]) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  for (const fragment of fragments) {
    expect(result.errors.join("\n")).toContain(fragment);
  }
}

describe("happy path", () => {
  it("builds the run model from a contract-conformant snapshot", () => {
    const result = loadRunModel(snapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.feature).toBe("toy-demo");
    expect(result.model.integrationBranch).toBe("integration/toy-demo");
    expect(result.model.loadBearingMemories).toEqual(["feedback_no_code_comments"]);
    expect(result.model.requiredReading.api).toEqual(["CLAUDE.md"]);
    expect(result.model.items.map((workItem) => workItem.number)).toEqual([17, 18, 19]);
  });

  it("resolves admission: ready-for-agent → queued, absent → held, closed → done", () => {
    const result = loadRunModel(
      snapshot({
        subIssues: [
          item(),
          item({ number: 18, blockedBy: [17], state: "CLOSED" }),
          item({ number: 19, labels: ["repo:web"], blockedBy: [18] }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.items.map((workItem) => workItem.admission)).toEqual(["queued", "done", "held"]);
  });

  it("uses the body section only when the native API was unavailable (null), never when native is empty", () => {
    const bodyWithSection = "## What to build\nX.\n## Blocked by\n- #17\n";
    const result = loadRunModel(
      snapshot({
        subIssues: [
          item(),
          item({ number: 18, blockedBy: null, body: bodyWithSection }),
          item({ number: 19, labels: ["repo:web"], blockedBy: [], body: "## Blocked by\n- #18\n" }),
          item({ number: 20, labels: ["repo:web"], blockedBy: [17], body: "## Blocked by\n- #18\n" }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.items[1]?.dependsOn).toEqual([17]);
    expect(result.model.items[2]?.dependsOn).toEqual([]);
    expect(result.model.items[3]?.dependsOn).toEqual([17]);
  });

  it("parses optional extra_memories fences on work items", () => {
    const result = loadRunModel(
      snapshot({
        subIssues: [
          item({ body: "## What to build\nX.\n```yaml\nextra_memories:\n  - feedback_version_bump\n```" }),
          item({ number: 18, blockedBy: [17] }),
          item({ number: 19, labels: ["repo:web"], blockedBy: [18] }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.items[0]?.extraMemories).toEqual(["feedback_version_bump"]);
    expect(result.model.items[1]?.extraMemories).toEqual([]);
  });
});

describe("parseBodyBlockedBy", () => {
  it("reads refs only from the Blocked by section", () => {
    expect(parseBodyBlockedBy("## Parent\n#4\n## Blocked by\n- #7\n- #12\n## Notes\nsee #99")).toEqual([7, 12]);
    expect(parseBodyBlockedBy("no section, mentions #5")).toEqual([]);
    expect(parseBodyBlockedBy("## Blocked by\nNone — can start immediately.")).toEqual([]);
  });
});

describe("fail-fast validation", () => {
  it("rejects a parent without the sandcastle label", () => {
    expectErrors(loadRunModel(snapshot({ parent: parent({ labels: [] }) })), 'missing the "sandcastle" label');
  });

  it("rejects a parent without a sandcastle yaml fence", () => {
    expectErrors(loadRunModel(snapshot({ parent: parent({ body: "no fence here" }) })), "expected exactly one yaml fence");
  });

  it("rejects two sandcastle fences", () => {
    expectErrors(
      loadRunModel(snapshot({ parent: parent({ body: `${VALID_FENCE}\n${VALID_FENCE}` }) })),
      "expected exactly one yaml fence with a \"sandcastle:\" key, found 2",
    );
  });

  it("rejects unparseable yaml", () => {
    expectErrors(
      loadRunModel(snapshot({ parent: parent({ body: "```yaml\nsandcastle: v1\n  bad: [unclosed\n```" }) })),
      "yaml fence does not parse",
    );
  });

  it("rejects an unknown contract version", () => {
    expectErrors(
      loadRunModel(snapshot({ parent: parent({ body: "```yaml\nsandcastle: v2\nfeature: x\n```" }) })),
      'unknown contract version "v2"',
    );
  });

  it("rejects a non-slug feature", () => {
    expectErrors(
      loadRunModel(snapshot({ parent: parent({ body: "```yaml\nsandcastle: v1\nfeature: Bad Slug\n```" }) })),
      '"feature" must be a kebab-case slug',
    );
  });

  it("rejects a work item with zero repo labels", () => {
    expectErrors(
      loadRunModel(snapshot({ subIssues: [item({ labels: ["ready-for-agent"] })] })),
      "#17: expected exactly one repo:* label, found []",
    );
  });

  it("rejects a work item with two repo labels", () => {
    expectErrors(
      loadRunModel(snapshot({ subIssues: [item({ labels: ["repo:api", "repo:web"] })] })),
      "#17: expected exactly one repo:* label",
    );
  });

  it("rejects an unknown target repo", () => {
    expectErrors(
      loadRunModel(snapshot({ subIssues: [item({ labels: ["repo:website"] })] })),
      '#17: unknown target repo "website"',
    );
  });

  it("rejects a malformed extra_memories fence", () => {
    expectErrors(
      loadRunModel(snapshot({ subIssues: [item({ body: "```yaml\nextra_memories: not-a-list\n```" })] })),
      '#17: "extra_memories" must be a list of memory slugs',
    );
  });

  it("rejects an edge pointing outside the sibling set", () => {
    expectErrors(
      loadRunModel(snapshot({ subIssues: [item({ blockedBy: [4] })] })),
      "#17: blocked by #4, which is not a sub-issue of parent #16",
    );
  });

  it("rejects dependency cycles, naming the cycle", () => {
    expectErrors(
      loadRunModel(
        snapshot({
          subIssues: [item({ blockedBy: [19] }), item({ number: 18, blockedBy: [17] }), item({ number: 19, blockedBy: [18] })],
        }),
      ),
      "dependency cycle:",
    );
  });

  it("rejects required_reading for a repo no work item targets", () => {
    const result = loadRunModel(
      snapshot({
        parent: parent({
          body: "```yaml\nsandcastle: v1\nfeature: toy-demo\nrequired_reading:\n  web:\n    - CLAUDE.md\n```",
        }),
        subIssues: [item()],
      }),
    );
    expectErrors(result, 'required_reading has "web" but no Work Item targets it');
  });

  it("collects multiple errors in one pass", () => {
    const result = loadRunModel(
      snapshot({
        parent: parent({ labels: [], body: "no fence" }),
        subIssues: [item({ labels: [] })],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
