// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Controller authority errors are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
import {
  ConversationScopeSchema,
  createConversationRef,
  type ConversationLocator,
} from "@comis/core";
import { AuthorizationError } from "./errors.js";
import type { OrchestratorApiDeps } from "./types.js";

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

type RunnerRun = NonNullable<
  ReturnType<OrchestratorApiDeps["subAgentRunner"]["getRunStatus"]>
>;

/** Resolve caller or operator authority without allowing partial caller fields to fall back to admin. */
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

export function subagentControllerOwnsRun(
  controller: SubagentController,
  run: RunnerRun,
): boolean {
  return controller.kind === "admin" || (
    run.callerAgentId === controller.agentId
    && run.callerConversation?.conversationRef === controller.conversationRef
  );
}

export function assertSubagentTargetAuthorized(
  controller: SubagentController,
  run: RunnerRun | undefined,
): void {
  if (controller.kind === "caller" && (run === undefined || !subagentControllerOwnsRun(controller, run))) {
    throw new AuthorizationError("Sub-agent target is unavailable");
  }
}

export function projectCallerSubagentRun(run: RunnerRun): Record<string, unknown> {
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

export function subagentControllerRateKey(
  controller: SubagentController,
  target: string,
): string {
  const controllerKey = controller.kind === "caller"
    ? `caller:${controller.agentId}:${controller.conversationRef}`
    : `admin:${controller.agentId ?? "all"}`;
  return `${controllerKey}:target:${target}`;
}

export function requireSubagentOperatorController(rawParams: Record<string, unknown>): void {
  const controller = resolveSubagentController(rawParams);
  if (controller.kind !== "admin") {
    throw new AuthorizationError("Sub-agent spawn admission control requires operator authority");
  }
}
