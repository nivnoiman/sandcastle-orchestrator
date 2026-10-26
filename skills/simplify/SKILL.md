---
name: simplify
description: Review the changed code for reuse of what already exists, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /mat-review for that. Use when the user wants a branch, a PR, or work-in-progress changes simplified or tidied, or asks to "simplify since X".
---

Simplify the diff between `HEAD` and a fixed point the user supplies — a commit SHA, branch name, tag, `main`, `HEAD~5`.

This skill **applies** its findings. Reporting a list and stopping is a failed run.

**Scope: quality only.** Correctness is someone else's axis — if the code is wrong, `/mat-review` says so. Here the code is assumed to work, and the question is whether it is the simplest, most reusing, best-pitched version of itself. Never "fix" behaviour under this skill; a change that alters what the code does is out of scope, and belongs in a separate ticket.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point. If none was supplied, default to the branch this work is based on (`origin/<base branch>`, falling back to `origin/dev` then `origin/main`), state which one you picked, and carry on — this skill often runs unattended, so never stop to ask.

Read the change with `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base) and list its commits with `git log <fixed-point>..HEAD --oneline`.

Confirm the ref resolves (`git rev-parse <fixed-point>`) and the diff is non-empty before going further. A bad ref or an empty diff fails here.

**Only changed code is in scope.** Untouched code the diff merely sits next to is out of scope, however tempting.

### 2. Learn what already exists

Before proposing a single change, read the modules the diff imports from and the neighbouring files in each directory it touches. Most simplification findings are "this already exists" findings, and you cannot see them without knowing the surrounding code.

Note the repo's own conventions — a documented standard (`CLAUDE.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`) always overrides this skill's defaults.

### 3. Find, along four axes

Walk the diff hunk by hunk against each axis. Every finding names the file, quotes the hunk, and states the concrete replacement — "this could be cleaner" is not a finding.

**Reuse** — the change reimplements something the codebase already has.

- A helper, hook, util, type, constant, or fixture that already exists is being written again inline.
- A third pasted variant of a shape that appears twice already — extract it and call it from all three.
- A hand-rolled version of something the language or an already-installed dependency does (`Object.groupBy`, `Array.at`, a date library already in `package.json`).
- A new type structurally identical to an existing domain type — use the existing one rather than a parallel shape.

**Simplification** — the code says more than it needs to.

- Nesting that early returns or guard clauses flatten.
- A conditional whose branches differ in one expression — lift the difference, drop the branch.
- Booleans threaded through several call layers to steer behaviour at the bottom — split the function, or pass the decision, not the flag.
- Intermediate variables, wrappers, options bags, and parameters with exactly one caller and one value.
- Defensive branches for states the types already exclude.
- Abstraction with a single implementation and no second one in sight — inline it back.
- Comments explaining *what* the code does — the code should say it; extract a well-named function instead.

**Efficiency** — the code does avoidable work, where it is visible and free to fix.

- Repeated work inside a loop that is loop-invariant.
- A query, read, or expensive call inside a loop that could be one batched call outside it.
- Repeated linear scans over the same collection where one pass, or one lookup map, serves.
- Only chase this where the fix is local and obvious. Do not restructure for speculative performance, and do not trade clarity for micro-optimisation.

**Altitude** — the code is written at the wrong abstraction level.

- One function mixing levels: business intent next to byte-shuffling. Extract the low-level part behind a name that states the intent.
- Callers assembling low-level steps that belong behind one call on the module they are steering.
- A module reaching through another object's internals (`a.b().c().d()`) instead of asking it one question.
- Naming pitched at the mechanism (`processData`) where the domain has a word for it.

### 4. Apply

For each finding, in order, smallest first:

1. Make the change.
2. Run the repo's typecheck and the tests covering the touched files.
3. Commit it — small, separate commits, one finding or one tight group per commit.

**Behaviour must not change.** If a simplification cannot be made without changing behaviour, it is not a simplification: skip it and record why.

Skip — with a stated reason — any finding that is out of scope (untouched code), that the repo's documented standards endorse as-is, that would need a change the tests do not cover, or that is a judgement call the author clearly made deliberately. Skipping is legitimate; silence is not.

Stop and say so plainly if the change cannot be simplified in place — if a finding needs a redesign, a schema change, or work outside the diff. Do not commit a half-finished refactor.

### 5. Report what you did

Close with two lists:

- **Applied** — one line per fix: axis, file, what changed, commit.
- **Skipped** — one line per skipped finding: what it was, and why you left it.

If the diff is already clean, say so explicitly — "no findings" is a valid result, and must be stated rather than implied by silence.

## Why not bug hunting

Merging the two makes both worse: correctness findings crowd out quality ones, and a reviewer chasing bugs stops noticing that a helper already exists. `/mat-review` owns Standards and Spec. This skill owns whether the working code is the simplest honest version of itself. If you spot a real bug while simplifying, do not fold the fix into a `refactor:` commit — call it out in the report and let the review axis own it.
