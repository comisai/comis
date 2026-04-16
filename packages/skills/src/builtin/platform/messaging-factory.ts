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

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { jsonResult, readEnumParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

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
      _toolCallId: string,
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
        const result = await rpcCall(config.rpcMethod, rpcParams);
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
  ) => Promise<unknown>;
}

/**
 * Create a multi-action tool that validates the action parameter then
 * delegates to an action handler.
 *
 * Handles the common pattern: action validation via readEnumParam +
 * action handler dispatch + jsonResult + error handling.
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
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as Record<string, unknown>;
        const action = readEnumParam(
          p,
          "action",
          config.validActions as unknown as readonly string[],
        );
        const result = await config.actionHandler(action, p, rpcCall);
        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
