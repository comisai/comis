// SPDX-License-Identifier: Apache-2.0
/**
 * Shared factory helpers for messaging tools.
 *
 * Consolidates common boilerplate (schema + rpcCall + jsonResult + error
 * handling) into two parametric factories:
 *
 * - `createRpcDispatchTool` -- for simple single-RPC-method tools
 * - `createMultiActionDispatchTool` -- for multi-action tools with action routing
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { jsonResult, readEnumParam } from "./tool-helpers.js";
import type { RpcCall } from "./tools/cron-tool.js";

// ---------------------------------------------------------------------------
// Single RPC dispatch tool
// ---------------------------------------------------------------------------

/**
 * Configuration for a simple single-RPC-method tool.
 */
export interface RpcDispatchToolConfig<T extends TSchema> {
  /** Tool name */
  name: string;
  /** Human-readable label */
  label: string;
  /** Tool description for the LLM */
  description: string;
  /** TypeBox parameter schema */
  parameters: T;
  /** RPC method to call */
  rpcMethod: string;
  /** Transform params before RPC call (optional) */
  transformParams?: (params: Record<string, unknown>) => Record<string, unknown>;
  /** Pre-execute hook for action gates or validation (optional).
   *  Return an AgentToolResult to short-circuit, or undefined to continue. */
  preExecute?: (params: Record<string, unknown>) => AgentToolResult<unknown> | undefined;
  /** Thread the framework tool-call id as the logical outward operation identity. */
  useToolCallIdAsOperationId?: boolean;
}

/**
 * Convert an explicit RPC operation failure into the error text the AgentTool
 * boundary throws. An incidental `error` field is not enough: only the closed
 * `success:false` outcome marks the operation failed.
 */
function explicitRpcFailureMessage(result: unknown): string | undefined {
  if (
    result === null
    || typeof result !== "object"
    || Array.isArray(result)
    || (result as { success?: unknown }).success !== false
  ) return undefined;
  const failure = result as { error?: unknown; hint?: unknown };
  const error =
    typeof failure.error === "string" && failure.error.trim().length > 0
      ? failure.error.trim()
      : "RPC operation failed";
  const hint =
    typeof failure.hint === "string" && failure.hint.trim().length > 0
      ? failure.hint.trim()
      : undefined;
  if (hint === undefined) return error;
  const separator = /[.!?]$/.test(error) ? " " : ". ";
  return `${error}${separator}Hint: ${hint}`;
}

/**
 * Create a tool that dispatches to a single RPC method.
 *
 * Handles the common pattern: schema + optional pre-execute + optional
 * param transform + rpcCall + jsonResult + error handling.
 *
 * @param config - Tool configuration
 * @param rpcCall - RPC call function
 * @returns AgentTool that dispatches to the configured RPC method
 */
export function createRpcDispatchTool<T extends TSchema>(
  config: RpcDispatchToolConfig<T>,
  rpcCall: RpcCall,
): AgentTool<T> {
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,

    async execute(
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as Record<string, unknown>;

        // Pre-execute hook (action gates, validation)
        if (config.preExecute) {
          const shortCircuit = config.preExecute(p);
          if (shortCircuit) return shortCircuit;
        }

        // Transform params if needed, otherwise pass through
        const rpcParams = config.transformParams ? config.transformParams(p) : p;
        const result = config.useToolCallIdAsOperationId
          ? await rpcCall(config.rpcMethod, rpcParams, { outwardOperationId: toolCallId })
          : await rpcCall(config.rpcMethod, rpcParams);
        const failureMessage = explicitRpcFailureMessage(result);
        if (failureMessage !== undefined) throw new Error(failureMessage);
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Multi-action dispatch tool
// ---------------------------------------------------------------------------

/**
 * Configuration for a multi-action tool that routes to different handlers.
 */
export interface MultiActionDispatchConfig<T extends TSchema> {
  /** Tool name */
  name: string;
  /** Human-readable label */
  label: string;
  /** Tool description for the LLM */
  description: string;
  /** TypeBox parameter schema */
  parameters: T;
  /** Valid action values for readEnumParam validation */
  validActions: readonly string[];
  /** Per-action handler. Called with validated action, raw params, and rpcCall.
   *  Must return the result to be wrapped in jsonResult. */
  actionHandler: (
    action: string,
    params: Record<string, unknown>,
    rpcCall: RpcCall,
    toolCallId: string,
  ) => Promise<unknown>;
  /**
   * Optional per-action callback to AUGMENT the `details` field of the returned
   * AgentToolResult. Called AFTER the actionHandler resolves; receives the raw
   * params, the actionHandler's result, and returns an object whose entries are
   * merged into `jsonResult(result).details`.
   *
   * Used by `message(action='attach')` to capture `visibleDelivery` for JSONL
   * persistence. Caller-driven — the factory itself does not assume any
   * specific augmentation shape.
   *
   * The augmenter MUST NOT touch `wrapped.content` — the OpenAI Responses
   * converter strips `msg.content` only, so anything in `details` is
   * JSONL-only and never re-enters the prompt context.
   */
  augmentDetails?: Partial<Record<string, (params: Record<string, unknown>, result: unknown) => Record<string, unknown>>>;
}

/**
 * Create a multi-action tool that validates the action parameter then
 * delegates to an action handler.
 *
 * Handles the common pattern: action validation via readEnumParam +
 * action handler dispatch + jsonResult + error handling. Optionally
 * augments the returned `details` field via `config.augmentDetails[action]`
 * (see `MultiActionDispatchConfig.augmentDetails`).
 *
 * @param config - Tool configuration
 * @param rpcCall - RPC call function
 * @returns AgentTool that routes actions to the handler
 */
export function createMultiActionDispatchTool<T extends TSchema>(
  config: MultiActionDispatchConfig<T>,
  rpcCall: RpcCall,
): AgentTool<T> {
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,

    async execute(
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as Record<string, unknown>;
        const action = readEnumParam(
          p,
          "action",
          config.validActions as unknown as readonly string[],
        );
        const result = await config.actionHandler(action, p, rpcCall, toolCallId);
        const wrapped = jsonResult(result);
        // Opt-in details augmentation. Caller registers a per-action
        // augmenter; the factory merges its output into details.
        // The augmenter MUST NOT touch `wrapped.content` — the OpenAI Responses
        // converter strips msg.content only, so anything in details is
        // JSONL-only and never re-enters the prompt context.
        const augmenter = config.augmentDetails?.[action];
        if (augmenter) {
          const augmented = augmenter(p, result);
          return {
            ...wrapped,
            details: { ...(wrapped.details ?? {}), ...augmented },
          };
        }
        return wrapped;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
