# Sandcastle Orchestrator

Issue-driven multi-agent orchestrator: GitHub sub-issues in, verified integration PRs out.

## Language

### Projects and runs

**Project**:
A hub repo plus its code repos and config, rooted at one directory with its own `.sandcastle/` state.
_Avoid_: Workspace, repo (when meaning the whole project)

**Project Server**:
The running `sandcastle ui` process serving exactly one Project.
_Avoid_: Instance, backend

**Dashboard**:
The process that shows every running Project Server in one UI by proxying them.
_Avoid_: Hub (collides with hub repo), aggregator

**Instance Registry**:
The shared record of which Project Servers are running and where to reach them.
_Avoid_: Discovery file, index

**Known Project**:
A Project recorded in the Instance Registry, whether or not its Project Server is currently running.
_Avoid_: Saved project, recent project

**Idle Project Server**:
A Project Server started without a parent, waiting for the operator to pick one from the UI.
_Avoid_: Empty server, blank run

### Views

**Board View**:
The default dashboard page: Project rail, Needs Attention, and each Run as a Stage board.
_Avoid_: New UI, workspace view, main view

**Legacy View**:
The original single-project dashboard page, kept reachable but no longer the default.
_Avoid_: Old UI, classic view

### Work

**Orchestration Issue**:
The parent GitHub issue whose sub-issues make up one feature's work.
_Avoid_: Epic, parent ticket

**Run**:
One execution of an Orchestration Issue on a Project Server, from start until it settles.
_Avoid_: Job, session

**Item**:
One sub-issue of an Orchestration Issue, carried through the Stage chain by agents.
_Avoid_: Task, ticket

**Stage**:
One configured step in an Item's chain (e.g. develop, review, verify).
_Avoid_: Step, phase

**Phase**:
An Item's scheduling state: held, blocked, queued, running, awaiting, waiting, parked or done.
_Avoid_: Status, stage

**Phase Clock**:
Time since an Item last changed Phase or Stage; resets on every such change.
_Avoid_: Elapsed, runtime

**Stall**:
A Run in which nothing can advance until a human acts (only parked, held or blocked Items remain).
_Avoid_: Stuck item, hang

**Quiet**:
A running Item whose agent has produced no output for over half its idle timeout — a warning before the timeout parks it.
_Avoid_: Stalled item, silent, idle

**Hold**:
A Run-wide pause on starting Stages because the agent provider is rate-limited or credentials were rejected.
_Avoid_: Block, freeze

### Operating

**Needs Attention**:
The list of conditions only the operator can resolve, gathered across Projects.
_Avoid_: Alerts, notifications, inbox

**Run Lifecycle**:
The macro steps of a Run: Items → Integration → Feature Verify → Polish → PRs.
_Avoid_: Pipeline (that's the Stage chain), gates

**Run Cap**:
Maximum Items of one Run with agents working at once.
_Avoid_: Worker cap, parent cap

**Project Cap**:
Maximum agents working at once across every Run of one Project.
_Avoid_: Global cap (legacy name), machine cap

**Pause**:
Stop starting new Stages; agents already working finish their current Stage.
_Avoid_: Stop, freeze

**Operator**:
The human who launches Runs and resolves Needs Attention.
_Avoid_: User, admin

**Orchestrator Agent**:
A coding-agent session driving a Run end to end through the `sandcastle-run` skill on the Operator's behalf.
_Avoid_: Babysitter, operator agent, bot
