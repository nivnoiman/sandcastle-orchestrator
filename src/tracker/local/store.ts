import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseFrontmatter, setFrontmatterKey, type FrontmatterData, type FrontmatterValue } from "./frontmatter.js";

export const SCRATCH_FOLDER = ".scratch";
export const ISSUES_FOLDER = "issues";
export const PARENT_FILE_PREFIX = "00-";
/** Item numbers are the parent's number plus the file's NN, so a parent owns 99 items. */
export const PARENT_NUMBER_STRIDE = 100;

const ITEM_FILE = /^(\d{2,})-.+\.md$/;
const COMMENT_START = /^<!-- sandcastle-comment (\S+) -->$/;
const COMMENT_END = "<!-- /sandcastle-comment -->";
const COMMENT_HEADING = "## Sandcastle comment";

export interface LocalIssue {
  number: number;
  path: string;
  slug: string;
  kind: "parent" | "item";
  /** The NN of an item file; 0 for a parent. */
  ordinal: number;
  parentNumber: number;
  data: FrontmatterData;
  body: string;
}

export interface LocalFeature {
  slug: string;
  parent: LocalIssue;
  items: LocalIssue[];
}

function readdirSafe(path: string): string[] | undefined {
  try {
    return readdirSync(path);
  } catch {
    return undefined;
  }
}

/** Writes through a sibling temp file so a reader never sees a half-written issue. */
export function writeFileAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

function parseIssueFile(path: string): { data: FrontmatterData; body: string } {
  try {
    return parseFrontmatter(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function numberOf(data: FrontmatterData): number | undefined {
  const value = data["number"];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Splits engine comment sections off a file body. */
export function splitComments(body: string): { text: string; comments: string[] } {
  const comments: string[] = [];
  const kept: string[] = [];
  let current: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (current) {
      if (line === COMMENT_END) {
        comments.push(current.join("\n"));
        current = undefined;
      } else {
        current.push(line);
      }
      continue;
    }
    if (COMMENT_START.test(line)) {
      current = [];
      if (kept.at(-1)?.startsWith(COMMENT_HEADING)) kept.pop();
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\s+$/, "\n"), comments };
}

export function commentSection(body: string, now: Date): string {
  const stamp = now.toISOString();
  return `\n${COMMENT_HEADING} (${stamp})\n<!-- sandcastle-comment ${stamp} -->\n${body.replace(/\s+$/, "").replaceAll(COMMENT_END, "<!-- /sandcastle-comment (escaped) -->")}\n${COMMENT_END}\n`;
}

/** The `.scratch/<slug>/issues/` files of one hub, re-read from disk on every call. */
export class LocalIssueStore {
  constructor(
    readonly scratchRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every feature with a parent file, numbered; a parent without a `number` key is given the next free hundred and keeps it. */
  features(): LocalFeature[] {
    const found = (readdirSafe(this.scratchRoot) ?? []).sort().flatMap((slug) => {
      const dir = join(this.scratchRoot, slug, ISSUES_FOLDER);
      const parentName = readdirSafe(dir)?.sort().find((name) => name.startsWith(PARENT_FILE_PREFIX) && name.endsWith(".md"));
      return parentName ? [{ slug, dir, path: join(dir, parentName) }] : [];
    });
    const parsed = found.map((entry) => ({ ...entry, ...parseIssueFile(entry.path) }));
    let last = Math.max(0, ...parsed.map((entry) => numberOf(entry.data) ?? 0));
    return parsed.map((entry) => {
      let data = entry.data;
      let number = numberOf(data);
      if (number === undefined) {
        last = (Math.floor(last / PARENT_NUMBER_STRIDE) + 1) * PARENT_NUMBER_STRIDE;
        number = last;
        data = this.update(entry.path, "number", number).data;
      }
      const parent: LocalIssue = {
        number, path: entry.path, slug: entry.slug, kind: "parent", ordinal: 0, parentNumber: number, data, body: entry.body,
      };
      return { slug: entry.slug, parent, items: this.itemsOf(entry.dir, entry.slug, number) };
    });
  }

  private itemsOf(dir: string, slug: string, parentNumber: number): LocalIssue[] {
    return (readdirSafe(dir) ?? []).sort().flatMap((name) => {
      const match = ITEM_FILE.exec(name);
      if (!match || name.startsWith(PARENT_FILE_PREFIX)) return [];
      const ordinal = Number(match[1]);
      const path = join(dir, name);
      if (ordinal >= PARENT_NUMBER_STRIDE) throw new Error(`${path}: a feature holds at most ${PARENT_NUMBER_STRIDE - 1} issues`);
      const { data, body } = parseIssueFile(path);
      return [{ number: parentNumber + ordinal, path, slug, kind: "item" as const, ordinal, parentNumber, data, body }];
    });
  }

  /** Creates `.scratch/<slug>/issues/00-parent.md` with the publish-contract fence and returns the new feature, numbered. */
  createParent(input: { title: string; body?: string }): LocalFeature {
    const title = input.title.trim();
    if (title.length === 0) throw new Error("an Orchestration Issue needs a title");
    const base = featureSlug(title);
    const taken = new Set(this.features().map((feature) => feature.slug));
    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;
    const dir = join(this.scratchRoot, slug, ISSUES_FOLDER);
    mkdirSync(dir, { recursive: true });
    const description = input.body?.trim() ?? "";
    const content = [`# ${title}`, "", ...(description ? [description, ""] : []), "```yaml", "sandcastle: v1", `feature: ${slug}`, "```", ""].join("\n");
    writeFileSync(join(dir, `${PARENT_FILE_PREFIX}parent.md`), content, { encoding: "utf8", flag: "wx" });
    return this.feature(this.resolve(slug));
  }

  find(number: number): LocalIssue {
    for (const feature of this.features()) {
      if (feature.parent.number === number) return feature.parent;
      const item = feature.items.find((candidate) => candidate.number === number);
      if (item) return item;
    }
    throw new Error(`no local issue #${number} under ${this.scratchRoot}`);
  }

  feature(parentNumber: number): LocalFeature {
    const found = this.features().find((feature) => feature.parent.number === parentNumber);
    if (!found) throw new Error(`no local Orchestration Issue #${parentNumber} under ${this.scratchRoot}`);
    return found;
  }

  /** A number, a feature slug, `<slug>/<NN>`, or a path to an issue file, to the canonical number. */
  resolve(handle: string | number): number {
    if (typeof handle === "number") return handle;
    const text = handle.trim();
    if (/^#?\d+$/.test(text)) return Number(text.replace("#", ""));
    const features = this.features();
    if (text.endsWith(".md")) return this.resolvePath(text, features);
    const [slug, ordinal] = text.split("/");
    const feature = features.find((candidate) => candidate.slug === slug);
    if (!feature) throw new Error(`no local issue "${handle}" — use its number, its feature slug, <slug>/<NN> or the path of its file`);
    if (ordinal === undefined || ordinal === "") return feature.parent.number;
    const item = feature.items.find((candidate) => candidate.ordinal === Number(ordinal));
    if (!item) throw new Error(`feature "${slug}" has no issue ${ordinal}`);
    return item.number;
  }

  private resolvePath(text: string, features: LocalFeature[]): number {
    const absolute = resolve(isAbsolute(text) ? text : join(dirname(this.scratchRoot), text));
    const issue = features.flatMap((feature) => [feature.parent, ...feature.items]).find((candidate) => resolve(candidate.path) === absolute);
    if (!issue) throw new Error(`${text} is not an issue file under ${this.scratchRoot}`);
    return issue.number;
  }

  /** Atomic read-modify-write of one engine-owned frontmatter key; every other byte of the file is preserved. */
  update(path: string, key: string, value: FrontmatterValue): { data: FrontmatterData; body: string } {
    const current = readFileSync(path, "utf8");
    const next = setFrontmatterKey(current, key, value);
    if (next !== current) writeFileAtomic(path, next);
    return parseFrontmatter(next);
  }

  updateIssue(number: number, key: string, value: FrontmatterValue): void {
    this.update(this.find(number).path, key, value);
  }

  appendComment(number: number, body: string): void {
    const path = this.find(number).path;
    const current = readFileSync(path, "utf8");
    writeFileAtomic(path, current.replace(/\s*$/, "\n") + commentSection(body, this.now()));
  }

  comments(number: number): string[] {
    return splitComments(this.find(number).body).comments;
  }
}

const FEATURE_SLUG_MAX = 40;

/** A kebab-case feature slug (the publish contract's `feature`) from a title. */
export function featureSlug(title: string): string {
  const kebab = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FEATURE_SLUG_MAX)
    .replace(/-+$/g, "");
  return kebab.length > 0 ? kebab : "feature";
}

export function scratchRootOf(projectRoot: string): string {
  return join(projectRoot, SCRATCH_FOLDER);
}
