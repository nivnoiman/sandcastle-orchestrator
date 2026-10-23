import { parse as parseYaml } from "yaml";
import type { RunSnapshot, WorkItemSnapshot } from "../gh/snapshot.js";

import { isKnownRepo, knownRepos } from "../project/projectConfig.js";

export type TargetRepo = string;

export function isTargetRepo(value: string): value is TargetRepo {
  return isKnownRepo(value);
}

export type Admission = "queued" | "held" | "done";

export interface WorkItem {
  number: number;
  title: string;
  repo: TargetRepo;
  dependsOn: number[];
  admission: Admission;
  extraMemories: string[];
  body: string;
}

export interface RunModel {
  parentNumber: number;
  title: string;
  parentBody: string;
  feature: string;
  integrationBranch: string;
  requiredReading: Partial<Record<TargetRepo, string[]>>;
  loadBearingMemories: string[];
  items: WorkItem[];
}

export type LoadResult =
  | { ok: true; model: RunModel }
  | { ok: false; errors: string[] };

const FEATURE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const YAML_FENCE = /```yaml\r?\n([\s\S]*?)```/g;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function yamlFencesContaining(body: string, key: string): string[] {
  return [...body.matchAll(YAML_FENCE)].map((match) => match[1] ?? "").filter((fence) => new RegExp(`^${key}:`, "m").test(fence));
}

interface FeatureConfig {
  feature: string;
  requiredReading: Partial<Record<TargetRepo, string[]>>;
  loadBearingMemories: string[];
}

function parseRequiredReading(parentNumber: number, raw: unknown, errors: string[]): Partial<Record<TargetRepo, string[]>> {
  const requiredReading: Partial<Record<TargetRepo, string[]>> = {};
  if (raw === undefined || raw === null) return requiredReading;
  if (typeof raw !== "object") {
    errors.push(`#${parentNumber}: "required_reading" must map repo → paths`);
    return requiredReading;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!isTargetRepo(key)) {
      errors.push(`#${parentNumber}: required_reading key "${key}" is not a known repo (${knownRepos().join(", ")})`);
      continue;
    }
    if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) {
      errors.push(`#${parentNumber}: required_reading.${key} must be a list of paths`);
      continue;
    }
    requiredReading[key] = value as string[];
  }
  return requiredReading;
}

function parseFeatureConfig(parentNumber: number, body: string, errors: string[]): FeatureConfig | undefined {
  const candidates = yamlFencesContaining(body, "sandcastle");
  if (candidates.length !== 1) {
    errors.push(`#${parentNumber}: expected exactly one yaml fence with a "sandcastle:" key, found ${candidates.length}`);
    return undefined;
  }
  let raw: unknown;
  try {
    raw = parseYaml(candidates[0]!);
  } catch (cause) {
    errors.push(`#${parentNumber}: yaml fence does not parse — ${errorMessage(cause)}`);
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    errors.push(`#${parentNumber}: yaml fence must be a mapping`);
    return undefined;
  }
  const config = raw as Record<string, unknown>;
  if (config["sandcastle"] !== "v1") {
    errors.push(`#${parentNumber}: unknown contract version "${String(config["sandcastle"])}" (expected "v1")`);
    return undefined;
  }
  const feature = config["feature"];
  if (typeof feature !== "string" || !FEATURE_SLUG.test(feature)) {
    errors.push(`#${parentNumber}: "feature" must be a kebab-case slug, got ${JSON.stringify(feature)}`);
    return undefined;
  }

  const requiredReading = parseRequiredReading(parentNumber, config["required_reading"], errors);

  const memories = config["load_bearing_memories"] ?? [];
  if (!Array.isArray(memories) || memories.some((slug) => typeof slug !== "string")) {
    errors.push(`#${parentNumber}: "load_bearing_memories" must be a list of memory slugs`);
    return undefined;
  }

  return { feature, requiredReading, loadBearingMemories: memories as string[] };
}

function bodySection(body: string, title: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s*${title}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

export function parseBodyBlockedBy(body: string): number[] {
  const section = bodySection(body, "Blocked by");
  if (!section) return [];
  return [...section.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseExtraMemories(itemNumber: number, body: string, errors: string[]): string[] {
  const candidates = yamlFencesContaining(body, "extra_memories");
  if (candidates.length === 0) return [];
  if (candidates.length > 1) {
    errors.push(`#${itemNumber}: expected at most one yaml fence with an "extra_memories:" key, found ${candidates.length}`);
    return [];
  }
  let raw: unknown;
  try {
    raw = parseYaml(candidates[0]!);
  } catch (cause) {
    errors.push(`#${itemNumber}: extra_memories fence does not parse — ${errorMessage(cause)}`);
    return [];
  }
  const memories = (raw as Record<string, unknown>)["extra_memories"];
  if (!Array.isArray(memories) || memories.some((slug) => typeof slug !== "string")) {
    errors.push(`#${itemNumber}: "extra_memories" must be a list of memory slugs`);
    return [];
  }
  return memories as string[];
}

function toWorkItem(snapshot: WorkItemSnapshot, errors: string[]): WorkItem | undefined {
  const repoLabels = snapshot.labels.filter((label) => label.startsWith("repo:"));
  if (repoLabels.length !== 1) {
    errors.push(`#${snapshot.number}: expected exactly one repo:* label, found [${repoLabels.join(", ")}]`);
    return undefined;
  }
  const repo = repoLabels[0]!.slice("repo:".length);
  if (!isTargetRepo(repo)) {
    errors.push(`#${snapshot.number}: unknown target repo "${repo}" (known: ${knownRepos().join(", ")})`);
    return undefined;
  }
  const dependsOn = snapshot.blockedBy ?? parseBodyBlockedBy(snapshot.body);
  const admission: Admission =
    snapshot.state === "CLOSED" ? "done" : snapshot.labels.includes("ready-for-agent") ? "queued" : "held";
  return {
    number: snapshot.number,
    title: snapshot.title,
    repo,
    dependsOn,
    admission,
    extraMemories: parseExtraMemories(snapshot.number, snapshot.body, errors),
    body: snapshot.body,
  };
}

function findCycle(items: WorkItem[]): number[] | undefined {
  const byNumber = new Map(items.map((item) => [item.number, item]));
  const visiting = new Set<number>();
  const done = new Set<number>();
  const stack: number[] = [];

  const visit = (number: number): number[] | undefined => {
    if (done.has(number)) return undefined;
    if (visiting.has(number)) return [...stack.slice(stack.indexOf(number)), number];
    visiting.add(number);
    stack.push(number);
    for (const dep of byNumber.get(number)?.dependsOn ?? []) {
      if (!byNumber.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(number);
    done.add(number);
    return undefined;
  };

  for (const item of items) {
    const cycle = visit(item.number);
    if (cycle) return cycle;
  }
  return undefined;
}

export function loadRunModel(snapshot: RunSnapshot): LoadResult {
  const errors: string[] = [];

  if (!snapshot.parent.labels.includes("sandcastle")) {
    errors.push(`#${snapshot.parent.number}: parent is missing the "sandcastle" label`);
  }
  const config = parseFeatureConfig(snapshot.parent.number, snapshot.parent.body, errors);

  const items: WorkItem[] = [];
  for (const sub of snapshot.subIssues) {
    const item = toWorkItem(sub, errors);
    if (item) items.push(item);
  }

  const siblingNumbers = new Set(snapshot.subIssues.map((sub) => sub.number));
  for (const item of items) {
    for (const dep of item.dependsOn) {
      if (!siblingNumbers.has(dep)) {
        errors.push(`#${item.number}: blocked by #${dep}, which is not a sub-issue of parent #${snapshot.parent.number}`);
      }
    }
  }

  const cycle = findCycle(items);
  if (cycle) {
    errors.push(`dependency cycle: ${cycle.map((number) => `#${number}`).join(" → ")}`);
  }

  if (config) {
    const usedRepos = new Set(items.map((item) => item.repo));
    for (const key of Object.keys(config.requiredReading)) {
      if (!usedRepos.has(key as TargetRepo)) {
        errors.push(`#${snapshot.parent.number}: required_reading has "${key}" but no Work Item targets it`);
      }
    }
  }

  if (errors.length > 0 || !config) return { ok: false, errors };
  return {
    ok: true,
    model: {
      parentNumber: snapshot.parent.number,
      title: snapshot.parent.title,
      parentBody: snapshot.parent.body,
      feature: config.feature,
      integrationBranch: `integration/${config.feature}`,
      requiredReading: config.requiredReading,
      loadBearingMemories: config.loadBearingMemories,
      items,
    },
  };
}
