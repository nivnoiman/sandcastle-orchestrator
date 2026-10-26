---
name: Sandcastle Board View
description: A quiet, dense operator workspace for watching and steering agent runs across projects.
colors:
  ground: "oklch(0.972 0.005 245)"
  surface: "oklch(1 0 0)"
  surface-2: "oklch(0.955 0.007 245)"
  line: "oklch(0.9 0.01 245)"
  line-strong: "oklch(0.82 0.014 245)"
  ink: "oklch(0.24 0.02 255)"
  ink-2: "oklch(0.45 0.02 255)"
  ink-3: "oklch(0.56 0.018 255)"
  rail: "oklch(0.27 0.045 255)"
  rail-2: "oklch(0.33 0.05 255)"
  rail-ink: "oklch(0.96 0.01 250)"
  accent: "oklch(0.52 0.17 258)"
  accent-soft: "oklch(0.94 0.035 258)"
  accent-ink: "oklch(0.42 0.16 258)"
  wait: "oklch(0.7 0.14 72)"
  wait-ink: "oklch(0.5 0.12 65)"
  wait-soft: "oklch(0.96 0.04 85)"
  park: "oklch(0.57 0.19 27)"
  park-ink: "oklch(0.5 0.18 27)"
  park-soft: "oklch(0.96 0.025 25)"
  done: "oklch(0.58 0.13 155)"
  done-ink: "oklch(0.46 0.11 155)"
  done-soft: "oklch(0.95 0.035 155)"
  merge: "oklch(0.52 0.16 300)"
  merge-soft: "oklch(0.95 0.03 300)"
  idle: "oklch(0.7 0.012 255)"
typography:
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "Geist Mono, ui-monospace, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "5px"
  md: "8px"
  pill: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "30px"
    padding: "0 11px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
  button-primary-hover:
    backgroundColor: "{colors.accent-ink}"
  button-small:
    height: "24px"
    padding: "0 8px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "9px 10px"
  card-parked:
    backgroundColor: "{colors.park-soft}"
  card-waiting:
    backgroundColor: "{colors.wait-soft}"
  rail:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    width: "228px"
  tag:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    height: "20px"
---

# Design System: Sandcastle Board View

## Overview

**Creative North Star: "The Harbour Master's Desk"**

The Board View is where one operator keeps several agent runs honest. It is a working screen first: a navy rail of projects on the left, a pale ground with white panels in the middle, one board per run. Nothing is decorative. Colour only ever says what state something is in, and the loudest things on screen are the ones a person has to act on.

The mood is calm and exact. Density is high but never cramped: 8px card gaps, 13px body type, tabular numerals everywhere so clocks and counts do not jitter. Light and dark are both first-class and follow the system unless the operator pins one.

The Board View explicitly rejects the look of a marketing dashboard: no hero metrics, no gradient text, no decorative illustration, no cards of icon-plus-heading-plus-text. It is closer to a well-tuned issue tracker than a "mission control".

**Key Characteristics:**
- One sans family (Geist) for everything, Geist Mono only for branches, repos, clocks and logs.
- A committed navy rail as the shell; the work area is quiet and neutral so state colour reads instantly.
- State colour vocabulary is fixed: blue = running, amber = waiting or quiet, red = parked or failed, green = merged, purple = ready for your merge.
- Every state is also named in text; colour is never the only signal.

## Colors

A cool-neutral ground with one blue accent and four state colours. All values are OKLCH and defined once as custom properties on `:root`; dark mode redefines the same names.

### Primary
- **Harbour Blue** (`oklch(0.52 0.17 258)`): the accent. Primary buttons, selected tab underline, running items, links on pale surfaces use its darker `accent-ink`. Used for action and "running" only.

### Secondary
- **Tide Amber** (`oklch(0.7 0.14 72)`, text `wait-ink`): waiting, blocked, Quiet markers, rework tags, rate-limit Holds, and the dry-mode stripe.
- **Signal Red** (`oklch(0.57 0.19 27)`, text `park-ink`): parked items, red Feature Verify, auth Holds, destructive controls, the rail badge.
- **Reef Green** (`oklch(0.58 0.13 155)`): merged and green gates.
- **Gull Purple** (`oklch(0.52 0.16 300)`): an Integration ready for the operator's merge, the PRs step of the Run Lifecycle.

### Neutral
- **Ground** (`oklch(0.972 0.005 245)`) is the page. **Surface** (white) holds panels and cards. **Surface 2** tints queued cards, the merged column and chips.
- **Ink / Ink 2 / Ink 3** are the three text steps; Ink 3 is the floor for secondary text and stays above 4.5:1 on surface.
- **Rail** (`oklch(0.27 0.045 255)`, deeper in dark) is the one committed colour in the shell.

### Named Rules
**The State Vocabulary Rule.** A colour means exactly one state on every screen. Never reuse amber for decoration or blue for emphasis outside running and actions.

**The Text Backs Colour Rule.** A state is always named in words next to its colour (Parked, Waiting, quiet 10m / 20m). Colour alone never carries meaning.

## Typography

**Display Font:** none. **Body and UI Font:** Geist (variable, vendored under `src/ui/board/fonts`, SIL OFL). **Mono Font:** Geist Mono for branches, repos, clocks, logs and CLI hints.

**Character:** a neutral, slightly geometric sans that stays legible at 11-13px. Type does the structuring; there are no display sizes.

### Hierarchy
- **Headline** (600, 19px, -0.015em): the project name in the top bar.
- **Title** (600, 15px): run title, drawer title.
- **Panel heading** (600, 13.5px): Needs attention, Event feed, Run queue.
- **Body** (400, 13px / 1.45): card titles are 500 at 13px; notes and reasons 12 to 12.5px.
- **Label** (500, 11.5-12.5px): buttons, tags, field labels, legend.
- **Mono** (12px): branches, repo names, Phase Clock, transcript.

### Named Rules
**The Tabular Rule.** `font-variant-numeric: tabular-nums` is on at the body so counts and clocks never reflow.

**The One Family Rule.** No second sans, no display face. Mono is for machine text only.

## Layout

A three-part shell: a 228px rail, a fluid main column with 24px side padding, and, from 1680px up, a 340px side column that holds the Event feed and Run queue. Below 1680px those two panels move under the board; below 1024px the rail becomes a horizontal strip with the project list scrolling sideways.

The main column reads top to bottom in the order of urgency: top bar (project, mode, agents meter, Project Cap, Pause project, Reset), dry-mode banner when relevant, Needs Attention, run tabs, the active run (run bar, Run Lifecycle strip, progress bar, Feature Verify and Polish gates, Stage board), then feed and queue.

The Stage board is a horizontal grid, one column per configured Stage plus the first (waiting) and last (merged) column; each column is at least 150px and the board scrolls sideways rather than squeezing cards. Rhythm is 4/8/12/16/24.

### Responsive
Structure changes, type does not: sidebar collapses, side column folds under the board, the Run Lifecycle strip drops to two columns under 720px. No fluid type.

## Elevation & Depth

Mostly flat with tonal layering: ground, surface, surface-2. Panels carry one soft two-layer shadow (`0 1px 2px` plus `0 4px 12px`, ink at 5-6%). The drawer and Ctrl K switcher use a larger diffuse shadow and a faint scrim. Cards are flat at rest and gain the panel shadow on hover.

### Named Rules
**The Flat-Until-Touched Rule.** Cards have a 1px border and no shadow at rest; depth appears on hover and for overlays only.

## Shapes

Small, consistent radii: 5px controls, 7-8px cards and panels, pill (10px) for tags and chips, full circle for status dots and Run Lifecycle nodes. Borders are 1px `line`; dashed 1px marks a collapsible fold. The Run Lifecycle strip joins circular nodes with a 2px rule.

## Components

- **Buttons:** 30px, 1px strong border, 5px radius; primary is filled Harbour Blue; danger is red text with a red-tinted hover; `sm` is 24px; ghost has no border; icon buttons are square. All have visible hover, `:focus-visible` (2px accent outline), active (1px press) and disabled (45% opacity) states.
- **Tags and chips:** 20px pills in surface-2 or a state soft colour. The dry chip is a striped amber pill and is the only loud chip.
- **Cards:** white, 1px border, 7px radius. Parked is red-soft, waiting is amber-soft, queued/blocked/held are surface-2. Selected adds a 1px accent ring. A card shows number, repo, title, a status line with the Phase Clock, an optional note, and Log / Cancel / Retry.
- **Waits-on chips:** small bordered pills (`#153`) that scroll to and flash the blocking card.
- **Rail project row:** status dot, name, hub repo in mono, a one-line summary and a badge (red count, purple for ready-to-merge). The current project has a lighter fill and inset border.
- **Needs Attention rows:** icon, bold what, one-line why, actions; other projects are dimmed and tagged.
- **Drawers and overlays:** the item, Reset and Add orchestration issue drawers slide from the right (580px max); Ctrl K is a centred listbox. Both close on Esc.
- **Toasts:** bottom right, error tone uses red-soft; errors are also written to the Event feed.
- **Inputs:** 30px high number, search and select controls with the same border as buttons.

## Do's and Don'ts

### Do
- Keep every state paired with a word and a colour from the vocabulary.
- Use the Phase Clock, countdowns and counts in tabular numerals.
- Collapse structure (rail, side column, strip) at breakpoints instead of scaling type.
- Escape every string that comes from GitHub or an agent before it reaches HTML.

### Don't
- Don't add a second accent colour or use state colours for decoration.
- Don't use a coloured border-left or border-right above 1px to mark a card or alert.
- Don't use gradient text, glass blur, hard offset shadows or hero-number tiles.
- Don't put Geist Mono on prose, or any display face on labels.
- Don't use a modal where a drawer or an inline control will do.
