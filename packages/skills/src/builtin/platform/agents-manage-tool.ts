// SPDX-License-Identifier: Apache-2.0
/**
 * Agent management tool: multi-action tool for fleet management.
 *
 * Supports 7 actions: create, get, update, delete, suspend, resume, list.
 * Destructive actions (create, delete) require approval via the ApprovalGate.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to agents.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { readStringParam } from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

export const AgentsManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("get"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("suspend"),
      Type.Literal("resume"),
      Type.Literal("list"),
    ],
    { description: "Agent management action. Valid values: create (new agent), get (read config/status), update (modify config), delete (remove agent), suspend (pause execution), resume (restart execution), list (all agent IDs)" },
  ),
  agent_id: Type.Optional(Type.String({
    description: "The agent identifier (required for all actions except list)",
  })),
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
                "specialist (~800 tokens, task workers and fleet sub-agents) ONLY. NO other values accepted. " +
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
                      "Workspace profile (alternative to flat workspace_profile). Valid: full | specialist ONLY. NO other values accepted.",
                  },
                ),
                // 260428-vyf L2: inline ROLE.md / IDENTITY.md content. The tool
                // handler strips these from the config payload BEFORE the RPC
                // and forwards them as a separate top-level `inlineContent`
                // param. The daemon writes them as files (write-once side-
                // effect); they are NEVER persisted to config.yaml. When
                // omitted, the seed templates remain in place and the LLM is
                // instructed via the next-step contract to call write()
                // afterward (the FALLBACK 2-step flow).
                role: Type.Optional(
                  Type.String({
                    description:
                      "Inline ROLE.md content. Written to <workspaceDir>/ROLE.md immediately on create. Should describe the agent's purpose, behavioral guidelines, domain conventions. Max 16384 chars. When omitted, ROLE.md is the unmodified seed template — call write() afterward to customize.",
                    maxLength: 16384,
                  }),
                ),
                identity: Type.Optional(
                  Type.String({
                    description:
                      "Inline IDENTITY.md content. Written to <workspaceDir>/IDENTITY.md immediately on create. Should set name/creature/vibe/emoji/avatar/ethos for the agent. Max 4096 chars. When omitted, IDENTITY.md is the unmodified seed template.",
                    maxLength: 4096,
                  }),
                ),
              },
              {
                description:
                  "Nested workspace configuration. Use this OR the flat workspace_profile field, not both. Optionally inline ROLE.md / IDENTITY.md via role/identity for single-call creation (PREFERRED for batch fleet creation).",
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

const VALID_ACTIONS = ["create", "get", "update", "delete", "suspend", "resume", "list"] as const;

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

// 260428-vyf L2: shape of the inline-write outcome the daemon attaches to
// the agents.create RPC return when the caller supplied inlineContent. The
// daemon either writes the success-shape (`AgentInlineWritesValue`) or the
// failure-shape (`AgentInlineWritesError`). When inlineContent was absent,
// the field is omitted entirely from the RPC payload.
export interface AgentInlineWritesValue {
  roleWritten: boolean;
  identityWritten: boolean;
  bytesWritten: number;
}
export interface AgentInlineWritesError {
  ok: false;
  error: {
    kind: "oversize" | "path_traversal" | "io";
    file: "ROLE.md" | "IDENTITY.md";
    [k: string]: unknown;
  };
}

/**
 * Build the post-create next-step contract emitted as the FIRST text block
 * of the `agents_manage.create` tool_result. The freshest, uncached surface
 * the LLM reads on every turn -- pinned here to fix the silent-termination
 * bug where TOOL_GUIDE prescriptive text gets crowded out under high
 * parallel-tool-call load (production session 1a8b0d91 turn 13: 9 sub-agents
 * created in parallel, then a 0-text 0-thinking 0-tool turn).
 *
 * Pure string composition. No I/O, no Result<T,E> needed (per AGENTS.md
 * §2.1: Result is for fallible paths only; this is infallible).
 *
 * Three branches keyed on `inlineWritesResult` (260428-vyf):
 *  - BOTH written → SHORT contract: "No further setup needed — agent is
 *    operationally ready". Skips the post-create write() roundtrip.
 *  - PARTIAL (only one of role/identity written) → mixed contract pointing
 *    only at the still-template file with a single "Next required action".
 *  - NEITHER (or write failure / undefined) → existing 260428-sw2 2-step
 *    contract verbatim, telling the LLM to call write() for ROLE.md.
 *
 * Case B (workspaceDir absent — defensive fallback): shorter form pinning
 * "Customize {agentId}'s workspace ROLE.md and IDENTITY.md before using."
 */
export function buildCreateContract(
  agentId: string,
  workspaceDir: string | undefined,
  inlineWritesResult?: AgentInlineWritesValue | AgentInlineWritesError,
): string {
  // BOTH written → SHORT operationally-ready contract.
  if (
    workspaceDir !== undefined
    && inlineWritesResult !== undefined
    && "roleWritten" in inlineWritesResult
    && inlineWritesResult.roleWritten
    && inlineWritesResult.identityWritten
  ) {
    return `✓ Agent ${agentId} created at ${workspaceDir} with inline ROLE.md and IDENTITY.md (${inlineWritesResult.bytesWritten} bytes total). No further setup needed — agent is operationally ready.`;
  }

  // PARTIAL (exactly one of role/identity written).
  if (
    workspaceDir !== undefined
    && inlineWritesResult !== undefined
    && "roleWritten" in inlineWritesResult
    && (inlineWritesResult.roleWritten || inlineWritesResult.identityWritten)
  ) {
    const written = inlineWritesResult.roleWritten ? "ROLE.md" : "IDENTITY.md";
    const remaining = inlineWritesResult.roleWritten ? "IDENTITY.md" : "ROLE.md";
    return [
      `✓ Agent ${agentId} created at ${workspaceDir} with inline ${written} (${inlineWritesResult.bytesWritten} bytes).`,
      `⚠ ${remaining} is still the unmodified template.`,
      `Next required action for this agent: call write({path: "${workspaceDir}/${remaining}", content: "..."}). This agent is NOT ready until ${remaining} is customized.`,
    ].join("\n");
  }

  // NEITHER (no inlineContent supplied, write failure, or undefined): fall
  // through to the existing 260428-sw2 2-step contract verbatim.
  if (workspaceDir !== undefined) {
    return [
      `✓ Agent ${agentId} created at ${workspaceDir}.`,
      `⚠ Workspace files are TEMPLATES — not yet operationally configured. Customize before use:`,
      `  • ${workspaceDir}/ROLE.md      — purpose, behavioral guidelines, domain conventions`,
      `  • ${workspaceDir}/IDENTITY.md  — name, creature, vibe, emoji`,
      `Next required action for this agent: call write({path: "${workspaceDir}/ROLE.md", content: "..."}). This agent is NOT ready until ROLE.md is customized.`,
    ].join("\n");
  }
  return `✓ Agent ${agentId} created. Customize ${agentId}'s workspace ROLE.md and IDENTITY.md before using.`;
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
 * Create an agent management tool with 7 actions.
 *
 * Actions:
 * - **create** -- Create a new agent (requires approval)
 * - **get** -- Get agent configuration and status
 * - **update** -- Update agent configuration
 * - **delete** -- Delete an agent (requires approval)
 * - **suspend** -- Suspend agent execution
 * - **resume** -- Resume a suspended agent
 * - **list** -- List all available agent IDs
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param logger - Required structured logger. Used to emit a per-create
 *   INFO log pinning the next-step contract emission (260428-sw2 Layer 1).
 *   Mirrors the gateway-tool required-logger position; no overload-with-
 *   default-logger compat shim (per `feedback_no_backward_compat.md`).
 * @param approvalGate - Optional approval gate for create/delete actions
 * @returns AgentTool implementing the agent management interface
 */
export function createAgentsManageTool(
  rpcCall: RpcCall,
  logger: ComisLogger,
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
        "Manage agent fleet: create, get, update, delete, suspend, resume, list. " +
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

          // Map common LLM-hallucinated "system prompt" field names to
          // workspace.role — the correct inline ROLE.md path. Runs after
          // coerceConfig (catches string-form) and before L2 stripping.
          if (config && typeof config === "object") {
            const ROLE_ALIASES = ["systemPrompt", "system", "prompt", "instructions", "systemMessage", "description"] as const;
            const c = config as Record<string, unknown>;
            for (const alias of ROLE_ALIASES) {
              if (typeof c[alias] === "string") {
                const ws = (c.workspace ??= {}) as Record<string, unknown>;
                if (typeof ws.role !== "string") ws.role = c[alias] as string;
                delete c[alias];
                break;
              }
            }
          }

          // 260428-vyf L2 (Path A): strip workspace.role / workspace.identity
          // from the config payload BEFORE the RPC and forward them as a
          // separate top-level `inlineContent` parameter. Rationale: the
          // downstream Zod schema (PerAgentConfigSchema.workspace at
          // packages/core/src/config/schema-agent.ts) is z.strictObject —
          // unknown keys would trigger Zod `unrecognized_keys` rejection.
          // role/identity are write-once side-effects (ROLE.md / IDENTITY.md
          // file writes), NOT durable state — they MUST NOT leak into
          // config.yaml. Path B (extending Zod schema-agent.ts) was
          // rejected because it would persist them.
          let inlineContent: { role?: string; identity?: string } | undefined;
          if (config && typeof config === "object") {
            const ws = (config as Record<string, unknown>).workspace as Record<string, unknown> | undefined;
            if (ws && (typeof ws.role === "string" || typeof ws.identity === "string")) {
              inlineContent = {};
              if (typeof ws.role === "string") {
                inlineContent.role = ws.role;
                delete ws.role;
              }
              if (typeof ws.identity === "string") {
                inlineContent.identity = ws.identity;
                delete ws.identity;
              }
            }
          }

          callbacks?.onMutationStart?.();
          try {
            const rpcParams: Record<string, unknown> = { agentId, config, _trustLevel: ctx.trustLevel };
            if (inlineContent !== undefined) rpcParams.inlineContent = inlineContent;
            const result = await rpcCall("agents.create", rpcParams);
            // agentId is guaranteed non-undefined by readStringParam(required=true) above.
            const aid = agentId as string;
            const workspaceDir = (result as { workspaceDir?: string } | undefined)?.workspaceDir;
            const inlineWritesResult = (result as
              | { inlineWritesResult?: AgentInlineWritesValue | AgentInlineWritesError }
              | undefined)?.inlineWritesResult;

            // 260428-sw2 Layer 1 + 260428-vyf Layer 2: emit the next-step
            // contract on the freshest, uncached surface the LLM reads each
            // turn (the tool_result text). The contract has 3 branches keyed
            // on inlineWritesResult (see buildCreateContract). One structured
            // INFO log pins this happened.
            const contractText = buildCreateContract(aid, workspaceDir, inlineWritesResult);
            // Distinguish the 3 inline-write outcomes for observability.
            // "none"    — caller did not supply inlineContent
            // "written" — helper succeeded (full or partial)
            // "failed"  — helper returned err shape (oversize|path_traversal|io)
            const inlineWritesOutcome: "none" | "written" | "failed" =
              inlineWritesResult === undefined
                ? "none"
                : "roleWritten" in inlineWritesResult
                  ? "written"
                  : "failed";
            logger.info(
              {
                module: "skill.agents-manage",
                action: "create",
                agentId: aid,
                workspaceDir: workspaceDir ?? null,
                contractEmitted: true,
                inlineWritesOutcome,
              },
              "agents_manage.create succeeded — next-step contract emitted",
            );

            // Best-effort seed registration hook. Fires only on successful
            // RPC return. Callback failures are swallowed — the agent was
            // created; tracker registration is an optimization, not a gate.
            if (callbacks?.onAgentCreated) {
              try {
                await callbacks.onAgentCreated(
                  workspaceDir !== undefined ? { agentId: aid, workspaceDir } : { agentId: aid },
                );
              } catch {
                /* non-fatal */
              }
            }

            // Return a 2-text-block AgentToolResult passed through verbatim
            // by admin-manage-factory's isAgentToolResult guard:
            //  - block 0: the next-step contract (high-attention text)
            //  - block 1: the JSON-rendered RPC fields (preserves the
            //    structured view existing pin/regression tests assert)
            // `details` is the raw RPC return so result.details assertions
            // continue to pass unchanged.
            return {
              content: [
                { type: "text", text: contractText },
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
              details: result,
            } satisfies AgentToolResult<typeof result>;
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
        async list(_p, rpcCall, ctx) {
          return rpcCall("agents.list", { _trustLevel: ctx.trustLevel });
        },
      },
    },
    rpcCall,
    approvalGate,
    callbacks,
  );
}
