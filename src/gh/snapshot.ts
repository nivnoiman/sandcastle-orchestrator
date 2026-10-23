import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface IssueSnapshot {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  body: string;
}

export interface WorkItemSnapshot extends IssueSnapshot {
  blockedBy: number[] | null;
}

export interface RunSnapshot {
  repo: string;
  parent: IssueSnapshot;
  subIssues: WorkItemSnapshot[];
}

const SUB_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title state body labels(first: 100) { nodes { name } }
      subIssues(first: 100) {
        pageInfo { hasNextPage }
        nodes { number title state body labels(first: 100) { nodes { name } } }
      }
    }
  }
}`;

interface GqlIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  body: string;
  labels: { nodes: { name: string }[] };
}

interface GqlParentResponse {
  data: {
    repository: {
      issue: (GqlIssue & { subIssues: { pageInfo: { hasNextPage: boolean }; nodes: GqlIssue[] } }) | null;
    };
  };
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function toIssueSnapshot(issue: GqlIssue): IssueSnapshot {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body ?? "",
    labels: issue.labels.nodes.map((label) => label.name),
  };
}

async function fetchBlockedBy(repo: string, issueNumber: number): Promise<number[] | null> {
  try {
    const raw = await gh(["api", `repos/${repo}/issues/${issueNumber}/dependencies/blocked_by`]);
    const parsed = JSON.parse(raw) as { number: number }[];
    return parsed.map((issue) => issue.number);
  } catch {
    return null;
  }
}

export async function fetchRunSnapshot(repo: string, parentNumber: number): Promise<RunSnapshot> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`repo must be owner/name, got "${repo}"`);
  const raw = await gh([
    "api", "graphql",
    "-H", "GraphQL-Features: sub_issues",
    "-f", `query=${SUB_ISSUES_QUERY}`,
    "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${parentNumber}`,
  ]);
  const parent = (JSON.parse(raw) as GqlParentResponse).data.repository.issue;
  if (!parent) throw new Error(`issue #${parentNumber} not found on ${repo}`);
  if (parent.subIssues.pageInfo.hasNextPage) {
    throw new Error(`#${parentNumber} has more than 100 sub-issues; pagination is not supported`);
  }

  const subIssues = await Promise.all(
    parent.subIssues.nodes.map(async (node) => ({
      ...toIssueSnapshot(node),
      blockedBy: await fetchBlockedBy(repo, node.number),
    })),
  );
  return { repo, parent: toIssueSnapshot(parent), subIssues };
}
