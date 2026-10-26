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

export function modeChip(mode: "dry" | "real"): string {
  return `<span class="mode-chip ${mode}" title="${mode === "dry" ? "Dry mode: simulated run, nothing real is touched" : "Real mode"}">${mode}</span>`;
}
