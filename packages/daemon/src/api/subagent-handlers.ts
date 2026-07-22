// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Subagent RPC handler module.
 *
 * Handles sub-agent lifecycle management RPC methods:
 *   subagent.list, subagent.kill, subagent.steer
 *
 * List returns filtered runs from SubAgentRunner. Kill marks a running
 * run as failed. Steer is flag-gated on security.agentToAgent.steerInject:
 * OFF (default) → kill+respawn with a new task (status "steered");
 * ON → inject the message into the running child's live session at its next
 * step boundary (no kill/respawn, same runId, status "steered_inject").
 * Rate-limited at 2s per target (shared across both branches).
 *
 * Per-method pipeline: resolve controller authority from trusted internal
 * fields, strip those fields, validate the public request, authorize the
 * selected run, then execute and validate the development response.
 *
 * @module
 */

import {
  ConversationScopeSchema,
  SubagentListContract,
  SubagentKillContract,
  SubagentPauseContract,
  SubagentResumeContract,
  SubagentStatusContract,
  SubagentSteerContract,
  SubagentWaitContract,
  createConversationRef,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
  wrapExternalContent,
} from "@comis/core";
import type { ConversationLocator } from "@comis/core";

import { AuthorizationError } from "./errors.js";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: OrchestratorApiDeps (shared with cron, graph,
// heartbeat handlers).
import type { OrchestratorApiDeps as SubagentHandlerDeps } from "./types.js";
export type { SubagentHandlerDeps };

export type SubagentController =
  | {
      kind: "caller";
      agentId: string;
      conversationRef: ConversationLocator["conversationRef"];
      conversation: ConversationLocator;
      rootRunId?: string;
    }
  | { kind: "admin"; agentId?: string };

const AGENT_ORIGIN_FIELDS = [
  "_agentId",
  "_autonomyMode",
  "_callerConversationScope",
  "_callerSessionKey",
  "_capabilities",
  "_leaseId",
  "_parentLeaseId",
  "_rootRunId",
] as const;

/** Resolve the only two authorities allowed to operate on sub-agent runs. */
export function resolveSubagentController(
  rawParams: Record<string, unknown>,
): SubagentController {
  const hasAgentOrigin = AGENT_ORIGIN_FIELDS.some((field) => rawParams[field] !== undefined);
  if (hasAgentOrigin) {
    const agentId = rawParams._agentId;
    const parsedScope = ConversationScopeSchema.safeParse(rawParams._callerConversationScope);
    if (typeof agentId !== "string" || agentId.length === 0 || !parsedScope.success) {
      throw new AuthorizationError("Sub-agent controller authority is invalid");
    }
    if (parsedScope.data.agentId !== agentId) {
      throw new AuthorizationError("Sub-agent controller authority is invalid");
    }
    const conversationRef = createConversationRef(parsedScope.data);
    if (!conversationRef.ok) {
      throw new AuthorizationError("Sub-agent controller authority is invalid");
    }
    const rootRunId = rawParams._rootRunId;
    if (rootRunId !== undefined && (typeof rootRunId !== "string" || rootRunId.length === 0)) {
      throw new AuthorizationError("Sub-agent controller authority is invalid");
    }
    return {
      kind: "caller",
      agentId,
      conversationRef: conversationRef.value,
      conversation: {
        conversationScope: parsedScope.data,
        conversationRef: conversationRef.value,
      },
      ...(typeof rootRunId === "string" ? { rootRunId } : {}),
    };
  }

  if (rawParams._trustLevel !== "admin") {
    throw new AuthorizationError("Sub-agent controller authority is invalid");
  }
  const selectedAgentId = rawParams.agentId;
  return {
    kind: "admin",
    ...(typeof selectedAgentId === "string" ? { agentId: selectedAgentId } : {}),
  };
}

type RunnerRun = NonNullable<
  ReturnType<SubagentHandlerDeps["subAgentRunner"]["getRunStatus"]>
>;

export function subagentControllerOwnsRun(controller: SubagentController, run: RunnerRun): boolean {
  return controller.kind === "admin" || (
    run.callerAgentId === controller.agentId
    && run.callerConversation?.conversationRef === controller.conversationRef
  );
}

function assertTargetAuthorized(
  controller: SubagentController,
  run: RunnerRun | undefined,
): void {
  if (controller.kind === "caller" && (run === undefined || !subagentControllerOwnsRun(controller, run))) {
    throw new AuthorizationError("Sub-agent target is unavailable");
  }
}

function projectCallerRun(run: RunnerRun): Record<string, unknown> {
  const terminalProjection = run.status === "completed" || run.status === "failed"
    ? {
        completion: {
          endReason: run.completion.endReason,
          completedAtMs: run.completion.completedAtMs,
          ...(run.completion.endReason !== "completed"
            ? { errorKind: run.completion.errorKind }
            : {}),
        },
      }
    : {};
  return {
    runId: run.runId,
    status: run.status,
    agentId: run.agentId,
    startedAt: run.startedAt,
    ...(run.queuedAt !== undefined ? { queuedAt: run.queuedAt } : {}),
    ...terminalProjection,
    ...(run.depth !== undefined ? { depth: run.depth } : {}),
    ...(run.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
    ...(run.graphId !== undefined ? { graphId: run.graphId } : {}),
    ...(run.nodeId !== undefined ? { nodeId: run.nodeId } : {}),
  };
}

function controllerRateKey(controller: SubagentController, target: string): string {
  const controllerKey = controller.kind === "caller"
    ? `caller:${controller.agentId}:${controller.conversationRef}`
    : `admin:${controller.agentId ?? "all"}`;
  return `${controllerKey}:target:${target}`;
}

function requireOperatorController(rawParams: Record<string, unknown>): void {
  const controller = resolveSubagentController(rawParams);
  if (controller.kind !== "admin") {
    throw new AuthorizationError("Sub-agent spawn admission control requires operator authority");
  }
}

// ---------------------------------------------------------------------------
// Rate-limit state for steer
// ---------------------------------------------------------------------------

const steerTimestamps = new Map<string, number>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of subagent RPC handlers bound to the given deps.
 */
export function createSubagentHandlers(deps: SubagentHandlerDeps): Record<string, RpcHandler> {
  return {
    [SubagentListContract.method]: async (rawParams) => {
      const controller = resolveSubagentController(rawParams);
      const userParams = stripInternalFields(rawParams);
      const params = SubagentListContract.request.parse(userParams);

      if (controller.kind === "caller" && (params.agentId !== undefined || params.rootRunId !== undefined)) {
        throw new AuthorizationError("Sub-agent controller cannot select global scope");
      }

      const recentMinutes = params.recentMinutes ?? 30;
      const allRuns = deps.subAgentRunner.listRuns(recentMinutes);
      const selectedRuns = controller.kind === "caller"
        ? allRuns.filter((run) => subagentControllerOwnsRun(controller, run))
        : allRuns.filter((run) => (
            (params.agentId === undefined || run.agentId === params.agentId)
            && (params.rootRunId === undefined || run.rootRunId === params.rootRunId)
          ));
      const runs = controller.kind === "caller"
        ? selectedRuns.map(projectCallerRun)
        : selectedRuns;
      const result = { runs, total: runs.length };
      if (IS_DEV) SubagentListContract.response.parse(result);
      return result;
    },

    [SubagentWaitContract.method]: async (rawParams) => {
      const startedAtMs = systemNowMs();
      const controller = resolveSubagentController(rawParams);
      const rawSignal = rawParams._abortSignal;
      const signal = rawSignal !== undefined
        && typeof rawSignal === "object"
        && rawSignal !== null
        && "aborted" in rawSignal
        && "addEventListener" in rawSignal
        && "removeEventListener" in rawSignal
        ? rawSignal as AbortSignal
        : undefined;
      if (rawSignal !== undefined && signal === undefined) {
        throw new AuthorizationError("Sub-agent wait cancellation authority is invalid");
      }
      const params = SubagentWaitContract.request.parse(stripInternalFields(rawParams));
      const timeoutMs = params.timeoutMs
        ?? Math.min(deps.securityConfig.agentToAgent?.waitTimeoutMs ?? 60_000, 300_000);

      const requestedRunIds = params.runIds !== undefined
        ? [...new Set(params.runIds)]
        : deps.subAgentRunner.listRuns()
        .filter((run) => (
          (run.status === "running" || run.status === "queued")
          && (controller.kind === "admin" || subagentControllerOwnsRun(controller, run))
        ))
        .map((run) => run.runId)
        .slice(0, 32);

      const authorizedRunIds: string[] = [];
      const deniedRunIds = new Set<string>();
      for (const runId of requestedRunIds) {
        const run = deps.subAgentRunner.getRunStatus(runId);
        if (
          run === undefined
          || (controller.kind === "caller" && !subagentControllerOwnsRun(controller, run))
        ) {
          deniedRunIds.add(runId);
        } else {
          authorizedRunIds.push(runId);
        }
      }

      const waited = authorizedRunIds.length > 0
        ? await deps.subAgentRunner.waitForCompletions(authorizedRunIds, timeoutMs, signal)
        : [];
      const waitedByRunId = new Map(waited.map((entry) => [entry.runId, entry]));
      const results = requestedRunIds.map((runId) => (
        deniedRunIds.has(runId)
          ? { runId, status: "denied_unknown" as const }
          : waitedByRunId.get(runId) ?? { runId, status: "denied_unknown" as const }
      ));
      const result = { results };
      deps.logger?.info(
        {
          controllerKind: controller.kind,
          requestedCount: requestedRunIds.length,
          completedCount: results.filter((entry) => entry.status === "completed").length,
          timeoutCount: results.filter((entry) => entry.status === "timeout").length,
          deniedUnknownCount: results.filter((entry) => entry.status === "denied_unknown").length,
          cancelledCount: results.filter((entry) => entry.status === "cancelled").length,
          durationMs: systemNowMs() - startedAtMs,
        },
        "Sub-agent completion wait finished",
      );
      if (IS_DEV) SubagentWaitContract.response.parse(result);
      return result;
    },

    [SubagentKillContract.method]: async (rawParams) => {
      const controller = resolveSubagentController(rawParams);
      // Preserve the concise missing-parameter response at the RPC boundary.
      const target = rawParams.target as string | undefined;
      if (!target) throw new Error("Missing required parameter: target");

      const userParams = stripInternalFields(rawParams);
      SubagentKillContract.request.parse(userParams);

      assertTargetAuthorized(controller, deps.subAgentRunner.getRunStatus(target));

      const killResult = deps.subAgentRunner.killRun(target);
      if (!killResult.killed) {
        throw new Error(killResult.error!);
      }
      const result = { killed: true, runId: target };
      if (IS_DEV) SubagentKillContract.response.parse(result);
      return result;
    },

    [SubagentSteerContract.method]: async (rawParams) => {
      const controller = resolveSubagentController(rawParams);
      // Preserve concise missing-parameter responses at the RPC boundary.
      const target = rawParams.target as string | undefined;
      const message = rawParams.message as string | undefined;
      if (!target) throw new Error("Missing required parameter: target");
      if (!message) throw new Error("Missing required parameter: message");

      const userParams = stripInternalFields(rawParams);
      SubagentSteerContract.request.parse(userParams);

      const run = deps.subAgentRunner.getRunStatus(target);
      assertTargetAuthorized(controller, run);

      // Rate limit: 2s between steers by the same controller to the same target.
      const rateKey = controllerRateKey(controller, target);
      const lastSteer = steerTimestamps.get(rateKey);
      if (lastSteer && systemNowMs() - lastSteer < 2000) {
        throw new Error("Rate limited: wait 2s between steers to same target");
      }
      steerTimestamps.set(rateKey, systemNowMs());

      // Prune stale entries older than 1 hour to prevent unbounded growth
      const ONE_HOUR = 60 * 60 * 1000;
      const now = systemNowMs();
      for (const [key, ts] of steerTimestamps) {
        if (now - ts > ONE_HOUR) {
          steerTimestamps.delete(key);
        }
      }

      // Flag-gated branch. Flag ON → inject into the live child (no
      // kill, no respawn — transcript + progress preserved, same runId). Flag
      // OFF (default) → kill+respawn. The 2s
      // rate-limit above is shared by both branches.
      const framedMessage = wrapExternalContent(message, { source: "api" });
      if (deps.securityConfig.agentToAgent?.steerInject) {
        if (!run) {
          throw new Error(`Unknown run ID: ${target}`);
        }
        // Mirror killRun's status guard (sub-agent-runner.ts:1910-1912).
        // getRunStatus returns a run for ANY status still inside the retention
        // window; a steer aimed at a completed/failed/queued run has no live
        // handle, so fail fast with an actionable status-named error instead of
        // proceeding to the generic "No live session" throw from steerRun.
        if (run.status !== "running") {
          throw new Error(
            `Run ${target} is not running (status: ${run.status}) — cannot steer; use kill+respawn instead.`,
          );
        }
        const steerResult = await deps.subAgentRunner.steerRun(target, framedMessage);
        if (!steerResult.steered) {
          // The inject-failure branch is a path an operator must
          // diagnose. Log a WARN with an actionable hint + errorKind before the
          // throw (which the @allow-throw dispatcher converts to a JSON-RPC
          // error) — never the steer message body. The success branch already
          // logs INFO + emits subagent:steered; this gives the failure branch
          // the matching observability so `comis explain` / daemon.log can
          // distinguish a no-live-handle miss from a finished run.
          deps.logger?.warn(
            {
              runId: target,
              agentId: run.agentId,
              hint: "Steer could not reach a live child session; the run may have finished or its SDK handle was not registered under the resolved key — verify with subagent.list, or use kill+respawn",
              errorKind: "precondition" as const,
            },
            "Sub-agent steer inject failed (no live session)",
          );
          throw new Error(steerResult.error!);
        }
        // Counts/ids/mode only — NEVER the steer message body (AGENTS.md §2.7).
        deps.eventBus?.emit("subagent:steered", {
          runId: target,
          agentId: run.agentId,
          mode: steerResult.mode!,
          timestamp: systemNowMs(),
        });
        deps.logger?.info(
          { runId: target, agentId: run.agentId, mode: steerResult.mode },
          "Sub-agent steered (inject) at next step boundary",
        );
        const injectResult = { status: "steered_inject" as const, runId: target };
        if (IS_DEV) SubagentSteerContract.response.parse(injectResult);
        return injectResult;
      }

      // Kill the current run
      const killResult = deps.subAgentRunner.killRun(target);
      if (!killResult.killed) {
        throw new Error(killResult.error!);
      }

      // The pre-kill snapshot supplies the respawn details.
      if (!run) {
        throw new Error(`Run details not found after kill: ${target}`);
      }

      // Respawn with new task — reads internal fields directly off rawParams.
      // The respawn must stay in the KILLED run's spawn tree, so
      // inherit its rootRunId (+ the authorizing parentLeaseId). Without this the
      // steer-respawn would mint a fresh root → a later run.kill {rootRunId} of the
      // original tree would miss the steered continuation (a surviving orphan).
      const newRunId = deps.subAgentRunner.spawn({
        task: framedMessage,
        agentId: run.agentId,
        callerType: controller.kind === "caller" ? "agent" : "control-plane",
        ...(controller.kind === "caller"
          ? {
              ...(typeof rawParams._callerSessionKey === "string"
                ? { callerSessionKey: rawParams._callerSessionKey }
                : {}),
              callerAgentId: controller.agentId,
              callerConversation: controller.conversation,
            }
          : {}),
        ...(run.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
        ...(run.leaseId !== undefined
          ? { parentLeaseId: run.leaseId }
          : run.parentLeaseId !== undefined
            ? { parentLeaseId: run.parentLeaseId }
            : {}),
        caps: run.caps,
      });

      deps.logger?.info(
        { oldRunId: target, newRunId, agentId: run.agentId },
        "Sub-agent steered to new task",
      );

      const result = { status: "steered" as const, oldRunId: target, newRunId };
      if (IS_DEV) SubagentSteerContract.response.parse(result);
      return result;
    },

    [SubagentPauseContract.method]: async (rawParams) => {
      const startedAtMs = systemNowMs();
      requireOperatorController(rawParams);
      SubagentPauseContract.request.parse(stripInternalFields(rawParams));
      const result = deps.subAgentRunner.pauseSpawns();
      deps.logger?.info(
        {
          paused: result.paused,
          acceptingSpawns: result.acceptingSpawns,
          changed: result.changed,
          resetsOnRestart: result.resetsOnRestart,
          durationMs: systemNowMs() - startedAtMs,
        },
        "Sub-agent spawn admission paused",
      );
      if (IS_DEV) SubagentPauseContract.response.parse(result);
      return result;
    },

    [SubagentResumeContract.method]: async (rawParams) => {
      const startedAtMs = systemNowMs();
      requireOperatorController(rawParams);
      SubagentResumeContract.request.parse(stripInternalFields(rawParams));
      const result = deps.subAgentRunner.resumeSpawns();
      deps.logger?.info(
        {
          paused: result.paused,
          acceptingSpawns: result.acceptingSpawns,
          changed: result.changed,
          resetsOnRestart: result.resetsOnRestart,
          durationMs: systemNowMs() - startedAtMs,
        },
        "Sub-agent spawn admission resumed",
      );
      if (IS_DEV) SubagentResumeContract.response.parse(result);
      return result;
    },

    [SubagentStatusContract.method]: async (rawParams) => {
      const startedAtMs = systemNowMs();
      requireOperatorController(rawParams);
      SubagentStatusContract.request.parse(stripInternalFields(rawParams));
      const result = deps.subAgentRunner.spawnAdmissionStatus();
      deps.logger?.info(
        {
          paused: result.paused,
          acceptingSpawns: result.acceptingSpawns,
          resetsOnRestart: result.resetsOnRestart,
          durationMs: systemNowMs() - startedAtMs,
        },
        "Sub-agent spawn admission inspected",
      );
      if (IS_DEV) SubagentStatusContract.response.parse(result);
      return result;
    },
  };
}
