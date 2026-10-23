import type { AgentStage, ResolveRequest, SpawnRequest } from "../engine/adapters.js";
import { itemBranch } from "../engine/engine.js";
import type { RunModel, TargetRepo, WorkItem } from "../model/runModel.js";
import type { ResolvedMemory } from "./memories.js";
import type { ResolvePromptContext, StagePromptContext } from "./promptBuilder.js";

export interface RunContextDeps {
  loadMemories: (slugs: readonly string[]) => ResolvedMemory[];
  hubRepo: string;
}

export interface ItemLocation {
  repo: TargetRepo;
  branch: string;
}

export class RunContext {
  private model: RunModel;
  private readonly branches = new Map<number, string>();
  private readonly memoryCache = new Map<number, ResolvedMemory[]>();

  constructor(model: RunModel, private readonly deps: RunContextDeps) {
    this.model = model;
  }

  update(model: RunModel): void {
    this.model = model;
    for (const item of model.items) this.memoryCache.delete(item.number);
  }

  runModel(): RunModel {
    return this.model;
  }

  get feature(): string {
    return this.model.feature;
  }

  get parentNumber(): number {
    return this.model.parentNumber;
  }

  get integrationBranch(): string {
    return this.model.integrationBranch;
  }

  item(itemNumber: number): WorkItem {
    const found = this.model.items.find((candidate) => candidate.number === itemNumber);
    if (!found) throw new Error(`#${itemNumber} is not in the current run model`);
    return found;
  }

  rememberBranch(itemNumber: number, branch: string): void {
    this.branches.set(itemNumber, branch);
  }

  locate(itemNumber: number): ItemLocation {
    const item = this.item(itemNumber);
    return { repo: item.repo, branch: this.branches.get(itemNumber) ?? itemBranch(item) };
  }

  requiredReading(repo: TargetRepo): readonly string[] {
    return this.model.requiredReading[repo] ?? [];
  }

  memories(itemNumber: number): ResolvedMemory[] {
    const cached = this.memoryCache.get(itemNumber);
    if (cached) return cached;
    const item = this.item(itemNumber);
    const resolved = this.deps.loadMemories([...this.model.loadBearingMemories, ...item.extraMemories]);
    this.memoryCache.set(itemNumber, resolved);
    return resolved;
  }

  promptContext(request: SpawnRequest): StagePromptContext {
    return {
      stage: request.stage satisfies AgentStage,
      ...this.resolveContext(request),
      rebaseConflicts: request.rebaseConflicts ?? [],
      ...(request.rework ? { rework: request.rework } : {}),
    };
  }

  resolveContext(request: Omit<ResolveRequest, "files">): ResolvePromptContext {
    const item = this.item(request.itemNumber);
    return {
      item,
      branch: request.branch,
      integrationBranch: request.integrationBranch,
      requiredReading: this.requiredReading(item.repo),
      memories: this.memories(request.itemNumber),
      hubRepo: this.deps.hubRepo,
      parentNumber: this.model.parentNumber,
      feature: this.model.feature,
    };
  }
}
