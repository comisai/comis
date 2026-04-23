// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent scheduler, browser service, session reset, and task extraction
 * setup: cron schedulers with executeJob callbacks, BrowserService instances
 * with unique CDP ports, SessionResetSchedulers with runtime config, and
 * per-agent task extractors with pluggable LLM extraction.
 * Extracted from daemon.ts steps 6.6.5 through 6.6.5.7 to isolate the
 * per-agent scheduler/browser/reset/task-extraction creation loops from
 * the main wiring sequence.
 * @module
 */

import type { AppContainer, SkillsConfig } from "@comis/core";
import { safePath, SkillsConfigSchema, formatSessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { createSessionStore } from "@comis/memory";
import type { createSessionLifecycle, SessionResetScheduler } from "@comis/agent";
import { createSessionResetScheduler } from "@comis/agent";
import {
  createCronScheduler,
  createCronStore,
  createExecutionTracker,
  createTaskExtractor,
  createTaskStore,
  resolveEffectiveHeartbeatConfig,
  resolveHeartbeatSessionKey,
  type CronScheduler,
  type SystemEventQueue,
  type TaskExtractor,
} from "@comis/scheduler";
import { createBrowserService, type BrowserService } from "@comis/skills";
import * as fs from "node:fs/promises";

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
}): Promise<SchedulersResult> {
  const { container, workspaceDirs, sessionStore, sessionManager, schedulerLogger, agentLogger, skillsLogger, subprocessEnv, systemEventQueue, onCronWake } = deps;
  const agents = container.config.agents; // Always populated after schema transform
  const schedulerConfig = container.config.scheduler;

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

  // 6.6.5. Initialize per-agent CronSchedulers
  const cronSchedulers = new Map<string, CronScheduler>();
  const executionTrackers = new Map<string, ReturnType<typeof createExecutionTracker>>();

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    // Resolve effective cron config: per-agent overrides global
    const effectiveCron = agentConfig.scheduler?.cron ?? schedulerConfig.cron;
    if (!effectiveCron.enabled) continue;

    const agentWorkspace = workspaceDirs.get(agentId)!;
    const agentSchedulerDir = safePath(agentWorkspace, ".scheduler");
    await fs.mkdir(agentSchedulerDir, { recursive: true });
    const cronStorePath = safePath(agentSchedulerDir, "cron-jobs.json");
    const agentCronStore = createCronStore(cronStorePath, schedulerLogger.child({ agentId }));
    const agentExecTracker = createExecutionTracker({ logDir: agentSchedulerDir });

    executionTrackers.set(agentId, agentExecTracker);

    const scheduler = createCronScheduler({
      store: agentCronStore,
      executeJob: async (job) => {
        const startTs = Date.now();
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
              ts: Date.now(), jobId: job.id, status: "ok",
              durationMs: Date.now() - startTs,
              summary: "Enqueued to heartbeat pipeline",
            });
            return { status: "ok" as const, summary: "Enqueued to heartbeat pipeline" };
          }

          // --- Existing isolated/direct path below (unchanged) ---
          const resultText =
            job.payload.kind === "system_event" ? job.payload.text : job.payload.message;

          if (!job.deliveryTarget) {
            jobLogger.warn(
              { payloadKind: job.payload.kind, hint: "Job has no delivery target — result cannot be delivered. Was the job created from a channel context?", errorKind: "config" as const },
              "Cron job has no delivery target, skipping delivery",
            );
            await agentExecTracker.record({ ts: Date.now(), jobId: job.id, status: "ok", durationMs: Date.now() - startTs, summary: "No delivery target" });
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

          container.eventBus.emit("scheduler:job_result", {
            jobId: job.id,
            jobName: job.name,
            agentId: job.agentId,
            result: resultText,
            success: true,
            deliveryTarget: job.deliveryTarget,
            timestamp: Date.now(),
            payloadKind: job.payload.kind,
            sessionStrategy: job.sessionStrategy,
            maxHistoryTurns: job.maxHistoryTurns,
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
              const t = setTimeout(() => resolve({ status: "error" as const, error: "Agent execution timed out (10m)" }), AGENT_TURN_TIMEOUT_MS);
              t.unref();
            });
            const execResult = await Promise.race([deferredPromise, timeoutPromise]);
            await agentExecTracker.record({
              ts: Date.now(), jobId: job.id,
              status: execResult.status,
              durationMs: Date.now() - startTs,
              ...(execResult.status === "ok" ? { summary: resultText.slice(0, 200) } : { error: execResult.error }),
            });
            return execResult;
          }

          await agentExecTracker.record({ ts: Date.now(), jobId: job.id, status: "ok", durationMs: Date.now() - startTs, summary: resultText.slice(0, 200) });
          return { status: "ok" as const, summary: resultText.slice(0, 200) };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          jobLogger.error(
            { err, durationMs: Date.now() - startTs, hint: "Check agent workspace and scheduler store for corruption", errorKind: "internal" as const },
            "Cron job execution failed",
          );
          await agentExecTracker.record({
            ts: Date.now(),
            jobId: job.id,
            status: "error",
            durationMs: Date.now() - startTs,
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
    const memoryReviewConfig = agentConfig.memoryReview;
    if (memoryReviewConfig?.enabled) {
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
          createdAtMs: Date.now(),
        });
        schedulerLogger.info({ agentId, schedule: memoryReviewConfig.schedule ?? "0 2 * * *" }, "Registered memory review cron job");
      }
    }
  }

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

  // 6.6.5.5. Initialize per-agent BrowserService instances
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

  // 6.6.5.7. Initialize per-agent SessionResetSchedulers
  const resetSchedulers = new Map<string, SessionResetScheduler>();

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
      nowMs: undefined, // Use real clock in production
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

// ===========================================================================
// Task Extraction
// ===========================================================================

// ---------------------------------------------------------------------------
// Deps / Result types
// ---------------------------------------------------------------------------

/** Dependencies for task extraction setup. */
export interface TaskExtractionDeps {
  /** Bootstrap output (config.scheduler.tasks, eventBus). */
  container: AppContainer;
  /** Per-agent workspace directories (from setupAgents result). */
  workspaceDirs: Map<string, string>;
  /** Module-bound logger for scheduler subsystem. */
  schedulerLogger: ComisLogger;
}

/** All services produced by the task extraction setup phase. */
export interface TaskExtractionResult {
  /** Per-agent task extractors (only for agents with tasks enabled). */
  taskExtractors: Map<string, TaskExtractor>;
  /**
   * Callback for the execution pipeline. If task extraction is disabled
   * for the given agent (or globally), this is a no-op.
   */
  extractFromConversation: (
    conversationText: string,
    sessionKey: string,
    agentId: string,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create per-agent task extractors and return an extraction callback
 * for the execution pipeline.
 * The extraction callback is safe to call unconditionally -- it checks
 * the feature gate internally and returns immediately if disabled.
 */
export function setupTaskExtraction(deps: TaskExtractionDeps): TaskExtractionResult {
  const { container, workspaceDirs, schedulerLogger } = deps;
  const tasksConfig = container.config.scheduler.tasks;
  const agents = container.config.agents;
  const taskExtractors = new Map<string, TaskExtractor>();

  if (!tasksConfig.enabled) {
    schedulerLogger.debug("Task extraction disabled globally");
    return {
      taskExtractors,
      extractFromConversation: async () => { /* no-op when disabled */ },
    };
  }

  for (const [agentId] of Object.entries(agents)) {
    const agentWorkspace = workspaceDirs.get(agentId);
    if (!agentWorkspace) continue;

    const storePath = safePath(agentWorkspace, ".scheduler", "tasks.json");
    const store = createTaskStore(storePath);

    // Pluggable extraction function -- in production this would wrap an LLM call.
    // For now, create a placeholder that returns empty tasks. The daemon can
    // override this with a real LLM-based extraction when the agent executor
    // integration is fully wired (Phase TBD).
    const extractFn = async () => {
      // TODO: Wire to agent executor LLM call for real extraction
      return { tasks: [], reasoning: "Extraction function not yet wired to LLM" };
    };

    const extractor = createTaskExtractor({
      extractFn,
      store,
      logger: schedulerLogger.child({ agentId, component: "task-extractor" }),
      config: {
        enabled: tasksConfig.enabled,
        confidenceThreshold: tasksConfig.confidenceThreshold,
      },
      eventBus: container.eventBus,
    });

    taskExtractors.set(agentId, extractor);
    schedulerLogger.debug({ agentId }, "Task extractor created");
  }

  if (taskExtractors.size > 0) {
    schedulerLogger.info(
      { extractorCount: taskExtractors.size },
      "Task extraction enabled for agents",
    );
  }

  async function extractFromConversation(
    conversationText: string,
    sessionKey: string,
    agentId: string,
  ): Promise<void> {
    const extractor = taskExtractors.get(agentId);
    if (!extractor) return;

    try {
      const tasks = await extractor.extract(conversationText, sessionKey);
      if (tasks.length > 0) {
        schedulerLogger.info(
          { agentId, taskCount: tasks.length, sessionKey },
          "Tasks extracted from conversation",
        );
      }
    } catch (err: unknown) {
      schedulerLogger.warn(
        {
          agentId,
          err: err instanceof Error ? err.message : String(err),
          hint: "Task extraction failed but does not block message processing",
          errorKind: "internal" as const,
        },
        "Task extraction error",
      );
    }
  }

  return { taskExtractors, extractFromConversation };
}
