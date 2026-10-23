export interface ParentReference {
  input: string;
  number: number;
  repo: string | undefined;
}

export type ParentInput = ParentReference | { input: string; error: string };

const BARE_NUMBER = /^#?(\d+)$/;
const ISSUE_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[?#].*)?$/i;

export function parseParentInput(raw: string): ParentInput | undefined {
  const input = raw.trim();
  if (input.length === 0) return undefined;
  const bare = BARE_NUMBER.exec(input);
  if (bare) return { input, number: Number(bare[1]), repo: undefined };
  const url = ISSUE_URL.exec(input);
  if (url) return { input, number: Number(url[2]), repo: url[1] };
  return { input, error: "not an issue number or a github issue url" };
}

export function parseParentInputs(text: string): ParentInput[] {
  return text
    .split(/[\r\n,]+/)
    .map((line) => parseParentInput(line))
    .filter((parsed): parsed is ParentInput => parsed !== undefined);
}

export function isParentReference(value: ParentInput): value is ParentReference {
  return "number" in value;
}
