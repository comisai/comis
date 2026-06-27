// SPDX-License-Identifier: Apache-2.0
// @allow-throw: scheduler wiring guards; consumed at daemon.ts bootstrap catch boundary.
/**
 * Per-agent scheduler, browser service, session reset, and task extraction
 * setup: cron schedulers with executeJob callbacks, BrowserService instances
 * with unique CDP ports, SessionResetSchedulers with runtime config, and
 * per-agent task extractors with pluggable LLM extraction.
 *
 * Isolates the per-agent scheduler/browser/reset/task-extraction creation
 * loops from the main daemon wiring sequence.
 * @module
 */

import type { AppContainer, SkillsConfig, ClockPort, TimerPort } from "@comis/core";
import { safePath, SkillsConfigSchema, formatSessionKey, systemNowMs, systemSetTimeout, resolveAutonomy } from "@comis/core";
import type { BoundedAutonomyBudgetHolder } from "@comis/agent";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import type { createSessionStore } from "@comis/memory";
import type { createSessionLifecycle, SessionResetScheduler } from "@comis/agent";
import { createSessionResetScheduler } from "@comis/agent";
import {
  computeNextRunAtMs,
  createCronScheduler,
  createCronStore,
  createExecutionTracker,
  resolveEffectiveHeartbeatConfig,
  resolveHeartbeatSessionKey,
  type CronScheduler,
  type SystemEventQueue,
  type ExecutionTracker,
} from "@comis/scheduler";
import type { ComputeDailyResetNextRun } from "@comis/core";

/**
 * OBS-2/6b (hindsight-reflection-20260626): record a completed `__REFLECT__` run to the firing
 * agent's execution tracker, so `cron.runs jobName "Reflection"` surfaces the reflection funnel
 * VERDICT (the admissionOutcome + counts) AND the run is POLLABLE — instead of a daemon.log grep.
 *
 * WHY here (not the cron executeJob path): the reflect sentinel is a fire-and-forget `system_event`,
 * so executeJob cannot await the ~22s reflection to record its result. Instead we fold the per-run
 * record off the content-free `reflect:funnel` event (OBS-1 put the full funnel on it). `jobId` mirrors
 * the reflect cron's id (`reflect-<agentId>`) so `resolveJobByName(scheduler,"Reflection")` resolves to
 * this history. Content-free: the summary is the closed admissionOutcome enum + counts ONLY (INV-6 —
 * never a doc body). `durationMs` is 0 (the event carries no duration; the verdict + ts are the value).
 */
export async function recordReflectFunnelRun(
  tracker: ExecutionTracker | undefined,
  funnel: {
    agentId: string;
    admissionOutcome: string;
    admitted: number;
    maxClusterCardinality: number;
    distinctTopicKeys: number;
    untrustedDrops: number;
    sourceTrajectoryCount: number;
    totalSourceChars: number;
  },
  nowMs: number,
): Promise<void> {
  if (tracker === undefined) return; // unknown/unregistered agent → no-op (never throws)
  // OBS-7: `topics=N` (distinctTopicKeys) + maxCard makes under-merge readable on `cron.runs`:
  // admitted=0 with topics>1 & maxCard=1 = successes that didn't merge (vs topics=1 maxCard>=2 = corroborated).
  const summary =
    `reflect: outcome=${funnel.admissionOutcome} admitted=${funnel.admitted}` +
    ` maxCard=${funnel.maxClusterCardinality} topics=${funnel.distinctTopicKeys} untrustedDrops=${funnel.untrustedDrops}` +
    ` src=${funnel.sourceTrajectoryCount}traj/${funnel.totalSourceChars}ch`;
  await tracker.record({ ts: nowMs, jobId: `reflect-${funnel.agentId}`, status: "ok", durationMs: 0, summary });
}

/**
 * OBS-2b (reflect-obs-20260627): record a completed `__MEMORY_LIFECYCLE__` sweep to the firing agent's
 * execution tracker, so `cron.runs jobName "Memory lifecycle"` surfaces the sweep result (scanned/
 * evicted/demoted/promoted) — instead of a `db.mjs` `evicted_at` poll. The parity recorder for the
 * forget half of learning (reflection has recordReflectFunnelRun). `jobId` mirrors the lifecycle cron's
 * id (`memory-lifecycle-<agentId>`) so `resolveJobByName(scheduler,"Memory lifecycle")` resolves to this
 * history. Content-free: counts ONLY (INV-6). Recorded off the content-free `learning:lifecycle_swept`
 * event (the sentinel is fire-and-forget, so executeJob can't await the sweep). `durationMs` is 0 (the
 * event carries no duration; the counts + ts are the value).
 */
export async function recordLifecycleRun(
  tracker: ExecutionTracker | undefined,
  swept: { agentId: string; scanned: number; promoted: number; demoted: number; evicted: number },
  nowMs: number,
): Promise<void> {
  if (tracker === undefined) return; // unknown/unregistered agent → no-op (never throws)
  const summary =
    `lifecycle: scanned=${swept.scanned} evicted=${swept.evicted}` +
    ` demoted=${swept.demoted} promoted=${swept.promoted}`;
  await tracker.record({ ts: nowMs, jobId: `memory-lifecycle-${swept.agentId}`, status: "ok", durationMs: 0, summary });
}
import { createBrowserService, type BrowserService } from "@comis/skills";
import * as fs from "node:fs/promises";
import { emitMemoryCostFeatureNotice } from "./setup-memory-cost-notice.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the scheduler/browser/reset setup phase. */
export interface SchedulersResult {
  /** Per-agent cron schedulers. */
  cronSchedulers: Map<string, CronScheduler>;
  /** Per-agent execution history trackers. */
  executionTrackers: Map<string, ReturnType<typeof createExecutionTracker>>;
  /** Per-agent browser automation services. */
  browserServices: Map<string, BrowserService>;
  /** Per-agent session reset schedulers. */
  resetSchedulers: Map<string, SessionResetScheduler>;
  /** Resolve the CronScheduler for a given agent ID. Throws if not found. */
  getAgentCronScheduler: (agentId: string) => CronScheduler;
  /** Resolve the BrowserService for a given agent ID. Throws if not found. */
  getAgentBrowserService: (agentId: string) => BrowserService;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create the full per-agent scheduler subsystem: cron schedulers with
 * executeJob callbacks, BrowserService instances with unique CDP ports,
 * and SessionResetSchedulers with runtime config getters.
 * @param deps.container        - Bootstrap output (config, event bus, secret manager)
 * @param deps.workspaceDirs    - Per-agent workspace directory paths (from setupAgents result)
 * @param deps.sessionStore     - Session persistence store (from setupMemory result)
 * @param deps.sessionManager   - Shared session manager (from setupAgents result)
 * @param deps.schedulerLogger  - Module-bound logger for scheduler subsystem
 * @param deps.agentLogger      - Module-bound logger for agent subsystem
 * @param deps.skillsLogger     - Module-bound logger for skills subsystem
 */
export async function setupSchedulers(deps: {
  container: AppContainer;
  workspaceDirs: Map<string, string>;
  sessionStore: ReturnType<typeof createSessionStore>;
  sessionManager: ReturnType<typeof createSessionLifecycle>;
  schedulerLogger: ComisLogger;
  agentLogger: ComisLogger;
  skillsLogger: ComisLogger;
  /** Filtered environment for subprocess spawning. */
  subprocessEnv?: Record<string, string>;
  /** System event queue for main-session cron routing */
  systemEventQueue?: SystemEventQueue;
  /** Callback to wake the heartbeat immediately */
  onCronWake?: (reason: string) => void;
  /** Wall-clock + monotonic time reads. */
  clock: ClockPort;
  /** Timer scheduling. Threaded into SessionResetScheduler. */
  timers: TimerPort;
  /** Phase 213-08 (RATE-02): the credential-broker lease manager. With the holder, a
   *  cron-FIRED agent_turn run mints a fresh attenuated lease at the fire site.
   *  Optional — absent ⇒ no mint (byte-identical to the pre-213 unbounded cron). */
  leaseManager?: LeaseManager;
  /** Phase 213-08 (RATE-02): the daemon-wide LATE-BOUND per-root budget holder. The
   *  schedulers are built BEFORE the cap layer that populates `current`, so the mint
   *  reads `holder.current` at FIRE time; registerRoot anchors the cron run. Optional
   *  — absent / `current` undefined ⇒ no mint. */
  boundedAutonomyHolder?: BoundedAutonomyBudgetHolder;
}): Promise<SchedulersResult> {
  const { container, workspaceDirs, sessionStore, sessionManager, schedulerLogger, agentLogger, skillsLogger, subprocessEnv, systemEventQueue, onCronWake, clock, timers, leaseManager, boundedAutonomyHolder } = deps;
  const agents = container.config.agents; // Always populated after schema transform
  const schedulerConfig = container.config.scheduler;

  // Master cost-feature kill switch (opt-out posture; renamed from memory.costFeatures.enabled to
  // memory.enabled in Phase 226). When the operator sets memory.enabled:false, EVERY LLM
  // cost-bearing memory cron is force-disabled at its registration site below — regardless of the
  // agent's own per-feature opt-in. The gated set: memoryReview, memoryUsefulnessJudge, the
  // __REFLECT__ reflection cron. NOT gated: the $0 keyless memoryLifecycle sweep. (The
  // socialModeling cron was DELETED in Phase 226 SIMPLIFY-03 with the rest of that subsystem.)
  // Default true (schema default) ⇒ byte-identical registration. Read defensively (`!== false`) so an
  // unexpectedly-absent block fails OPEN to the prior behavior rather than silently disabling features.
  const costFeaturesEnabled = container.config.memory?.enabled !== false;

  /** Resolve the formatted session key for an agent's main heartbeat session. */
  function resolveMainSessionKey(agentId: string): string {
    const agentConfig = agents[agentId];
    const effectiveConfig = resolveEffectiveHeartbeatConfig(
      schedulerConfig.heartbeat,
      agentConfig?.scheduler?.heartbeat,
    );
    const sessionKey = resolveHeartbeatSessionKey(agentId, effectiveConfig, container.config.tenantId);
    return formatSessionKey(sessionKey);
  }

  // Initialize per-agent CronSchedulers
  const cronSchedulers = new Map<string, CronScheduler>();
  const executionTrackers = new Map<string, ReturnType<typeof createExecutionTracker>>();

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    // Resolve effective cron config: per-agent overrides global
    const effectiveCron = agentConfig.scheduler?.cron ?? schedulerConfig.cron;
    if (!effectiveCron.enabled) continue;

    const agentWorkspace = workspaceDirs.get(agentId)!;
    const agentSchedulerDir = safePath(agentWorkspace, ".scheduler");
    // fs-safe-allowed: per-agent scheduler dir under operator-configured workspace (`<agentWorkspace>/.scheduler`); not ~/.comis/ directly
    await fs.mkdir(agentSchedulerDir, { recursive: true });
    const cronStorePath = safePath(agentSchedulerDir, "cron-jobs.json");
    const agentCronStore = createCronStore(cronStorePath, schedulerLogger.child({ agentId }));
    const agentExecTracker = createExecutionTracker({ logDir: agentSchedulerDir });

    executionTrackers.set(agentId, agentExecTracker);

    const scheduler = createCronScheduler({
      store: agentCronStore,
      executeJob: async (job) => {
        const startTs = systemNowMs();
        const jobLogger = schedulerLogger.child({ agentId, jobId: job.id, jobName: job.name });
        try {
          // Route main-session systemEvent jobs through heartbeat pipeline
          if (job.sessionTarget === "main" && job.payload.kind === "system_event" && systemEventQueue) {
            const mainSessionKey = resolveMainSessionKey(agentId);
            systemEventQueue.enqueue(job.payload.text, {
              contextKey: `cron:${job.id}`,
              sessionKey: mainSessionKey,
            });

            // INFO-level log for cron-triggered heartbeat routing
            jobLogger.info(
              { sessionTarget: "main", wakeMode: job.wakeMode ?? "next-heartbeat" },
              "Cron system event enqueued to heartbeat pipeline",
            );

            // Wake mode dispatch
            if (job.wakeMode === "now" && onCronWake) {
              onCronWake("cron");
              jobLogger.debug({ wakeMode: "now" }, "Immediate heartbeat wake requested");
            }

            await agentExecTracker.record({
              ts: systemNowMs(), jobId: job.id, status: "ok",
              durationMs: systemNowMs() - startTs,
              summary: "Enqueued to heartbeat pipeline",
            });
            return { status: "ok" as const, summary: "Enqueued to heartbeat pipeline" };
          }

          // --- Existing isolated/direct path below (unchanged) ---
          const resultText =
            job.payload.kind === "system_event" ? job.payload.text : job.payload.message;

          if (!job.deliveryTarget) {
            // system_event jobs STILL emit scheduler:job_result (live finding
            // 2026-06-11): the memory crons (review / consolidation /
            // reasoning / user-representation / usefulness-judge) are
            // deliveryTarget-less __SENTINEL__ jobs whose
            // actual WORK rides the scheduler:job_result listener
            // (setup-channels-credentials). The old return-before-emit made
            // every memory cron complete "ok" nightly while doing NOTHING.
            // The sentinel listeners return before delivery; a non-sentinel
            // deliveryTarget-less system_event hits the listener's own
            // skip-delivery warn — no delivery is ever attempted either way.
            if (job.payload.kind === "system_event") {
              container.eventBus.emit("scheduler:job_result", {
                jobId: job.id,
                jobName: job.name,
                agentId: job.agentId,
                result: resultText,
                success: true,
                timestamp: systemNowMs(),
                payloadKind: job.payload.kind,
                sessionStrategy: job.sessionStrategy,
                maxHistoryTurns: job.maxHistoryTurns,
                cadenceMs: job.schedule?.kind === "every" ? job.schedule.everyMs : undefined,
                cacheRetention: job.cacheRetention,
                toolPolicy: job.toolPolicy,
              });
              await agentExecTracker.record({ ts: systemNowMs(), jobId: job.id, status: "ok", durationMs: systemNowMs() - startTs, summary: "No delivery target (event emitted)" });
              return { status: "ok" as const, summary: "No delivery target (event emitted)" };
            }
            jobLogger.warn(
              { payloadKind: job.payload.kind, hint: "Job has no delivery target — result cannot be delivered. Was the job created from a channel context?", errorKind: "config" as const },
              "Cron job has no delivery target, skipping delivery",
            );
            await agentExecTracker.record({ ts: systemNowMs(), jobId: job.id, status: "ok", durationMs: systemNowMs() - startTs, summary: "No delivery target" });
            return { status: "ok" as const, summary: "No delivery target" };
          }

          jobLogger.debug(
            { payloadKind: job.payload.kind, channelType: job.deliveryTarget.channelType, channelId: job.deliveryTarget.channelId },
            "Executing cron job",
          );

          // For agent_turn jobs, await execution result via deferred callback.
          // For system_event jobs, fire-and-forget (delivered as raw text).
          const isAgentTurn = job.payload.kind === "agent_turn";
          let deferredResolve: ((result: { status: "ok" | "error"; error?: string }) => void) | undefined;
          const deferredPromise = isAgentTurn
            ? new Promise<{ status: "ok" | "error"; error?: string }>((resolve) => { deferredResolve = resolve; })
            : undefined;

          // Phase 213-08 (RATE-02): a cron-FIRED agent_turn run mints a FRESH lease
          // scoped to the JOB's agentId + the agent's RESOLVED caps (NOT operator/
          // system) + a fresh root-cron-* id (a new root, no parentLeaseId), then
          // registerRoot anchors it. STRICTLY gated on agent_turn (system_event memory
          // crons do NOT mint). Best-effort: absent leaseManager/holder → skip (byte-
          // identical to pre-213 unbounded cron); a mint throw is WARN-logged + job STILL runs.
          // WR-04 (213-REVIEW): the cron-fired run dispatches via `scheduler:job_result` (not `runner.spawn`), so it deliberately does NOT consult CEIL-01. Cron fan-out is already triple-bounded — `cron.maxConcurrentRuns` (caps simultaneous fires, `cron-scheduler.ts:99`), the per-root budget this mint anchors (token+wall-clock), and `cronSelfMax` (caps self-owned job count). A cron-spawned sub-agent is still CEIL-01-bound via session.spawn→resolveRootRunId (a distinct per-session root; correlating it to this `root-cron-*` is a future enhancement, not an M1 gap).
          const capLayer = boundedAutonomyHolder?.current;
          if (isAgentTurn && leaseManager && capLayer) {
            try {
              const resolved = resolveAutonomy(agents[job.agentId]?.autonomy);
              if (resolved.enabled) {
                const rootRunId = `root-cron-${job.id}-${systemNowMs().toString(36)}`;
                const issued = leaseManager.mintLease({
                  agentId: job.agentId, // the JOB's agent — the attenuation identity (NOT operator/system)
                  caps: resolved.capabilities, // attenuated to the agent's OWN resolved caps
                  budgetRef: `run-cron-${job.id}-${systemNowMs().toString(36)}`,
                  sessionKey: resolveMainSessionKey(job.agentId),
                  rootRunId,
                  // no parentLeaseId — a cron-fired run is a NEW root
                });
                capLayer.registerRoot(rootRunId, issued.leaseId);
                jobLogger.info(
                  { rootRunId, agentId: job.agentId, hint: "cron-fired run minted a fresh attenuated lease" },
                  "Cron run lease minted",
                );
              }
            } catch (mintErr) {
              jobLogger.warn(
                {
                  err: mintErr,
                  agentId: job.agentId,
                  hint: "cron-fire lease mint failed; the job still runs but is not bound by the per-root ceiling/budget this run (degraded to pre-213 unbounded-cron behavior)",
                  errorKind: "internal" as const,
                },
                "Cron-fire lease mint failed (degrading to unbounded cron run)",
              );
            }
          }

          container.eventBus.emit("scheduler:job_result", {
            jobId: job.id,
            jobName: job.name,
            agentId: job.agentId,
            result: resultText,
            success: true,
            deliveryTarget: job.deliveryTarget,
            timestamp: systemNowMs(),
            payloadKind: job.payload.kind,
            sessionStrategy: job.sessionStrategy,
            maxHistoryTurns: job.maxHistoryTurns,
            // Cadence is a literal number only for kind === "every"; cron-expression
            // schedules would require parsing the expression to estimate a cadence,
            // which is out of scope. Consumers must treat undefined as "unknown".
            cadenceMs: job.schedule.kind === "every" ? job.schedule.everyMs : undefined,
            cronJobModel: job.payload.kind === "agent_turn" ? job.payload.model : undefined,
            cacheRetention: job.cacheRetention,
            toolPolicy: job.toolPolicy,
            onComplete: deferredResolve,
          });

          // Forward isolated results to main session if requested
          if (job.forwardToMain && systemEventQueue) {
            const mainSessionKey = resolveMainSessionKey(agentId);
            systemEventQueue.enqueue(
              `Cron job "${job.name}" completed: ${resultText.slice(0, 500)}`,
              { contextKey: `cron:${job.id}:summary`, sessionKey: mainSessionKey },
            );
            jobLogger.debug({ forwardToMain: true }, "Isolated job result forwarded to main session");
            // Optionally wake for forwarded results
            if (job.wakeMode === "now" && onCronWake) {
              onCronWake("cron");
            }
          }

          // For agent_turn: await actual execution result (with 10-min timeout).
          // For system_event: return immediately as before.
          if (deferredPromise) {
            const AGENT_TURN_TIMEOUT_MS = 600_000; // 10 minutes
            const timeoutPromise = new Promise<{ status: "ok" | "error"; error?: string }>((resolve) => {
              const t = systemSetTimeout(() => resolve({ status: "error" as const, error: "Agent execution timed out (10m)" }), AGENT_TURN_TIMEOUT_MS);
              t.unref();
            });
            const execResult = await Promise.race([deferredPromise, timeoutPromise]);
            await agentExecTracker.record({
              ts: systemNowMs(), jobId: job.id,
              status: execResult.status,
              durationMs: systemNowMs() - startTs,
              ...(execResult.status === "ok" ? { summary: resultText.slice(0, 200) } : { error: execResult.error }),
            });
            return execResult;
          }

          await agentExecTracker.record({ ts: systemNowMs(), jobId: job.id, status: "ok", durationMs: systemNowMs() - startTs, summary: resultText.slice(0, 200) });
          return { status: "ok" as const, summary: resultText.slice(0, 200) };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          jobLogger.error(
            { err, durationMs: systemNowMs() - startTs, hint: "Check agent workspace and scheduler store for corruption", errorKind: "internal" as const },
            "Cron job execution failed",
          );
          await agentExecTracker.record({
            ts: systemNowMs(),
            jobId: job.id,
            status: "error",
            durationMs: systemNowMs() - startTs,
            error: errMsg,
          });
          return { status: "error" as const, error: errMsg };
        }
      },
      eventBus: container.eventBus,
      logger: schedulerLogger.child({ agentId }),
      config: {
        maxConcurrentRuns: effectiveCron.maxConcurrentRuns,
        defaultTimezone: effectiveCron.defaultTimezone || "UTC",
        maxJobs: effectiveCron.maxJobs,
        maxConsecutiveErrors: effectiveCron.maxConsecutiveErrors,
      },
    });

    await scheduler.start();
    cronSchedulers.set(agentId, scheduler);
    schedulerLogger.debug({ agentId }, "Per-agent CronScheduler started");

    // -- Memory review cron job --
    // Gated by the master cost-feature kill switch (memory.costFeatures.enabled) AND the
    // per-agent opt-in. Switch off ⇒ NOT registered even if the agent enabled it.
    const memoryReviewConfig = agentConfig.memoryReview;
    if (costFeaturesEnabled && memoryReviewConfig?.enabled) {
      const memReviewJobId = `memory-review-${agentId}`;
      const existingJobs = scheduler.getJobs();
      const alreadyRegistered = existingJobs.some((j) => j.id === memReviewJobId);
      if (!alreadyRegistered) {
        await scheduler.addJob({
          id: memReviewJobId,
          name: "Memory review",
          agentId,
          schedule: { kind: "cron", expr: memoryReviewConfig.schedule ?? "0 2 * * *" },
          payload: { kind: "system_event", text: "__MEMORY_REVIEW__" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          forwardToMain: false,
          sessionStrategy: "fresh",
          consecutiveErrors: 0,
          enabled: true,
          createdAtMs: systemNowMs(),
        });
        schedulerLogger.info({ agentId, schedule: memoryReviewConfig.schedule ?? "0 2 * * *" }, "Registered memory review cron job");
      }
    }

    // -- (Phase 225 FOLD §3.2) The standalone __MEMORY_CONSOLIDATION__ / __MEMORY_REASONING__ /
    //    __USER_REPRESENTATION__ cron registrations were REMOVED here: their work folds into the
    //    ONE __REFLECT__ cron (which now reflects skill + profile + topic in one pass, Plan 04). The
    //    I1 model — the old crons are GONE, not run in parallel. (Their now-dead job BODIES are
    //    deleted in Plan 05; this plan removes the registrations + the sentinel intercepts so they
    //    never fire.) __SOCIAL_MODELING__ was DELETED in Phase 226-04 (the block below).

    // (The social-modeling cron — __SOCIAL_MODELING__, gated by socialModeling.enabled +
    // a recorded privacyReviewSignedOffBy — was DELETED in Phase 226 SIMPLIFY-03 with the
    // ENTIRE social-modeling subsystem (the runRelationshipBuild offline directional-edge
    // builder, the createRelationshipSeam cheap-model seam, the RelationshipStore port +
    // sqlite adapter, the `relationship` table, the relationship-block prompt injection).
    // The per-agent socialModeling config key is gone — a config carrying it is now rejected
    // at parse (the D-01a operator-update path). Deleting it removes a prompt-injected
    // relationship-model attack surface; no dormant seam left behind (full delete, I1).
    // After this, the learning crons are exactly 3: __REFLECT__ + __MEMORY_LIFECYCLE__ +
    // the event-driven OutcomeSignalPort.resolve path (__MEMORY_REVIEW__ stays accumulate-tier).)

    // (The usefulness-judge cron — __USEFULNESS_JUDGE__, gated by memoryUsefulnessJudge.enabled
    // — was DELETED in Phase 226 SIMPLIFY-03 (D-03). It was a dormant cost-gated cheap-model
    // seam that fed recordUsage; the FORGET-02 reward write lives in setup-learning.ts and is
    // unaffected. The per-agent memoryUsefulnessJudge config key is gone — a config carrying it
    // is now rejected at parse, the D-01a operator-update path.)

    // (The online-tuning bandit cron — __ONLINE_TUNING__, gated by memoryOnlineTuning.enabled
    // — was DELETED in Phase 224. The UCB recall bandit is gone; recall scoring is the fixed
    // config.rag.scoring alphas, with no offline tuned-alpha write job.)

    // -- Memory lifecycle cron job --
    // OPT-IN, OFF by default. A DETERMINISTIC + KEYLESS (no LLM call, no API key — the sentinel
    // dispatch makes NO model resolution) sweep, so enabling it is a behavior opt-in, not a cost opt-in.
    // Registered ONLY when the operator sets memoryLifecycle.enabled; a default agent
    // registers NO job → byte-identical with the config absent. Default schedule 0 9 * * *
    // runs AFTER online-tuning's 0 8 so the FEED + tuned alphas it reads have settled. Job
    // options mirror the online-tuning job 1:1 (isolated / next-heartbeat / no forward-to-main
    // / fresh). The __MEMORY_LIFECYCLE__ sentinel (setup-channels-memory-crons → the DORMANT
    // runLifecycleSweep) re-checks the knob; even when on, the SCAFFOLD evicts/demotes NOTHING
    // (the live policy is the deferred operator step — OD4).
    const memoryLifecycleConfig = agentConfig.memoryLifecycle;
    if (memoryLifecycleConfig?.enabled) {
      const memLifecycleJobId = `memory-lifecycle-${agentId}`;
      const existingJobs = scheduler.getJobs();
      const alreadyRegistered = existingJobs.some((j) => j.id === memLifecycleJobId);
      if (!alreadyRegistered) {
        await scheduler.addJob({
          id: memLifecycleJobId,
          name: "Memory lifecycle",
          agentId,
          schedule: { kind: "cron", expr: memoryLifecycleConfig.schedule ?? "0 9 * * *" },
          payload: { kind: "system_event", text: "__MEMORY_LIFECYCLE__" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          forwardToMain: false,
          sessionStrategy: "fresh",
          consecutiveErrors: 0,
          enabled: true,
          createdAtMs: systemNowMs(),
        });
        schedulerLogger.info({ agentId, schedule: memoryLifecycleConfig.schedule ?? "0 9 * * *" }, "Registered memory lifecycle cron job");
      }
    }

    // (The memory triple-extraction cron — __MEMORY_TRIPLE_EXTRACTION__, gated by
    // memoryTripleExtraction.enabled — was DELETED in Phase 226 SIMPLIFY-03 (D-03). It scheduled
    // a no-op scaffold whose `extract` returned [] (no triples were ever written). The per-agent
    // memoryTripleExtraction config key is gone — a config carrying it is now rejected at parse,
    // the D-01a operator-update path. The TripleStorePort + its sqlite adapter + the graphSpread
    // recall lane SURVIVE — only the dormant extraction JOB went, not the read lane.)

    // -- Reflection cron job (v2.31 Reflection, Phase 223, REFLECT-01) --
    // The reflect-engine replacement for the dead procedural-synthesis clustering cron.
    // OPT-IN, DEFAULT OFF (the byte-identity guarantee depends on it). Registered ONLY when the
    // operator sets learning.enabled AND the master cost kill switch is on; a default agent
    // registers NO job → byte-identical with the config absent. The schedule comes from
    // learning.reflect.schedule (Phase 226 — was a hardcoded 30 9; default every 3h `0 */3 * * *`). Job
    // options mirror the other memory crons 1:1 (isolated / next-heartbeat / no forward-to-main /
    // fresh). The __REFLECT__ sentinel (setup-channels-memory-crons-wire.ts) re-checks the knob +
    // injects the @comis/memory mental-model store + the trusted-origin source into runReflection,
    // then emits the reflect:* counts (reflect:admitted + reflect:funnel — renamed from the old
    // learning:skill_* funnel in Phase 226). A reflected candidate is admitted at state:candidate.
    const learningCfg = agentConfig.learning;
    if (costFeaturesEnabled && learningCfg?.enabled) {
      const reflectJobId = `reflect-${agentId}`;
      const reflectSchedule = learningCfg.reflect?.schedule ?? "0 3 * * *";
      if (!scheduler.getJobs().some((j) => j.id === reflectJobId)) {
        await scheduler.addJob({
          id: reflectJobId,
          name: "Reflection",
          agentId,
          schedule: { kind: "cron", expr: reflectSchedule },
          payload: { kind: "system_event", text: "__REFLECT__" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          forwardToMain: false,
          sessionStrategy: "fresh",
          consecutiveErrors: 0,
          enabled: true,
          createdAtMs: systemNowMs(),
        });
        schedulerLogger.info({ agentId, schedule: reflectSchedule }, "Registered reflection cron job");
      }
    }
  }

  // First-run cost-disclosure notice (opt-out posture). Once per startup, right after the
  // cron-registration sweep: when the kill switch is ON (the default) AND at least one LLM
  // cost-bearing memory feature is active for some agent, emit ONE prominent WARN naming the
  // active features + the one-line off-switch. Today's default bare config emits nothing. Lives
  // here (not daemon.ts, which is at its 3000-line cap) — the natural cron-wiring seam, with the
  // agents map + config + logger already in scope.
  emitMemoryCostFeatureNotice({ agents, costFeaturesEnabled, logger: schedulerLogger });

  // OBS-2/6b (hindsight-reflection-20260626): fold each completed __REFLECT__ run onto the firing
  // agent's cron run history, so `cron.runs jobName "Reflection"` answers "why did the last reflection
  // admit / not-admit" in one call (the funnel verdict + counts) AND the run is pollable — instead of
  // a daemon.log grep for "Reflection complete". The reflect sentinel is fire-and-forget (system_event),
  // so we record off the content-free `reflect:funnel` event (recordReflectFunnelRun). One subscriber
  // for all agents (it resolves the agent's tracker per event); the record is non-fatal/best-effort.
  container.eventBus.on("reflect:funnel", (funnel) => {
    void recordReflectFunnelRun(executionTrackers.get(funnel.agentId), funnel, systemNowMs());
  });
  // OBS-2b (reflect-obs-20260627): the parity recorder for the forget sweep — fold each completed
  // __MEMORY_LIFECYCLE__ run onto the firing agent's cron run history, so `cron.runs jobName "Memory
  // lifecycle"` answers "what did the sweep evict/demote" in one call (was a db.mjs evicted_at poll).
  // Recorded off the content-free `learning:lifecycle_swept` event (the sentinel is fire-and-forget).
  container.eventBus.on("learning:lifecycle_swept", (swept) => {
    void recordLifecycleRun(executionTrackers.get(swept.agentId), swept, systemNowMs());
  });

  // OUTCOME-09 boot posture: `learningOutcome` (Verified Learning WS1) is NOT a cron — it is the
  // bus-wired observe/resolve subscriber stood up in setup-memory.ts (wireLearningOutcome). It is
  // force-disabled by the SAME master cost switch as the six cost crons above: the effective enable
  // is `costFeaturesEnabled && agents[id].learningOutcome.enabled` (default OFF → byte-identical).
  // Surface the effective gate state once at boot so an operator can confirm the shadow signal's
  // posture without a live repro (the gate itself is applied at the wiring site, not here).
  const learningOutcomeEnabled = (agentId: string): boolean =>
    costFeaturesEnabled && agents[agentId]?.learningOutcome?.enabled === true;
  const learningOutcomeAgents = Object.keys(agents).filter((id) => learningOutcomeEnabled(id));
  schedulerLogger.debug(
    {
      costFeaturesEnabled,
      enabledAgentCount: learningOutcomeAgents.length,
      enabledAgents: learningOutcomeAgents,
    },
    "Outcome-signal (learningOutcome) boot posture",
  );

  /** Resolve the CronScheduler for a given agent ID. Throws descriptive error if not found. */
  function getAgentCronScheduler(agentId: string): CronScheduler {
    const scheduler = cronSchedulers.get(agentId);
    if (!scheduler) {
      throw new Error(
        `CronScheduler not enabled for agent "${agentId}". ` +
        `Set agents.${agentId}.scheduler.cron.enabled: true in config.`
      );
    }
    return scheduler;
  }

  // Initialize per-agent BrowserService instances
  const browserServices = new Map<string, BrowserService>();
  let browserPortOffset = 0;

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    const agentSkillsConfig: SkillsConfig = agentConfig?.skills ?? SkillsConfigSchema.parse({});
    if (!agentSkillsConfig.builtinTools.browser) continue;

    // Assign unique CDP port per agent to avoid port conflicts
    const service = createBrowserService({ cdpPort: 9222 + browserPortOffset }, subprocessEnv);
    browserPortOffset++;
    browserServices.set(agentId, service);
    skillsLogger.info({ agentId }, "BrowserService created (idle until browser.start)");
  }

  /** Resolve the BrowserService for a given agent ID. Throws descriptive error if not found. */
  function getAgentBrowserService(agentId: string): BrowserService {
    const service = browserServices.get(agentId);
    if (!service) {
      throw new Error(
        `Browser not enabled for agent "${agentId}". ` +
        `Set agents.${agentId}.skills.builtinTools.browser: true in config.`
      );
    }
    return service;
  }

  // Initialize per-agent SessionResetSchedulers
  const resetSchedulers = new Map<string, SessionResetScheduler>();

  // Daily-reset cron callback. session-reset-policy.ts receives this via deps
  // injection (rather than importing `@comis/scheduler` directly) so the
  // agent package does not reach into scheduler internals. The closure wraps
  // `computeNextRunAtMs` over a `0 H * * *` cron schedule.
  const computeDailyResetNextRun: ComputeDailyResetNextRun = (
    updatedAt: number,
    hour: number,
    timezone: string,
  ): number | undefined => {
    return computeNextRunAtMs(
      { kind: "cron", expr: `0 ${hour} * * *`, tz: timezone || undefined },
      updatedAt,
    );
  };

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    const resetConfig = agentConfig.session?.resetPolicy;
    if (!resetConfig || resetConfig.mode === "none") continue;

    const scheduler = createSessionResetScheduler({
      sessionStore,
      sessionManager,
      eventBus: container.eventBus,
      logger: agentLogger.child({ agentId, component: "session-reset" }),
      getConfig: () => {
        // Re-read config on each sweep for runtime flexibility
        const currentAgents = container.config.agents;
        return currentAgents[agentId]?.session?.resetPolicy;
      },
      computeDailyResetNextRun,
      nowMs: clock.now.bind(clock),
      timers,
    });

    scheduler.start();
    resetSchedulers.set(agentId, scheduler);
    agentLogger.info({ agentId, mode: resetConfig.mode }, "Per-agent SessionResetScheduler started");
  }

  return {
    cronSchedulers,
    executionTrackers,
    browserServices,
    resetSchedulers,
    getAgentCronScheduler,
    getAgentBrowserService,
  };
}
