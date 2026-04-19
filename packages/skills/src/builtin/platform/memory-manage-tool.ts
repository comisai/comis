/**
 * Memory management tool: multi-action tool for memory lifecycle management.
 *
 * Supports 5 actions: stats, browse, delete, flush, export.
 * Destructive actions (delete, flush) require approval via the ApprovalGate.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to memory.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { tryGetContext } from "@comis/core";
import {
  jsonResult,
  throwToolError,
  readEnumParam,
  createTrustGuard,
} from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const MemoryManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("stats"),
      Type.Literal("browse"),
      Type.Literal("delete"),
      Type.Literal("flush"),
      Type.Literal("export"),
    ],
    { description: "Memory management action. Valid values: stats (DB size and entry counts), browse (paginated entry listing), delete (remove entries by ID), flush (clear all entries for scope), export (full JSON export)" },
  ),
  tenant_id: Type.Optional(
    Type.String({
      description: "Tenant ID scope (defaults to current tenant)",
    }),
  ),
  agent_id: Type.Optional(
    Type.String({
      description: "Agent ID scope for filtering",
    }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description: "Array of memory entry IDs to delete (required for delete action)",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      description: "Pagination offset (default: 0)",
      minimum: 0,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Pagination limit (default: 20 for browse, 1000 for export)",
      minimum: 1,
      maximum: 5000,
    }),
  ),
  sort: Type.Optional(
    Type.Union(
      [Type.Literal("newest"), Type.Literal("oldest")],
      { description: "Sort order for browse (default: newest). Valid values: newest (most recent first), oldest (earliest first)" },
    ),
  ),
  memory_type: Type.Optional(
    Type.String({
      description: "Filter by memory type (working, episodic, semantic, procedural)",
    }),
  ),
  trust_level: Type.Optional(
    Type.String({
      description: "Filter by trust level (system, learned, external)",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by tags (entries must have all specified tags)",
    }),
  ),
});

type MemoryManageToolParamsType = Static<typeof MemoryManageToolParams>;

const VALID_ACTIONS = ["stats", "browse", "delete", "flush", "export"] as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a memory management tool with 5 actions.
 *
 * Actions:
 * - **stats** -- Get memory statistics (DB size, entry counts, FTS health)
 * - **browse** -- Paginated browsing of memory entries with filters
 * - **delete** -- Delete specific memory entries by ID array (requires approval)
 * - **flush** -- Flush all memory entries for a scope (requires approval)
 * - **export** -- Export full memory entries as JSON
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param approvalGate - Optional approval gate for delete/flush actions
 * @returns AgentTool implementing the memory management interface
 */
export function createMemoryManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
): AgentTool<typeof MemoryManageToolParams> {
  const trustGuard = createTrustGuard("memory_manage");

  return {
    name: "memory_manage",
    label: "Memory Management",
    description:
      "Admin memory CRUD: stats, browse, delete, flush, export. Delete/flush require approval.",
    parameters: MemoryManageToolParams,

    async execute(
      _toolCallId: string,
      params: MemoryManageToolParamsType,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // Trust guard: enforce admin trust level (throws if insufficient)
        trustGuard();

        const ctx = tryGetContext();
        const _trustLevel = ctx?.trustLevel ?? "guest";

        const p = params as unknown as Record<string, unknown>;
        const action = readEnumParam(p, "action", VALID_ACTIONS);

        switch (action) {
          case "stats": {
            const result = await rpcCall("memory.stats", {
              tenant_id: p.tenant_id,
              agent_id: p.agent_id,
              _trustLevel,
            });
            return jsonResult(result);
          }

          case "browse": {
            const result = await rpcCall("memory.browse", {
              offset: p.offset,
              limit: p.limit,
              sort: p.sort,
              tenant_id: p.tenant_id,
              agent_id: p.agent_id,
              memory_type: p.memory_type,
              trust_level: p.trust_level,
              tags: p.tags,
              _trustLevel,
            });
            return jsonResult(result);
          }

          case "delete": {
            const ids = p.ids;
            // Approval gate check for delete
            if (approvalGate) {
              const ctx = tryGetContext();
              const resolution = await approvalGate.requestApproval({
                toolName: "memory_manage",
                action: "memory.delete",
                params: { ids },
                agentId: ctx?.userId ?? "unknown",
                sessionKey: ctx?.sessionKey ?? "unknown",
                trustLevel: (ctx?.trustLevel ?? "guest") as "admin" | "user" | "guest",
                channelType: ctx?.channelType,
              });
              if (!resolution.approved) {
                throwToolError("permission_denied", `Action denied: memory.delete was not approved`, {
                  hint: resolution.reason ?? "Request approval before retrying.",
                });
              }
            }
            const result = await rpcCall("memory.delete", {
              ids: p.ids,
              tenant_id: p.tenant_id,
              _trustLevel,
            });
            return jsonResult(result);
          }

          case "flush": {
            // Approval gate check for flush
            if (approvalGate) {
              const ctx = tryGetContext();
              const resolution = await approvalGate.requestApproval({
                toolName: "memory_manage",
                action: "memory.flush",
                params: { tenant_id: p.tenant_id, agent_id: p.agent_id },
                agentId: ctx?.userId ?? "unknown",
                sessionKey: ctx?.sessionKey ?? "unknown",
                trustLevel: (ctx?.trustLevel ?? "guest") as "admin" | "user" | "guest",
                channelType: ctx?.channelType,
              });
              if (!resolution.approved) {
                throwToolError("permission_denied", `Action denied: memory.flush was not approved`, {
                  hint: resolution.reason ?? "Request approval before retrying.",
                });
              }
            }
            const result = await rpcCall("memory.flush", {
              tenant_id: p.tenant_id,
              agent_id: p.agent_id,
              _trustLevel,
            });
            return jsonResult(result);
          }

          case "export": {
            const result = await rpcCall("memory.export", {
              offset: p.offset,
              limit: p.limit,
              tenant_id: p.tenant_id,
              agent_id: p.agent_id,
              _trustLevel,
            });
            return jsonResult(result);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
