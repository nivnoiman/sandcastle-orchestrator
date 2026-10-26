Polish the branch before PR: simplify → review+fix → strip comments.

Fixed point: $ARGUMENTS (a SHA, branch, tag, `HEAD~5`). If empty, default `origin/dev`, state the pick, continue.

## Rules — read before spawning anything
- **You are the orchestrator. You never do stage work yourself.** Each stage runs in its own subagent. If you find yourself editing a file, you've broken the command.
- **One fresh subagent per stage. Three total.** `Agent` with `subagent_type: general-purpose`. Never `fork` (inherits your context — the whole point is clean eyes). Never `SendMessage` a previous stage's agent back to life. Stage 2 must not know what stage 1 concluded, beyond the code it left behind.
- **Sequential, never parallel.** All three stages edit the same files; concurrent agents clobber each other.
- **Commit between stages** so each is revertable on its own.
- Quality only. Behaviour changes are out of scope for all three stages; note them, don't do them.

## Stage 0 — pin + baseline (orchestrator)

```bash
git rev-parse <fixed-point>          # must resolve
git diff <fixed-point>...HEAD --stat # must be non-empty
git status                           # commit or stash anything dirty first
```

Read `.github/workflows/*.yml` in each touched sub-project, extract the exact typecheck + test commands, run them. **Record the baseline pass/fail** — you need it to tell a stage-introduced break from a pre-existing one.


Substitute the real values into the three prompts below. Subagents get no context but their prompt — spell out the fixed point and the exact commands, never "the fixed point from before".

## Stage 1 — simplify (fresh subagent #1)

`Agent(subagent_type: "general-purpose")`:

> Invoke the `simplify` skill (`Skill` tool, `skill: "simplify"`; if it isn't listed, read `~/.claude/skills/simplify/SKILL.md` and follow it verbatim) against fixed point `<fixed-point>`. It **applies** its findings — reporting a list and stopping is a failed run. Then run `<typecheck cmd>` and `<test cmd>`; fix anything you broke. Do not commit. Report: files changed, one line per applied finding, test result.

On return: re-run typecheck + tests yourself. Commit `refactor: simplify <scope>`.

## Stage 2 — review + fix (fresh subagent #2)

A **new** `Agent` call — not a message to #1:

> Invoke the `review` command (`Skill` tool, `skill: "review"`; if it isn't listed, read the `review` command file and follow it verbatim) and run its checklist over `git diff <fixed-point>...HEAD` — bugs, security, types, perf, errors, quality. Then **fix** every 🔴 and 🟡, and 🔵 where the fix is local and obvious. Anything needing a behaviour change or wider refactor: list it, don't do it. Then run `<typecheck cmd>` and `<test cmd>`. Do not commit. Report each finding as file:line — severity — what you did (fixed / deferred + why).

On return: re-run typecheck + tests. Commit `fix: address review findings`.

Surface the deferred list to the user — that's the only part they must decide on.

## Stage 3 — strip comments (fresh subagent #3)

A **new** `Agent` call:

> In every file touched by `git diff <fixed-point>...HEAD --name-only`, remove all comments. Where a comment was carrying real meaning, refactor instead — extract a named function, rename the variable, introduce a named constant. Do not delete the meaning, encode it in the code.
>
> Keep: license/copyright headers, `eslint-disable*`, `@ts-expect-error`, `@ts-ignore`, `prettier-ignore`, `#!` shebangs, JSDoc on exported API, and comments inside strings/regex/JSX text.
>
> Then run `<typecheck cmd>` and `<test cmd>`. Do not commit. Report: files touched, count removed, every case where you refactored rather than deleted.

On return: `git diff` the stage yourself and confirm no `@ts-expect-error` or eslint pragma was eaten. Re-run typecheck + tests. Commit `chore: remove comments`.

## Output

```
stage 1 simplify   — N findings applied, tests PASS
stage 2 review     — X 🔴 / Y 🟡 / Z 🔵 fixed, D deferred, tests PASS
stage 3 comments   — N removed across M files, R refactored, tests PASS
```

Then the deferred list, then: "ready for PR".
