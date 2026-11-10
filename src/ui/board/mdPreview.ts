import { esc } from "./format.js";

/** Small, safe Markdown subset for the Changes preview: everything is escaped first, only http(s) links are kept. */

function inline(raw: string): string {
  const codes: string[] = [];
  let text = esc(raw).replace(/`([^`]+)`/g, (_whole, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_whole, alt: string) => `<span class="md-img">[image: ${alt}]</span>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_whole, label: string, url: string) => `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return text.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => codes[Number(index)] ?? "");
}

function tableRow(line: string, cell: "td" | "th"): string {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|");
  return `<tr>${cells.map((value) => `<${cell}>${inline(value.trim())}</${cell}>`).join("")}</tr>`;
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function markdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = /^(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith(marker)) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      out.push(`<pre class="md-code"><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr />");
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
        quote.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && SEPARATOR.test(lines[index + 1] ?? "")) {
      const rows = [tableRow(line, "th")];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim() !== "") {
        rows.push(tableRow(lines[index] ?? "", "td"));
        index += 1;
      }
      out.push(`<table class="md-table">${rows.join("")}</table>`);
      continue;
    }
    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2] ?? "");
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[index] ?? "");
        if (!match) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(match[3] ?? "");
        const text = task ? `${task[1] === " " ? "☐" : "☑"} ${inline(task[2] ?? "")}` : inline(match[3] ?? "");
        items.push(`<li style="margin-left:${Math.min(4, Math.floor((match[1]?.length ?? 0) / 2)) * 16}px">${text}</li>`);
        index += 1;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "" && !/^(#{1,6}\s|>|```|~~~|\s*([-*+]|\d+\.)\s)/.test(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(line);
      index += 1;
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return out.join("");
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
