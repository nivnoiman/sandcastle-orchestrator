import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ParentSummary {
  number: number;
  title: string;
  subIssues: number;
  completedSubIssues: number;
}

const PARENTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, states: OPEN, labels: ["sandcastle"], orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title subIssuesSummary { total completed } }
    }
  }
}`;

interface ParentNode {
  number: number;
  title: string;
  subIssuesSummary: { total: number; completed: number } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): boolean {
  return isRecord(value) && typeof value["total"] === "number" && typeof value["completed"] === "number";
}

function isParentNode(value: unknown): value is ParentNode {
  if (!isRecord(value)) return false;
  if (typeof value["number"] !== "number" || typeof value["title"] !== "string") return false;
  const summary = value["subIssuesSummary"];
  return summary === null || summary === undefined || isCount(summary);
}

export function parentNodes(payload: unknown): ParentNode[] {
  const nodes = isRecord(payload) && isRecord(payload["data"]) && isRecord(payload["data"]["repository"])
    ? (payload["data"]["repository"]["issues"] as unknown)
    : undefined;
  const list = isRecord(nodes) ? nodes["nodes"] : undefined;
  if (!Array.isArray(list) || !list.every(isParentNode)) {
    throw new Error("gh returned a parent list sandcastle does not recognise — is `gh auth status` healthy?");
  }
  return list;
}

export async function fetchSandcastleParents(repo: string): Promise<ParentSummary[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`repo must be owner/name, got "${repo}"`);
  const { stdout } = await exec(
    "gh",
    [
      "api", "graphql",
      "-H", "GraphQL-Features: sub_issues",
      "-f", `query=${PARENTS_QUERY}`,
      "-F", `owner=${owner}`, "-F", `name=${name}`,
    ],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  const nodes = parentNodes(JSON.parse(stdout));
  return nodes.map((node) => ({
    number: node.number,
    title: node.title,
    subIssues: node.subIssuesSummary?.total ?? 0,
    completedSubIssues: node.subIssuesSummary?.completed ?? 0,
  }));
}
