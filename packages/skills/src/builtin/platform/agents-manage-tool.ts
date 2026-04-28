// SPDX-License-Identifier: Apache-2.0
/**
 * Agent management tool: multi-action tool for fleet management.
 *
 * Supports 6 actions: create, get, update, delete, suspend, resume.
 * Destructive actions (create, delete) require approval via the ApprovalGate.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to agents.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { readStringParam } from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const AgentsManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("get"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("suspend"),
      Type.Literal("resume"),
    ],
    { description: "Agent management action. Valid values: create (new agent), get (read config/status), update (modify config), delete (remove agent), suspend (pause execution), resume (restart execution)" },
  ),
  agent_id: Type.String({
    description: "The agent identifier (required for all actions)",
  }),
  config: Type.Optional(
    // Accept EITHER a structured object OR a JSON string. Anthropic's LLM
    // sometimes emits nested free-form objects as stringified JSON; coerceConfig()
    // below parses the string back to an object at execution time. Keeping the
    // structured shape as the preferred option preserves schema documentation
    // for the LLM while the string fallback prevents validation-layer rejection
    // of the stringified form.
    Type.Union([
      Type.Object(
        {
          name: Type.Optional(Type.String({ description: "Human-readable agent name" })),
          model: Type.Optional(Type.String({ description: "LLM model identifier" })),
          provider: Type.Optional(Type.String({ description: "LLM provider name" })),
          maxSteps: Type.Optional(Type.Integer({ description: "Maximum execution steps per turn" })),
          workspace_profile: Type.Optional(
            Type.Union([Type.Literal("full"), Type.Literal("specialist")], {
              description:
                "Workspace profile controlling platform instruction verbosity. " +
                "Valid values: full (~9K tokens, user-facing agents on channels), " +
                "specialist (~800 tokens, task workers and fleet sub-agents). " +
                "Default: full. Can be changed later via update action. " +
                "Alternative shape: nested workspace.profile (see `workspace` field).",
            }),
          ),
          // 260428-oyc: declare nested workspace shape explicitly. The LLM
          // sometimes emits `workspace: {profile: "specialist"}` directly
          // (mirroring the downstream Zod schema-agent.ts:733-738 shape).
          // Without this declaration, the unknown nested object slipped past
          // TypeBox structurally but the enum was never validated -- invalid
          // values would only be caught later at the Zod layer with a less
          // actionable error path. Declaring it here makes both shapes
          // first-class and gates the enum at the tool-validation boundary.
          workspace: Type.Optional(
            Type.Object(
              {
                profile: Type.Union(
                  [Type.Literal("full"), Type.Literal("specialist")],
                  {
                    description:
                      "Workspace profile (alternative to flat workspace_profile). Valid: full | specialist.",
                  },
                ),
              },
              {
                description:
                  "Nested workspace configuration. Use this OR the flat workspace_profile field, not both.",
                additionalProperties: false,
              },
            ),
          ),
          skills: Type.Optional(
            Type.Object(
              {
                builtinTools: Type.Optional(
                  Type.Object(
                    {
                      read: Type.Optional(Type.Boolean({ description: "Enable file reading" })),
                      write: Type.Optional(Type.Boolean({ description: "Enable file writing" })),
                      edit: Type.Optional(Type.Boolean({ description: "Enable file editing" })),
                      grep: Type.Optional(Type.Boolean({ description: "Enable regex search across files" })),
                      find: Type.Optional(Type.Boolean({ description: "Enable file search by glob pattern" })),
                      ls: Type.Optional(Type.Boolean({ description: "Enable directory listing" })),
                      exec: Type.Optional(Type.Boolean({ description: "Enable shell command execution" })),
                      process: Type.Optional(Type.Boolean({ description: "Enable background process management" })),
                      webSearch: Type.Optional(Type.Boolean({ description: "Enable web search" })),
                      webFetch: Type.Optional(Type.Boolean({ description: "Enable URL content fetching" })),
                      browser: Type.Optional(Type.Boolean({ description: "Enable headless browser control" })),
                    },
                    { description: "Built-in tool toggles (true=enabled, false=disabled)" },
                  ),
                ),
              },
              { description: "Skills and tool configuration" },
            ),
          ),
        },
        { description: "Agent configuration for create/update actions" },
      ),
      Type.String({
        description:
          "Agent configuration as a JSON string (fallback when the LLM stringifies the object). " +
          "Will be parsed at execution time. Prefer the object form.",
      }),
    ]),
  ),
});

const VALID_ACTIONS = ["create", "get", "update", "delete", "suspend", "resume"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map flat workspace_profile param to nested workspace.profile config.
 * Mutates config in place.
 *
 * 260428-oyc: precedence is "flat wins" -- when both flat workspace_profile
 * and nested workspace.profile are present, the flat field overwrites the
 * nested one. This matches the existing spread semantics
 * (`{...existing, profile}`) and keeps a single deterministic rule. When only
 * nested is present (no `workspace_profile` key), this is a no-op and the
 * nested shape flows through unchanged to the downstream Zod validator.
 */
function mapWorkspaceProfile(config: Record<string, unknown> | undefined): void {
  if (!config) return;
  if (!("workspace_profile" in config)) {
    // Nested-only or no workspace fields -- nothing to map. Downstream Zod
    // (PerAgentConfigSchema.workspace) validates the nested shape directly.
    return;
  }
  const profile = config.workspace_profile;
  delete config.workspace_profile;
  if (typeof profile === "string") {
    config.workspace = {
      ...((config.workspace as Record<string, unknown>) ?? {}),
      profile,
    };
  }
}

/** Coerce config from JSON string to object if LLM double-encoded it. */
function coerceConfig(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = p.config;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* not valid JSON, fall through */ }
  }
  return raw as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an agent management tool with 6 actions.
 *
 * Actions:
 * - **create** -- Create a new agent (requires approval)
 * - **get** -- Get agent configuration and status
 * - **update** -- Update agent configuration
 * - **delete** -- Delete an agent (requires approval)
 * - **suspend** -- Suspend agent execution
 * - **resume** -- Resume a suspended agent
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param approvalGate - Optional approval gate for create/delete actions
 * @returns AgentTool implementing the agent management interface
 */
export function createAgentsManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
  callbacks?: {
    onMutationStart?: () => void;
    onMutationEnd?: () => void;
    /**
     * Fired after a successful `agents.create` RPC with the new agent's
     * workspace directory. Lets the caller register seeded template files
     * in its FileStateTracker so the LLM's `write` tool can overwrite the
     * seed without hitting the read-before-write (`[not_read]`) gate.
     */
    onAgentCreated?: (info: { agentId: string; workspaceDir?: string }) => Promise<void> | void;
  },
): AgentTool<typeof AgentsManageToolParams> {
  return createAdminManageTool(
    {
      name: "agents_manage",
      label: "Agent Management",
      description:
        "Manage agent fleet: create, get, update, delete, suspend, resume. " +
        "Use update to switch an agent's LLM provider or model (e.g. switch to Gemini, change model). " +
        "Create/delete require approval.",
      parameters: AgentsManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "agents",
      gatedActions: ["create", "delete"],
      actionOverrides: {
        async create(p, rpcCall, ctx) {
          const agentId = readStringParam(p, "agent_id");
          const config = coerceConfig(p);
          mapWorkspaceProfile(config);
          callbacks?.onMutationStart?.();
          try {
            const result = await rpcCall("agents.create", { agentId, config, _trustLevel: ctx.trustLevel });
            // Best-effort seed registration hook. Fires only on successful
            // RPC return. Callback failures are swallowed — the agent was
            // created; tracker registration is an optimization, not a gate.
            if (callbacks?.onAgentCreated) {
              try {
                const workspaceDir = (result as { workspaceDir?: string } | undefined)?.workspaceDir;
                // agentId is guaranteed non-undefined by readStringParam(required=true) above.
                const aid = agentId as string;
                await callbacks.onAgentCreated(
                  workspaceDir !== undefined ? { agentId: aid, workspaceDir } : { agentId: aid },
                );
              } catch {
                /* non-fatal */
              }
            }
            return result;
          } finally {
            callbacks?.onMutationEnd?.();
          }
        },
        async get(p, rpcCall, ctx) {
          const agentId = readStringParam(p, "agent_id");
          return rpcCall("agents.get", { agentId, _trustLevel: ctx.trustLevel });
        },
        async update(p, rpcCall, ctx) {
          const agentId = readStringParam(p, "agent_id");
          const config = coerceConfig(p);
          mapWorkspaceProfile(config);
          callbacks?.onMutationStart?.();
          try {
            return await rpcCall("agents.update", { agentId, config, _trustLevel: ctx.trustLevel });
          } finally {
            callbacks?.onMutationEnd?.();
          }
        },
        async delete(p, rpcCall, ctx) {
          const agentId = readStringParam(p, "agent_id");
          callbacks?.onMutationStart?.();
          try {
            return await rpcCall("agents.delete", { agentId, _trustLevel: ctx.trustLevel });
          } finally {
            callbacks?.onMutationEnd?.();
          }
        },
        async suspend(p, rpcCall, ctx) {
          const agentId = readStringParam(p, "agent_id");
          return rpcCall("agents.suspend", { agentId, _trustLevel: ctx.trustLevel });
        },
        async resume(p, rpcCall, ctx) {
          const agentId = readStringParam(p, "agent_id");
          return rpcCall("agents.resume", { agentId, _trustLevel: ctx.trustLevel });
        },
      },
    },
    rpcCall,
    approvalGate,
    callbacks,
  );
}
