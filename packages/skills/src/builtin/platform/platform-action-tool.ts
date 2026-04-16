/**
 * Shared factory for platform action tools (Telegram, Discord, Slack, WhatsApp).
 *
 * Each platform provides a PlatformActionDescriptor with its schema, RPC method,
 * and gated (destructive) actions. The factory produces a uniform AgentTool that
 * handles gate checks, RPC delegation, optional logging, and error formatting.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { jsonResult, readStringParam, createActionGate } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Descriptor types
// ---------------------------------------------------------------------------

/**
 * A single action that requires user confirmation before execution.
 */
interface GatedAction {
  /** The action value that triggers the gate (e.g., "ban", "kick"). */
  action: string;
  /** The gate key passed to createActionGate (e.g., "telegram.ban"). */
  gateKey: string;
  /** The confirmation hint returned to the LLM when the gate fires. */
  hint: string;
}

/**
 * Describes a platform action tool's metadata and behavior.
 *
 * Each platform (Telegram, Discord, Slack, WhatsApp) provides one descriptor;
 * createPlatformActionTool() turns it into a fully-wired AgentTool.
 */
export interface PlatformActionDescriptor {
  /** Tool name exposed to the LLM (e.g., "telegram_action"). */
  name: string;
  /** Human-readable label (e.g., "Telegram Actions"). */
  label: string;
  /** Tool description shown in the manifest. */
  description: string;
  /** TypeBox parameter schema -- passed by reference, never cloned. */
  parameters: TSchema;
  /** RPC method for delegating actions (e.g., "telegram.action"). */
  rpcMethod: string;
  /** Actions that require user confirmation before execution. */
  gatedActions: GatedAction[];
  /** Optional structured logger for DEBUG-level operation logging. */
  logger?: {
    debug(obj: Record<string, unknown>, msg: string): void;
    info(obj: Record<string, unknown>, msg: string): void;
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a platform action tool from a descriptor.
 *
 * Handles gate checks for destructive actions, RPC delegation, optional
 * logger calls (before/after RPC), and uniform error formatting.
 *
 * @param descriptor - Platform-specific metadata and gated actions
 * @param rpcCall - RPC call function for delegating to the platform backend
 * @returns AgentTool implementing the platform actions interface
 */
export function createPlatformActionTool(
  descriptor: PlatformActionDescriptor,
  rpcCall: RpcCall,
): AgentTool<typeof descriptor.parameters> {
  // Pre-create all action gates at tool construction time
  const gates = descriptor.gatedActions.map((g) => ({
    action: g.action,
    gate: createActionGate(g.gateKey),
    hint: g.hint,
  }));

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
        const p = params as Record<string, unknown>;
        const action = readStringParam(p, "action");

        // Check each gated action
        for (const g of gates) {
          if (action === g.action) {
            const gateResult = g.gate(p);
            if (gateResult.requiresConfirmation) {
              return jsonResult({
                requiresConfirmation: true,
                actionType: gateResult.actionType,
                hint: g.hint,
              });
            }
            break;
          }
        }

        // Optional structured logging before RPC
        descriptor.logger?.debug(
          { toolName: descriptor.name, action, channelType: descriptor.name.replace("_action", "") },
          `${descriptor.label.replace(" Actions", "")} action requested`,
        );

        // Delegate to the platform backend
        const result = await rpcCall(descriptor.rpcMethod, { action, ...p });

        // Optional structured logging after RPC
        descriptor.logger?.debug(
          { toolName: descriptor.name, action, channelType: descriptor.name.replace("_action", "") },
          `${descriptor.label.replace(" Actions", "")} action completed`,
        );

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
