// SPDX-License-Identifier: Apache-2.0
/**
 * Parametric factory for admin manage tools.
 *
 * Consolidates the duplicated trust-guard + action-validation + RPC-dispatch
 * boilerplate shared by 8 admin manage tools into a single descriptor-driven
 * factory. Simple tools become ~30 LOC descriptors; complex tools keep
 * per-action business logic via actionOverrides.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";
import type { ApprovalGate } from "@comis/core";
import { tryGetContext } from "@comis/core";
import {
  jsonResult,
  readEnumParam,
  throwToolError,
  createTrustGuard,
} from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Descriptor interface
// ---------------------------------------------------------------------------

/**
 * Descriptor for parametric admin manage tool creation.
 *
 * Describes the metadata, valid actions, RPC routing, and optional
 * per-action overrides for an admin management tool.
 */
export interface AdminManageDescriptor<T extends TSchema = TSchema> {
  /** Tool name (e.g. "heartbeat_manage") */
  name: string;
  /** Human-readable label */
  label: string;
  /** Tool description for the LLM */
  description: string;
  /** TypeBox parameter schema */
  parameters: T;
  /** Valid action names for this tool */
  validActions: readonly string[];
  /** RPC prefix -- action "create" with prefix "agents" calls rpcCall("agents.create", ...) */
  rpcPrefix: string;
  /** Actions that require approval gate confirmation */
  gatedActions?: readonly string[];
  /** Whether trust guard is required (default: true) */
  requiresTrust?: boolean;
  /** Minimum trust level (default: "admin") */
  minimumTrust?: string;
  /**
   * Per-action overrides when simple rpcCall(prefix.action) is insufficient.
   * Return value replaces the rpcCall result. Return undefined to fall through
   * to default dispatch.
   */
  actionOverrides?: Record<
    string,
    (
      params: Record<string, unknown>,
      rpcCall: RpcCall,
      context: { agentId?: string; trustLevel: string },
    ) => Promise<unknown>
  >;
}

// ---------------------------------------------------------------------------
// AgentToolResult pass-through guard
// ---------------------------------------------------------------------------

/**
 * Detect when an actionOverride has already produced a fully-formed
 * `AgentToolResult` (multi-block content + typed `details`), so the factory
 * passes it through verbatim instead of re-wrapping via `jsonResult`.
 *
 * Used by `agents_manage.create` (260428-sw2 Layer 1) to emit a 2-text-block
 * tool_result: a high-attention next-step contract first, the JSON-rendered
 * RPC fields second. The 7 sibling admin manage tools (cron/heartbeat/
 * sessions/tokens/etc.) keep returning plain objects from their overrides --
 * they hit the `jsonResult` branch unchanged. Additive, zero-impact change.
 */
function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content) &&
    "details" in (value as object)
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an admin manage tool from a descriptor.
 *
 * Handles the common boilerplate:
 * 1. Trust guard enforcement (configurable level)
 * 2. Action validation via readEnumParam
 * 3. Approval gate for gated actions
 * 4. Per-action overrides for complex business logic
 * 5. Default RPC dispatch: rpcCall(`${prefix}.${action}`, params)
 * 6. Consistent error handling
 *
 * @param descriptor - Tool configuration descriptor
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param approvalGate - Optional approval gate for gated actions
 * @param callbacks - Optional mutation lifecycle callbacks (onMutationStart/onMutationEnd)
 * @returns AgentTool implementing the described management interface
 */
export function createAdminManageTool<T extends TSchema>(
  descriptor: AdminManageDescriptor<T>,
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
  callbacks?: {
    onMutationStart?: () => void;
    onMutationEnd?: () => void;
  },
): AgentTool<T> {
  const trustGuard =
    descriptor.requiresTrust !== false
      ? createTrustGuard(descriptor.name, (descriptor.minimumTrust ?? "admin") as "admin" | "user" | "guest")
      : undefined;

  return {
    name: descriptor.name,
    label: descriptor.label,
    description: descriptor.description,
    parameters: descriptor.parameters,

    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // 1. Trust guard
        trustGuard?.();

        const ctx = tryGetContext();
        const _trustLevel = ctx?.trustLevel ?? "guest";

        const p = params as Record<string, unknown>;
        // 2. Action validation
        const action = readEnumParam(p, "action", descriptor.validActions as unknown as readonly string[]);

        // 3. Approval gate for gated actions
        if (
          descriptor.gatedActions?.includes(action) &&
          approvalGate
        ) {
          const gateCtx = tryGetContext();
          const resolution = await approvalGate.requestApproval({
            toolName: descriptor.name,
            action: `${descriptor.rpcPrefix}.${action}`,
            params: p,
            agentId: gateCtx?.userId ?? "unknown",
            sessionKey: gateCtx?.sessionKey ?? "unknown",
            trustLevel: (gateCtx?.trustLevel ?? "guest") as "admin" | "user" | "guest",
            channelType: gateCtx?.channelType,
          });
          if (!resolution.approved) {
            throwToolError(
              "permission_denied",
              `Action denied: ${descriptor.rpcPrefix}.${action} was not approved`,
              { hint: resolution.reason ?? "Request approval before retrying." },
            );
          }
        }

        // 4. Per-action overrides
        if (descriptor.actionOverrides?.[action]) {
          const result = await descriptor.actionOverrides[action](
            p,
            rpcCall,
            { agentId: ctx?.userId, trustLevel: _trustLevel },
          );
          if (result !== undefined) {
            // Pass through pre-built AgentToolResult shapes (e.g. the
            // multi-text-block contract emitted by agents_manage.create);
            // wrap plain values via jsonResult as before.
            return isAgentToolResult(result) ? result : jsonResult(result);
          }
          // Fall through to default dispatch if override returns undefined
        }

        // 5. Default RPC dispatch
        const rpcMethod = `${descriptor.rpcPrefix}.${action}`;
        callbacks?.onMutationStart?.();
        try {
          const result = await rpcCall(rpcMethod, { ...p, _trustLevel });
          return jsonResult(result);
        } finally {
          callbacks?.onMutationEnd?.();
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
