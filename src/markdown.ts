export const MIN_FENCE = 4;

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const character of text) {
    if (character !== "`") {
      current = 0;
      continue;
    }
    current += 1;
    if (current > longest) longest = current;
  }
  return longest;
}

export function fenceFor(text: string): string {
  return "`".repeat(Math.max(MIN_FENCE, longestBacktickRun(text) + 1));
}

export function fencedBlock(text: string, language = ""): string {
  const fence = fenceFor(text);
  return `${fence}${language}\n${text}\n${fence}`;
}

export function startsInsideCodePoint(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST;
}

export function endsInsideCodePoint(text: string, index: number): boolean {
  const code = text.charCodeAt(index - 1);
  return code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST;
}

export function boundedHead(text: string, limit: number, note: string): string {
  if (text.length <= limit) return text;
  const cut = endsInsideCodePoint(text, limit) ? limit - 1 : limit;
  return `${text.slice(0, cut)}\n\n${note}`;
}

export function boundedTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.length - limit;
  const start = startsInsideCodePoint(text, cut) ? cut + 1 : cut;
  return `…truncated…\n${text.slice(start)}`;
}
