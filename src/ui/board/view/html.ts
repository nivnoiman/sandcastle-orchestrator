import { esc } from "../format.js";
import { icon } from "./icons.js";

export type Attrs = Record<string, string | number | boolean | undefined>;

/** ` key="value"` pairs; false/undefined drop the attribute, true renders it bare. aria-* always carry "true"/"false". */
export function attrs(values: Attrs): string {
  return Object.entries(values)
    .filter(([key, value]) => value !== undefined && (value !== false || key.startsWith("aria-")))
    .map(([key, value]) => (value === true && !key.startsWith("aria-") ? ` ${key}` : ` ${key}="${esc(value)}"`))
    .join("");
}

export interface ButtonOptions {
  label: string;
  cls?: string;
  icon?: string;
  title?: string;
  disabled?: boolean;
  ariaLabel?: string;
  data?: Attrs;
}

export function button(options: ButtonOptions): string {
  const pieces = attrs({
    type: "button",
    class: `btn ${options.cls ?? ""}`.trim(),
    title: options.title,
    disabled: options.disabled,
    "aria-label": options.ariaLabel,
    ...options.data,
  });
  return `<button${pieces}>${options.icon ? icon(options.icon) : ""}${options.label ? esc(options.label) : ""}</button>`;
}

export function tag(label: string, tone = "", iconName?: string): string {
  return `<span class="tag ${tone}">${iconName ? icon(iconName) : ""}${esc(label)}</span>`;
}

/** Bars for working agents against a cap; long caps are capped at 16 bars. */
export function meter(running: number, cap: number): string {
  const bars = Math.min(Math.max(cap, running, 1), 16);
  const lit = Math.min(running, bars);
  return `<span class="meter" aria-hidden="true">${Array.from({ length: bars }, (_, k) => `<i${k < lit ? ' class="on"' : ""}></i>`).join("")}</span>`;
}

export function externalLink(href: string, label: string, cls = ""): string {
  return `<a${attrs({ href, target: "_blank", rel: "noreferrer", class: cls })}>${label}</a>`;
}

/** A link to an issue or pull request; plain text when the Tracker gives it no web page. */
export function issueLink(href: string | undefined, label: string, cls = ""): string {
  if (!href) return `<span${attrs({ class: `nolink ${cls}`.trim() })}>${label}</span>`;
  return externalLink(href, label, cls);
}

export function trackerChip(tracker: "github" | "local"): string {
  return `<span class="mode-chip tracker ${tracker}" title="${tracker === "local" ? "Local Tracker: issues are files under .scratch/, a Run ends with an integration branch" : "GitHub Tracker: issues, labels and pull requests live on GitHub"}">${tracker}</span>`;
}

export function modeChip(mode: "dry" | "real"): string {
  return `<span class="mode-chip ${mode}" title="${mode === "dry" ? "Dry mode: simulated run, nothing real is touched" : "Real mode"}">${mode}</span>`;
}
