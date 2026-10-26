type FormField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const lastHtml = new WeakMap<Element, string>();

function isField(element: Element | null): element is FormField {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
}

interface Snapshot {
  focusKey: string | undefined;
  value: string | undefined;
  selection: [number | null, number | null];
  scrolls: Map<string, [number, number]>;
}

function takeSnapshot(zone: Element): Snapshot {
  const active = document.activeElement;
  const inside = active !== null && zone.contains(active);
  const key = inside && active instanceof HTMLElement ? active.dataset["focus"] : undefined;
  const field = inside && isField(active) ? active : undefined;
  const scrolls = new Map<string, [number, number]>();
  zone.querySelectorAll<HTMLElement>("[data-scroll], .pipe-wrap").forEach((node, index) => {
    scrolls.set(node.dataset["scroll"] ?? `pipe-${index}`, [node.scrollLeft, node.scrollTop]);
  });
  return {
    focusKey: key,
    value: field?.value,
    selection: field instanceof HTMLSelectElement || field === undefined ? [null, null] : [field.selectionStart, field.selectionEnd],
    scrolls,
  };
}

function restoreSnapshot(zone: Element, snapshot: Snapshot): void {
  zone.querySelectorAll<HTMLElement>("[data-scroll], .pipe-wrap").forEach((node, index) => {
    const saved = snapshot.scrolls.get(node.dataset["scroll"] ?? `pipe-${index}`);
    if (saved) {
      node.scrollLeft = saved[0];
      node.scrollTop = saved[1];
    }
  });
  if (snapshot.focusKey === undefined) return;
  const target = Array.from(zone.querySelectorAll<HTMLElement>("[data-focus]")).find((node) => node.dataset["focus"] === snapshot.focusKey);
  if (!target) return;
  if (isField(target) && snapshot.value !== undefined && !(target instanceof HTMLSelectElement)) target.value = snapshot.value;
  target.focus({ preventScroll: true });
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && snapshot.selection[0] !== null) {
    try {
      target.setSelectionRange(snapshot.selection[0], snapshot.selection[1]);
    } catch {
      // number inputs do not support selection ranges
    }
  }
}

/** Replace a zone's markup only when it changed, keeping focus, typed text and scroll positions. */
export function patch(zone: Element, html: string): void {
  if (lastHtml.get(zone) === html) return;
  lastHtml.set(zone, html);
  const snapshot = takeSnapshot(zone);
  zone.innerHTML = html;
  restoreSnapshot(zone, snapshot);
}

/** Like patch, but a log zone that was scrolled to the bottom stays pinned there. */
export function patchLog(zone: HTMLElement, html: string): void {
  if (lastHtml.get(zone) === html) return;
  const pinned = zone.scrollTop + zone.clientHeight >= zone.scrollHeight - 40;
  lastHtml.set(zone, html);
  zone.innerHTML = html;
  if (pinned) zone.scrollTop = zone.scrollHeight;
}

export function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeStorage(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage can be blocked; the page works without it
  }
}
