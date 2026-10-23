import type { UiSink } from "../engine/adapters.js";
import { Engine } from "../engine/engine.js";
import { fetchRunSnapshot } from "../gh/snapshot.js";
import type { RunModel } from "../model/runModel.js";
import { integrationBase } from "../project/projectConfig.js";
import { WatchLoop } from "../watch/pollDriver.js";
import { createRealAdapters } from "./adapters.js";
import { AttemptLogStore } from "./attemptLog.js";
import { controlPlaneHost, type ControlPlaneHost, type ControlPlaneOptions } from "./controlPlane.js";
import { createVerifyHarness } from "./featureVerify/verifyStrategy.js";
import type { FeatureFixBrief, FeatureRound } from "./featureVerify/featureBrief.js";
import { FEATURE_FIX_STAGE, runFeatureFix, runFeatureVerifyLoop } from "./featureVerify/featureRework.js";
import {
  idleFeatureVerify,
  involvedRepos,
  runFeatureVerify,
  type FeatureVerifyStatus,
} from "./featureVerify/runFeatureVerify.js";
import type { OrchestratorConfig } from "./env.js";
import { loadMemories } from "./memories.js";
import { DockerIntegrationHarness } from "./integrationHarness.js";
import { idlePolish, POLISH_COMMAND_FILES, runPolish, type PolishStatus } from "./polish/runPolish.js";
import { assertPreflight } from "./preflight.js";
import { collectResumeEvidence } from "./resumeEvidence.js";
import { RunContext } from "./runContext.js";

export interface ParentRunOptions {
  model: RunModel;
  workerCap: number;
  pollIntervalSeconds: number;
  skipVerify?: boolean | undefined;
  log: (message: string) => void;
  ui?: UiSink | undefined;
  onSnapshotApplied?: ((engine: Engine) => void) | undefined;
}

export type RealRunOptions = ParentRunOptions & Pick<ControlPlaneOptions, "hubRepo" | "idleTimeoutSeconds" | "skipGc">;

export interface RealRun {
  engine: Engine;
  config: OrchestratorConfig;
  finished: Promise<void>;
  featureVerify(): FeatureVerifyStatus;
  polish(): PolishStatus;
  logs: AttemptLogStore;
  tick(): void;
  stop(): void;
}

export function startRealRun(options: RealRunOptions): Promise<RealRun> {
  const host = controlPlaneHost({
    hubRepo: options.hubRepo,
    idleTimeoutSeconds: options.idleTimeoutSeconds,
    skipGc: options.skipGc,
    globalCap: options.workerCap,
    log: options.log,
  });
  return startParentRun(host, options);
}

export async function startParentRun(host: ControlPlaneHost, options: ParentRunOptions): Promise<RealRun> {
  const { model, log } = options;
  const lease = host.acquire();
  const { plane } = lease;
  const { runner, fs, layout, config, verifyMutex } = plane;
  let engineRef: Engine | undefined;
  const slots = plane.broker.slotsFor({ refill: () => engineRef?.refill() });

  try {
    await assertPreflight({
      runner,
      fs,
      layout,
      config,
      model,
      skipVerify: options.skipVerify === true,
      claudeHomeInUse: lease.shared,
      log,
    });

    const context = new RunContext(model, {
      loadMemories: (slugs) => loadMemories(fs, layout, slugs),
      hubRepo: config.hubRepo,
    });
    for (const item of model.items) context.memories(item.number);

    const logs = new AttemptLogStore({ fs, layout, parentNumber: model.parentNumber });
    const bundle = createRealAdapters({ runner, fs, layout, config, context, log, ui: options.ui, logs });
    const engine = new Engine(model, bundle.adapters, {
      workerCap: options.workerCap,
      reworkLimit: config.reworkLimit,
      slots,
      hold: plane.hold,
    });
    engineRef = engine;
    bundle.attach(engine);
    lease.attach(engine);

    log(
      `sandcastle — ${model.title} (#${model.parentNumber}) → ${model.integrationBranch},` +
        ` cap ${options.workerCap}, idle ${config.idleTimeoutSeconds}s`,
    );
    const evidence = collectResumeEvidence(model, {
      stageLabels: (itemNumber) => bundle.gh.stageLabels(itemNumber),
      remoteRefExists: (repo, branch) => bundle.git.remoteRefExists(repo, branch),
      findPullRequest: (repo, branch, baseBranch) => bundle.gh.findPullRequest(repo, branch, baseBranch),
      warn: bundle.adapters.ui.warn,
    });
    if (evidence.some((entry) => entry.stageLabels.length > 0 || entry.auditedStageIndex > 0)) {
      log("[resume] items already in flight — placing them from their labels and pull-request audit trail");
      engine.resumeFrom(evidence);
    } else {
      engine.start();
    }

    const warn = bundle.adapters.ui.warn;

    const tick = (): void => {
      engine.tick(Date.now());
    };

    const watch = new WatchLoop({
      fetchSnapshot: () => fetchRunSnapshot(config.hubRepo, model.parentNumber),
      engine: {
        applySnapshot: (next) => {
          context.update(next);
          bundle.gh.flushPendingLabels();
          engine.applySnapshot(next);
          tick();
          plane.pollAuth();
          options.onSnapshotApplied?.(engine);
        },
      },
      intervalMs: options.pollIntervalSeconds * 1000,
      stopWhen: () => engine.complete(),
      onInvalidSnapshot: (errors) =>
        warn(model.parentNumber, `parent issue no longer satisfies the publish contract, ignoring this poll: ${errors.join("; ")}`),
      onError: (error) => warn(model.parentNumber, `poll failed: ${error.message}`),
    });

    let verifyStatus = idleFeatureVerify();

    const featureVerify = async (): Promise<void> => {
      if (!engine.complete()) {
        log("[feature-verify] the run ended with items still open — feature verify did not run");
        return;
      }
      if (options.skipVerify) {
        verifyStatus = idleFeatureVerify("skipped");
        log(
          "[feature-verify] SKIPPED by --skip-verify — no throwaway environment, no report on the parent," +
            ` and no ${model.integrationBranch} → ${integrationBase()} pull request was opened`,
        );
        return;
      }
      verifyStatus = idleFeatureVerify("running");
      const verifyModel = context.runModel();
      const verifyRound = (round: FeatureRound) =>
        runFeatureVerify({
          harness: createVerifyHarness({
            runner,
            fs,
            layout,
            config,
            git: bundle.git,
            parentNumber: model.parentNumber,
            feature: model.feature,
            integrationBranch: model.integrationBranch,
            involvedRepos: involvedRepos(verifyModel),
            log,
          }),
          gh: bundle.gh,
          model: verifyModel,
          hubRepo: config.hubRepo,
          rework: round,
          log,
          warn,
        });
      const verify = (round: FeatureRound) => {
        const rework = verifyStatus.rework;
        if (verifyMutex.busy()) {
          verifyStatus = { ...idleFeatureVerify("waiting"), rework };
          log("[feature-verify] another parent's Feature Verify holds the verify environment — waiting for it");
        }
        return verifyMutex.runExclusive(() => {
          verifyStatus = { ...idleFeatureVerify("running"), rework };
          return verifyRound(round);
        });
      };
      const fix = (briefs: readonly FeatureFixBrief[], round: FeatureRound) =>
        runFeatureFix({
          harness: new DockerIntegrationHarness({
            agent: { stage: FEATURE_FIX_STAGE, model: config.model, requiredCommands: [] },
            runner,
            fs,
            layout,
            config,
            git: bundle.git,
            parentNumber: model.parentNumber,
            integrationBranch: model.integrationBranch,
            log,
            logs,
          }),
          model: verifyModel,
          hubRepo: config.hubRepo,
          briefs,
          round,
          warn,
        });
      try {
        verifyStatus = await runFeatureVerifyLoop({
          gh: bundle.gh,
          model: verifyModel,
          limit: config.featureReworkLimit,
          verify,
          fix,
          onStatus: (status) => {
            verifyStatus = status;
          },
          log,
          warn,
        });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        verifyStatus = { ...idleFeatureVerify("red"), reason };
        warn(model.parentNumber, `feature verify crashed: ${reason}`);
      }
    };

    let polishStatus = idlePolish();

    const polish = async (): Promise<void> => {
      if (!engine.complete()) return;
      if (options.skipVerify) {
        polishStatus = idlePolish("skipped", `feature verify was skipped, so no integration → ${integrationBase()} pull request exists`);
        return;
      }
      if (verifyStatus.phase !== "green") return;
      polishStatus = idlePolish("running");
      const harness = new DockerIntegrationHarness({
        agent: { stage: "polish", model: config.reviewModel, requiredCommands: POLISH_COMMAND_FILES },
        runner,
        fs,
        layout,
        config,
        git: bundle.git,
        parentNumber: model.parentNumber,
        integrationBranch: model.integrationBranch,
        log,
        logs,
      });
      try {
        polishStatus = await runPolish({ harness, gh: bundle.gh, model: context.runModel(), hubRepo: config.hubRepo, log, warn });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        polishStatus = idlePolish("reverted", reason);
        warn(model.parentNumber, `polish crashed: ${reason}`);
      }
    };

    const finished = watch
      .run()
      .finally(() => slots.detach())
      .then(featureVerify)
      .then(polish)
      .finally(() => lease.release());

    const stop = (): void => {
      watch.stop();
      slots.detach();
    };

    return { engine, config, finished, featureVerify: () => verifyStatus, polish: () => polishStatus, logs, tick, stop };
  } catch (cause) {
    slots.detach();
    lease.release();
    throw cause;
  }
}
