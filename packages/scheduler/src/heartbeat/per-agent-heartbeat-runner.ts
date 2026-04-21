// SPDX-License-Identifier: Apache-2.0
/**
 * PerAgentHeartbeatRunner: Manages independent heartbeat timers per agent.
 *
 * Each agent has its own interval and state, tracked in a Map. A single
 * setTimeout targets the soonest-due agent to avoid timer proliferation.
 *
 */

import type { TypedEventBus } from "@comis/core";
import type { SchedulerLogger } from "../shared-types.js";
import type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";
import {
  computeBackoffMs,
  classifyError,
  shouldFireAlert,
  isRecovery,
} from "./resilience-tracker.js";
import type { ErrorClassification } from "./resilience-tracker.js";

/** Per-agent heartbeat state tracked in the runner's agent map. */
export interface HeartbeatAgentState {
  agentId: string;
  config: EffectiveHeartbeatConfig;
  lastRunMs: number;
  nextDueMs: number;
  // Resilience state
  consecutiveErrors: number;
  backoffUntilMs: number;
  tickStartedAtMs: number;
  lastAlertMs: number;
  lastErrorKind: ErrorClassification | null;
}

/** Dependencies for creating a PerAgentHeartbeatRunner. */
export interface PerAgentHeartbeatRunnerDeps {
  /** Initial set of agents with their resolved configs. */
  agents: Map<string, HeartbeatAgentState>;
  /** Event bus for emitting scheduler events. */
  eventBus: TypedEventBus;
  /** Logger instance. */
  logger: SchedulerLogger;
  /** Callback invoked when an agent's heartbeat tick fires. Receives agentId. */
  onTick: (agentId: string) => void | Promise<void>;
  /** Injectable clock for testing (defaults to Date.now). */
  nowMs?: () => number;
}

/** PerAgentHeartbeatRunner public interface. */
export interface PerAgentHeartbeatRunner {
  /** Start the soonest-due scheduling timer. */
  start(): void;
  /** Stop the timer and clear all pending timeouts. */
  stop(): void;
  /** Manually trigger a heartbeat tick for a specific agent (used by wake coalescer). */
  runAgentOnce(agentId: string): Promise<void>;
  /** Add an agent at runtime. Reschedules the timer. */
  addAgent(state: HeartbeatAgentState): void;
  /** Remove an agent at runtime. Reschedules the timer. Returns true if agent existed. */
  removeAgent(agentId: string): boolean;
  /** Get a snapshot of all agent states (for observability). */
  getAgentStates(): ReadonlyMap<string, HeartbeatAgentState>;
}

export function createPerAgentHeartbeatRunner(
  deps: PerAgentHeartbeatRunnerDeps,
): PerAgentHeartbeatRunner {
  const { eventBus, logger, onTick } = deps;
  const getNow = deps.nowMs ?? Date.now;

  // Copy initial agents into our mutable map
  const agents = new Map<string, HeartbeatAgentState>();
  for (const [id, state] of deps.agents) {
    agents.set(id, { ...state });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext(): void {
    clearTimer();

    if (agents.size === 0) return;

    // Find the soonest-due agent, respecting backoff
    let soonestDueMs = Infinity;
    for (const state of agents.values()) {
      const effectiveDue = Math.max(state.nextDueMs, state.backoffUntilMs);
      if (effectiveDue < soonestDueMs) {
        soonestDueMs = effectiveDue;
      }
    }

    const now = getNow();
    const delayMs = Math.max(0, soonestDueMs - now);

    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref();
  }

  /**
   * Handle a single agent's tick with resilience: stuck detection,
   * backoff, alerting, and recovery logging.
   */
  async function executeAgentTick(state: HeartbeatAgentState): Promise<void> {
    const staleMs = state.config.staleMs ?? 120_000;
    state.tickStartedAtMs = getNow();

    try {
      // Wrap onTick in stuck detection via Promise.race
      await Promise.race([
        onTick(state.agentId),
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () =>
              reject(
                new Error(
                  `Heartbeat tick stuck for "${state.agentId}" after ${staleMs}ms`,
                ),
              ),
            staleMs,
          );
          t.unref();
        }),
      ]);

      // Success path: check recovery BEFORE resetting (Pitfall: must read consecutiveErrors before zeroing)
      if (isRecovery(state.consecutiveErrors)) {
        logger.info(
          {
            agentId: state.agentId,
            previousErrors: state.consecutiveErrors,
          },
          "Heartbeat recovered after backoff",
        );
      }
      state.consecutiveErrors = 0;
      state.backoffUntilMs = 0;
      state.lastErrorKind = null;
      state.tickStartedAtMs = 0;
    } catch (err: unknown) {
      // Failure path
      state.consecutiveErrors++;
      const classification = classifyError(err);
      state.lastErrorKind = classification;
      state.tickStartedAtMs = 0;

      const backoffMs = computeBackoffMs(state.consecutiveErrors);
      const tickNow = getNow();
      state.backoffUntilMs = tickNow + backoffMs;

      // Structured logging for error classification
      const errMsg = err instanceof Error ? err.message : String(err);
      if (classification === "permanent") {
        logger.error(
          {
            agentId: state.agentId,
            consecutiveErrors: state.consecutiveErrors,
            classification,
            backoffMs,
            err: errMsg,
            hint: "Permanent failure -- check agent config, credentials, or model access",
            errorKind: "config" as const,
          },
          "Heartbeat permanent failure",
        );
      } else {
        logger.warn(
          {
            agentId: state.agentId,
            consecutiveErrors: state.consecutiveErrors,
            classification,
            backoffMs,
            err: errMsg,
            hint: "Transient failure -- will retry with exponential backoff",
            errorKind: "network" as const,
          },
          "Heartbeat backoff triggered",
        );
      }

      // Alerting decision
      const alertDecision = shouldFireAlert({
        consecutiveErrors: state.consecutiveErrors,
        alertThreshold: state.config.alertThreshold ?? 2,
        lastAlertMs: state.lastAlertMs,
        cooldownMs: state.config.alertCooldownMs ?? 300_000,
        nowMs: tickNow,
        classification,
      });
      if (alertDecision.shouldAlert) {
        state.lastAlertMs = tickNow;
        eventBus.emit("scheduler:heartbeat_alert", {
          agentId: state.agentId,
          consecutiveErrors: state.consecutiveErrors,
          classification,
          reason: alertDecision.reason,
          backoffMs,
          timestamp: tickNow,
        });
      }
    }
  }

  async function tick(): Promise<void> {
    const now = getNow();

    // Find ALL agents due at or before now AND not in backoff
    const dueAgents: HeartbeatAgentState[] = [];
    for (const state of agents.values()) {
      if (state.nextDueMs <= now && state.backoffUntilMs <= now) {
        dueAgents.push(state);
      }
    }

    // Process due agents sequentially to prevent resource contention
    for (const state of dueAgents) {
      await executeAgentTick(state);

      // Update state regardless of success/failure to prevent tight retry loops
      const tickNow = getNow();
      state.lastRunMs = tickNow;
      state.nextDueMs = tickNow + state.config.intervalMs;
    }

    if (dueAgents.length > 0) {
      logger.debug(
        { agentsProcessed: dueAgents.length },
        "Per-agent heartbeat tick complete",
      );
    }

    // Reschedule for the next soonest-due agent
    if (running) {
      scheduleNext();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;

      const now = getNow();
      // Initialize nextDueMs for agents that haven't run yet (lastRunMs === 0)
      for (const state of agents.values()) {
        if (state.lastRunMs === 0) {
          state.nextDueMs = now + state.config.intervalMs;
        }
      }

      scheduleNext();
      logger.info({ agentCount: agents.size }, "PerAgentHeartbeatRunner started");
    },

    stop(): void {
      if (!running) return;
      running = false;
      clearTimer();
      logger.info("PerAgentHeartbeatRunner stopped");
    },

    async runAgentOnce(agentId: string): Promise<void> {
      const state = agents.get(agentId);
      if (!state) {
        logger.warn(
          {
            agentId,
            hint: "Attempted to run heartbeat for an agent not in the runner map",
            errorKind: "validation" as const,
          },
          "runAgentOnce called for unknown agent",
        );
        return;
      }

      // Wake-triggered ticks use the same resilience pattern as scheduled ticks
      await executeAgentTick(state);

      // Update timestamps
      const now = getNow();
      state.lastRunMs = now;
      state.nextDueMs = now + state.config.intervalMs;

      if (running) {
        scheduleNext();
      }
    },

    addAgent(state: HeartbeatAgentState): void {
      const now = getNow();
      const newState = { ...state };
      if (newState.lastRunMs === 0) {
        newState.nextDueMs = now + newState.config.intervalMs;
      }
      agents.set(newState.agentId, newState);

      if (running) {
        scheduleNext();
      }
    },

    removeAgent(agentId: string): boolean {
      const existed = agents.delete(agentId);

      if (running) {
        if (agents.size === 0) {
          clearTimer();
        } else {
          scheduleNext();
        }
      }

      return existed;
    },

    getAgentStates(): ReadonlyMap<string, HeartbeatAgentState> {
      // Return a snapshot copy
      const snapshot = new Map<string, HeartbeatAgentState>();
      for (const [id, state] of agents) {
        snapshot.set(id, { ...state });
      }
      return snapshot;
    },
  };
}
