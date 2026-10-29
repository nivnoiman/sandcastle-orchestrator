/** Inline SVG sprite: one stroke weight, referenced as <use href="#i-name">. */
export const ICON_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></symbol>
<symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></symbol>
<symbol id="i-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></symbol>
<symbol id="i-retry" viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
<symbol id="i-log" viewBox="0 0 24 24"><path d="M5 5h14M5 10h14M5 15h9M5 20h6"/></symbol>
<symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/></symbol>
<symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></symbol>
<symbol id="i-down" viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></symbol>
<symbol id="i-branch" viewBox="0 0 24 24"><circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6 3.5-11 7"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
<symbol id="i-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></symbol>
<symbol id="i-legacy" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 9h16M8 13h4"/></symbol>
<symbol id="i-theme" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></symbol>
<symbol id="i-reset" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></symbol>
<symbol id="i-pr" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a2 2 0 0 0-2-2h-4M14 5l-2 2 2 2"/></symbol>
<symbol id="i-pin" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6c0 4.5 6 12 6 12s6-7.5 6-12a6 6 0 0 0-6-6z"/><circle cx="12" cy="9" r="2"/></symbol>
<symbol id="i-castle" viewBox="0 0 24 24"><path d="M4 20V9h3V6h2v3h2V5h2v4h2V6h2v3h3v11z"/><path d="M10 20v-4a2 2 0 0 1 4 0v4"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></symbol>
<symbol id="i-dash" viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="10" height="10" rx="1.5"/><path d="M15 9V6a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3"/></symbol>
<symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13 3L5 13h6l-1 8 8-10h-6z"/></symbol>
</defs></svg>`;

export function icon(name: string): string {
  return `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
