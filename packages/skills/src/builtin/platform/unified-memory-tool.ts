/**
 * Unified Memory Tool: single tool with action dispatch covering get, search, store, manage.
 *
 * Consolidates 4 individual memory tools into one tool with an `action` parameter:
 * - action "get" -> memory.get_file RPC (from memory-get-tool)
 * - action "search" -> memory.search_files RPC (from memory-search-tool)
 * - action "store" -> memory.store RPC (from memory-store-tool)
 * - action "manage" -> memory.{stats,browse,delete,flush,export} RPC (from memory-manage-tool)
 *
 * The "manage" action delegates to sub-actions via the manage_action parameter,
 * preserving the approval gate and trust guard from the original memory-manage-tool.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { tryGetContext } from "@comis/core";
import {
  jsonResult,
  throwToolError,
  readEnumParam,
  readStringParam,
  readNumberParam,
  createTrustGuard,
} from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// -- Secret detection (from memory-store-tool) --------------------------------

/** Patterns that suggest content contains an API key or secret. */
const SECRET_PATTERNS = [
  /\bAIza[A-Za-z0-9_-]{30,}\b/,      // Google / Gemini
  /\bsk-[A-Za-z0-9]{20,}\b/,          // OpenAI / Anthropic
  /\bgsk_[A-Za-z0-9]{20,}\b/,         // Groq
  /\bghp_[A-Za-z0-9]{36,}\b/,         // GitHub PAT
  /\btvly-[A-Za-z0-9]{20,}\b/,        // Tavily
  /\bxai-[A-Za-z0-9]{20,}\b/,         // xAI
];

function contentLooksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// -- Parameter Schema --------------------------------------------------------

const VALID_ACTIONS = ["get", "search", "store", "manage"] as const;
const VALID_MANAGE_ACTIONS = ["stats", "browse", "delete", "flush", "export"] as const;

const UnifiedMemoryParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("get"),
      Type.Literal("search"),
      Type.Literal("store"),
      Type.Literal("manage"),
    ],
    {
      description:
        "Memory action to perform. Valid values: get (read memory file sections by path), " +
        "search (semantic search over agent memory), " +
        "store (persist information for future recall), " +
        "manage (admin CRUD: stats, browse, delete, flush, export)",
    },
  ),
  // get params
  path: Type.Optional(
    Type.String({ description: "File path relative to workspace (action: get)" }),
  ),
  start_line: Type.Optional(
    Type.Integer({ description: "Start line (1-based) (action: get)" }),
  ),
  end_line: Type.Optional(
    Type.Integer({ description: "End line (1-based) (action: get)" }),
  ),
  // search params
  query: Type.Optional(
    Type.String({ description: "Semantic search query (action: search)" }),
  ),
  // store params
  content: Type.Optional(
    Type.String({ description: "The text content to store in memory (action: store)" }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Optional tags for categorisation (action: store, manage)" }),
  ),
  // manage params
  manage_action: Type.Optional(
    Type.Union(
      [
        Type.Literal("stats"),
        Type.Literal("browse"),
        Type.Literal("delete"),
        Type.Literal("flush"),
        Type.Literal("export"),
      ],
      { description: "Sub-action for manage. Valid values: stats, browse, delete, flush, export (action: manage)" },
    ),
  ),
  tenant_id: Type.Optional(
    Type.String({ description: "Tenant ID scope (action: manage)" }),
  ),
  agent_id: Type.Optional(
    Type.String({ description: "Agent ID scope for filtering (action: manage)" }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String(), { description: "Array of memory entry IDs to delete (action: manage, manage_action: delete)" }),
  ),
  offset: Type.Optional(
    Type.Integer({ description: "Pagination offset (default: 0) (action: manage)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max results (action: search default 10, action: manage varies)" }),
  ),
  sort: Type.Optional(
    Type.Union(
      [Type.Literal("newest"), Type.Literal("oldest")],
      { description: "Sort order for browse (default: newest) (action: manage, manage_action: browse)" },
    ),
  ),
  memory_type: Type.Optional(
    Type.String({ description: "Filter by memory type (action: manage)" }),
  ),
  trust_level: Type.Optional(
    Type.String({ description: "Filter by trust level (action: manage)" }),
  ),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create a unified memory tool with action dispatch covering get, search, store, manage.
 *
 * @param rpcCall - RPC function for daemon communication
 * @param approvalGate - Optional approval gate for manage delete/flush actions
 * @returns AgentTool implementing memory_tool
 */
export function createUnifiedMemoryTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
): AgentTool<typeof UnifiedMemoryParams> {
  const trustGuard = createTrustGuard("memory_tool");

  return {
    name: "memory_tool",
    label: "Memory Tool",
    description:
      "Unified memory management tool. Actions: " +
      "get (read memory file sections by path with optional line range), " +
      "search (semantic search over memories and session transcripts), " +
      "store (persist facts, preferences, or context for future recall), " +
      "manage (admin CRUD -- stats, browse, delete, flush, export; delete/flush require approval).",
    parameters: UnifiedMemoryParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const action = readEnumParam(params, "action", VALID_ACTIONS);

        switch (action) {
          case "get": {
            const path = readStringParam(params, "path");
            const startLine = readNumberParam(params, "start_line", false);
            const endLine = readNumberParam(params, "end_line", false);

            const rpcParams: Record<string, unknown> = { path };
            if (startLine !== undefined) rpcParams.startLine = startLine;
            if (endLine !== undefined) rpcParams.endLine = endLine;

            const result = await rpcCall("memory.get_file", rpcParams);
            return jsonResult(result);
          }

          case "search": {
            const query = readStringParam(params, "query");
            const limit = readNumberParam(params, "limit", false) ?? 10;
            const result = await rpcCall("memory.search_files", { query, limit });
            return jsonResult(result);
          }

          case "store": {
            const content = readStringParam(params, "content");
            const tags = Array.isArray(params.tags)
              ? (params.tags as unknown[]).filter((t): t is string => typeof t === "string")
              : [];

            const result = await rpcCall("memory.store", { content, tags });

            // Warn if content appears to contain an API key or secret
            if (content && contentLooksLikeSecret(content)) {
              return jsonResult({
                ...((typeof result === "object" && result !== null) ? result : { stored: true }),
                warning: "This content appears to contain an API key or secret. Consider using environment variables ($HOME/.env or config.yaml SecretRef) instead of storing secrets in memory — they may leak into session logs when retrieved.",
              });
            }

            return jsonResult(result);
          }

          case "manage": {
            // Trust guard: enforce admin trust level (throws if insufficient)
            trustGuard();

            const ctx = tryGetContext();
            const _trustLevel = ctx?.trustLevel ?? "guest";

            const manageAction = readEnumParam(params, "manage_action", VALID_MANAGE_ACTIONS);

            switch (manageAction) {
              case "stats": {
                const result = await rpcCall("memory.stats", {
                  tenant_id: params.tenant_id,
                  agent_id: params.agent_id,
                  _trustLevel,
                });
                return jsonResult(result);
              }

              case "browse": {
                const result = await rpcCall("memory.browse", {
                  offset: params.offset,
                  limit: params.limit,
                  sort: params.sort,
                  tenant_id: params.tenant_id,
                  agent_id: params.agent_id,
                  memory_type: params.memory_type,
                  trust_level: params.trust_level,
                  tags: params.tags,
                  _trustLevel,
                });
                return jsonResult(result);
              }

              case "delete": {
                const ids = params.ids;
                if (approvalGate) {
                  const ctx = tryGetContext();
                  const resolution = await approvalGate.requestApproval({
                    toolName: "memory_tool",
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
                  ids: params.ids,
                  tenant_id: params.tenant_id,
                  _trustLevel,
                });
                return jsonResult(result);
              }

              case "flush": {
                if (approvalGate) {
                  const ctx = tryGetContext();
                  const resolution = await approvalGate.requestApproval({
                    toolName: "memory_tool",
                    action: "memory.flush",
                    params: { tenant_id: params.tenant_id, agent_id: params.agent_id },
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
                  tenant_id: params.tenant_id,
                  agent_id: params.agent_id,
                  _trustLevel,
                });
                return jsonResult(result);
              }

              case "export": {
                const result = await rpcCall("memory.export", {
                  offset: params.offset,
                  limit: params.limit,
                  tenant_id: params.tenant_id,
                  agent_id: params.agent_id,
                  _trustLevel,
                });
                return jsonResult(result);
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
