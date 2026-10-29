import { parse } from "yaml";

const FENCE = "---";
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export interface SplitDocument {
  /** Frontmatter lines between the fences, or undefined when the file has none. */
  frontmatter: string[] | undefined;
  /** Everything after the closing fence line, byte for byte. */
  body: string;
}

export type FrontmatterData = Record<string, unknown>;

export function splitDocument(text: string): SplitDocument {
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: undefined, body: text };
  return { frontmatter: match[1] === undefined ? [] : match[1].split(/\r?\n/), body: text.slice(match[0].length) };
}

export function parseFrontmatter(text: string): { data: FrontmatterData; body: string } {
  const { frontmatter, body } = splitDocument(text);
  if (!frontmatter) return { data: {}, body };
  const parsed: unknown = parse(frontmatter.join("\n"));
  if (parsed === null || parsed === undefined) return { data: {}, body };
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frontmatter must be a YAML mapping");
  return { data: parsed as FrontmatterData, body };
}

const RESERVED_WORD = /^(true|false|null|yes|no|on|off|~)$/i;
const NUMBER_LIKE = /^[0-9.+-]+$/;
const PLAIN_SCALAR_NO_YAML_INDICATOR_OR_TRAILING_COLON = /^[A-Za-z0-9_./](?:[A-Za-z0-9_./:@-]*[A-Za-z0-9_./@-])?$/;

function scalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  return PLAIN_SCALAR_NO_YAML_INDICATOR_OR_TRAILING_COLON.test(value) && !RESERVED_WORD.test(value) && !NUMBER_LIKE.test(value) ? value : JSON.stringify(value);
}

export type FrontmatterValue = string | number | boolean | readonly (string | number)[] | undefined;

function render(key: string, value: Exclude<FrontmatterValue, undefined>): string {
  if (typeof value === "object") return `${key}: [${value.map(scalar).join(", ")}]`;
  return `${key}: ${scalar(value)}`;
}

function isTopLevelKey(line: string): boolean {
  return /^[A-Za-z0-9_-]+\s*:/.test(line);
}

function keyOf(line: string): string {
  return line.slice(0, line.indexOf(":")).trim();
}

/**
 * Sets (or with undefined, removes) one top-level key, leaving every other line,
 * comment and the body byte-for-byte as the Operator wrote them.
 */
export function setFrontmatterKey(text: string, key: string, value: FrontmatterValue): string {
  const { frontmatter, body } = splitDocument(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!frontmatter) {
    if (value === undefined) return text;
    return [FENCE, render(key, value), FENCE, ""].join(eol) + text;
  }
  const next = [...frontmatter];
  const start = next.findIndex((line) => isTopLevelKey(line) && keyOf(line) === key);
  if (start < 0) {
    if (value === undefined) return text;
    next.push(render(key, value));
  } else {
    let end = start + 1;
    while (end < next.length && !isTopLevelKey(next[end]!) && !next[end]!.trimStart().startsWith("#")) end += 1;
    next.splice(start, end - start, ...(value === undefined ? [] : [render(key, value)]));
  }
  return [FENCE, ...next, FENCE].join(eol) + eol + body;
}
