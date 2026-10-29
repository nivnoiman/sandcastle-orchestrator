import type { AttentionEntry } from "../attention.js";
import type { UiFeedLine } from "../../state.js";
import { chooseRun, type BoardProject } from "../model.js";
import type { UiRun } from "../../state.js";

export type Theme = "auto" | "light" | "dark";
export type BoardScope = "project" | "dashboard";

export interface ResetLine {
  title: string;
  text: string;
  canApply: boolean;
  busy: boolean;
}

/** Side drawer: one at a time. Log data for an item is fetched by the client and stored here. */
export type DrawerState =
  | {
      kind: "item";
      projectId: string;
      itemNumber: number;
      attempts: { id: string; stage: string; attempt: number; outcome: string | undefined; live: boolean; bytes: number; startedAt: string }[];
      attemptId: string | undefined;
      raw: boolean;
      loaded: boolean;
    }
  | { kind: "reset"; projectId: string; parent: number | undefined; reset: ResetLine }
  | { kind: "add"; projectId: string; title: string; text: string; busy: boolean; result: string | undefined };

export interface SwitcherState {
  query: string;
  index: number;
}

/** Confirm dialog for a human action on a parked item; `result` replaces the confirm buttons once the action ran. */
export interface DialogState {
  kind: "requeue" | "hold" | "comment";
  projectId: string;
  itemNumber: number;
  runNumber: number | undefined;
  title: string;
  stage: string | undefined;
  reason: string;
  text: string;
  busy: boolean;
  result: { ok: boolean; message: string } | undefined;
}

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

export interface Toast {
  id: number;
  tone: "error" | "info";
  message: string;
}

/** Everything the pure renderers read; the client owns and mutates it. */
export interface BoardUi {
  scope: BoardScope;
  projects: BoardProject[];
  currentId: string;
  /** Remembered run tab per project id. */
  selectedRuns: Record<string, number | undefined>;
  feedAll: boolean;
  /** The Event feed panel; closed by default, remembered per browser. */
  feedOpen: boolean;
  /** `${projectId}:${runNumber}` of runs whose merged column is expanded. */
  doneOpen: ReadonlySet<string>;
  parentQuery: string;
  selectedParent: string;
  /** Run Cap typed into the start form; undefined follows the project's saved cap. */
  startCap: string | undefined;
  theme: Theme;
  /** Dashboard reachability for the Project Server rail link; undefined until probed. */
  dashboard: { url: string; up: boolean | undefined } | undefined;
  nowMs: number;
  /** Client-side feed lines (action errors) per project id. */
  localFeed: Record<string, UiFeedLine[]>;
  drawer: DrawerState | undefined;
  switcher: SwitcherState | undefined;
  toasts: Toast[];
  dialog: DialogState | undefined;
  /** Parked entries the operator put on Hold; kept out of the badge and the banner. */
  held: readonly AttentionEntry[];
  notifyPermission: NotifyPermission;
  busy: ReadonlySet<string>;
  /** Item card to flash after a "waits on" jump. */
  flash: string | undefined;
}

export function currentProject(ui: Pick<BoardUi, "projects" | "currentId">): BoardProject | undefined {
  return ui.projects.find((project) => project.id === ui.currentId) ?? ui.projects[0];
}

export function currentRun(ui: Pick<BoardUi, "projects" | "currentId" | "selectedRuns">): UiRun | undefined {
  const project = currentProject(ui);
  if (!project) return undefined;
  return chooseRun(project.state, ui.selectedRuns[project.id]);
}
