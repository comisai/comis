/**
 * Gateway control tool: multi-action tool for infrastructure management.
 *
 * Supports 10 actions: read, patch, apply, restart, schema, status, history, diff, rollback, env_set.
 * Destructive actions (restart, rollback, apply, env_set) and mutation action (patch) require
 * confirmation via action gates. All actions delegate to the daemon backend via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { tryGetContext, isImmutableConfigPath, MUTABLE_CONFIG_OVERRIDES, matchesOverridePattern, getMutableOverridesForSection } from "@comis/core";
import {
  readStringParam,
  throwToolError,
  createActionGate,
} from "./tool-helpers.js";
import { createMultiActionDispatchTool } from "./messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const GatewayToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("read"),
      Type.Literal("patch"),
      Type.Literal("apply"),
      Type.Literal("restart"),
      Type.Literal("schema"),
      Type.Literal("status"),
      Type.Literal("history"),
      Type.Literal("diff"),
      Type.Literal("rollback"),
      Type.Literal("env_set"),
    ],
    { description: "Gateway control action. Valid values: read (view config section), patch (update single config key), apply (replace entire section), restart (restart gateway), schema (get JSON schema), status (server uptime/connections), history (config change log), diff (compare config versions), rollback (restore previous config), env_set (store secret)" },
  ),
  section: Type.Optional(
    Type.String({
      description:
        "Config section name. Required for patch/apply/schema, optional for read. " +
        "Valid sections: agents, channels, memory, security, routing, daemon, scheduler, " +
        "gateway, integrations, monitoring, browser, models, providers, messages, approvals. " +
        "Note: MCP server settings are under 'integrations', not 'mcp'.",
    }),
  ),
  key: Type.Optional(
    Type.String({
      description: "Dot-notation key within section for patch. For agents section, prefix with the agent ID (e.g., default.model, default.provider, default.maxSteps). Use 'read' action first to see current keys and agent IDs.",
    }),
  ),
  value: Type.Optional(
    Type.Unknown({
      description: "New value for patch (string, number, boolean, object, or array)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of history entries to return (default 10)",
    }),
  ),
  sha: Type.Optional(
    Type.String({
      description: "Git commit SHA for diff comparison or rollback target",
    }),
  ),
  env_key: Type.Optional(
    Type.String({
      description:
        "Environment variable / secret name (uppercase, e.g., OPENAI_API_KEY). Required for env_set. " +
        "After storing a secret via env_set, reference it in config YAML as ${VAR_NAME} " +
        "(e.g., GEMINI_API_KEY: ${GEMINI_API_KEY}). Never write raw API keys into config.",
    }),
  ),
  env_value: Type.Optional(
    Type.String({
      description: "Secret value to store. Required for env_set. Write-only: cannot be read back.",
    }),
  ),
  _confirmed: Type.Optional(
    Type.Boolean({
      description:
        "Set to true when re-calling a destructive action after user approval. " +
        "When a gated action returns requiresConfirmation, present the action to the user, " +
        "and after they approve, call the same action again with _confirmed: true.",
    }),
  ),
});

type GatewayToolParamsType = Static<typeof GatewayToolParams>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a gateway control tool with 10 actions.
 *
 * Actions:
 * - **read** -- Read current config for a section (or all sections)
 * - **patch** -- Update a config key within a section (gated, immutable keys rejected)
 * - **apply** -- Replace an entire config section atomically (gated as destructive, triggers restart)
 * - **restart** -- Restart the gateway server (gated as destructive)
 * - **schema** -- Get JSON Schema for a section (or full config) for introspection
 * - **status** -- Get current gateway server status (uptime, connections, etc.)
 * - **history** -- View config change history with optional section filter and limit
 * - **diff** -- View unified diff of config changes against a previous version
 * - **rollback** -- Restore config to a previous version (gated as destructive, triggers restart)
 * - **env_set** -- Store a secret/env var (write-only, requires confirmation, triggers restart)
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @returns AgentTool implementing the gateway control interface
 */
const VALID_ACTIONS = ["read", "patch", "apply", "restart", "schema", "status", "history", "diff", "rollback", "env_set"] as const;

export function createGatewayTool(rpcCall: RpcCall): AgentTool<typeof GatewayToolParams> {
  const restartGate = createActionGate("gateway.restart");
  const patchGate = createActionGate("config.patch");
  const applyGate = createActionGate("config.apply");
  const rollbackGate = createActionGate("config.rollback");
  const envSetGate = createActionGate("env.set");

  return createMultiActionDispatchTool(
    {
      name: "gateway",
      label: "Gateway Control",
      description:
        "Read/patch config, restart gateway, check status. Destructive actions require confirmation.",
      parameters: GatewayToolParams,
      validActions: VALID_ACTIONS,
      actionHandler: async (action, p, rpcCall) => {
        const ctx = tryGetContext();
        const _trustLevel = ctx?.trustLevel ?? "guest";

        switch (action) {
          case "read": {
            const section = readStringParam(p, "section", false);
            return rpcCall("config.read", { section, _trustLevel });
          }

          case "patch": {
            const section = readStringParam(p, "section")!;
            const key = readStringParam(p, "key")!;
            // Pre-gate immutability check: reject before asking for confirmation
            if (isImmutableConfigPath(section, key)) {
              const mutablePaths = getMutableOverridesForSection(section, key);
              let hint: string;
              if (mutablePaths.length > 0) {
                hint = `Patchable paths under "${section}": ${mutablePaths.join(", ")}`;
              } else if (section === "agents") {
                hint = `Key must start with the agent ID. Use action="read" section="agents" first to see agent IDs, then patch as e.g. key="<agentId>.model"`;
              } else {
                hint = "This section has no runtime-patchable paths.";
              }
              throwToolError(
                "permission_denied",
                `Cannot patch immutable config path: ${section}.${key}.`,
                { hint },
              );
            }
            // Skip confirmation gate for known mutable override paths (no round-trip needed)
            const fullPath = key ? `${section}.${key}` : section;
            const isMutableOverride = MUTABLE_CONFIG_OVERRIDES.some(
              pattern => matchesOverridePattern(fullPath, pattern),
            );
            if (!isMutableOverride) {
              const gate = patchGate(p);
              if (gate.requiresConfirmation) {
                return {
                  requiresConfirmation: true,
                  actionType: gate.actionType,
                  hint: "Ask the user to confirm this config patch, then call again with _confirmed: true.",
                };
              }
            }
            const value = p.value;
            return rpcCall("config.patch", { section, key, value, _trustLevel });
          }

          case "restart": {
            const gate = restartGate(p);
            if (gate.requiresConfirmation) {
              return {
                requiresConfirmation: true,
                actionType: gate.actionType,
                hint: "Ask the user to confirm this restart, then call again with _confirmed: true.",
              };
            }
            return rpcCall("gateway.restart", { _trustLevel });
          }

          case "schema": {
            const section = readStringParam(p, "section", false);
            return rpcCall("config.schema", { section, _trustLevel });
          }

          case "status": {
            return rpcCall("gateway.status", { _trustLevel });
          }

          case "history": {
            const section = readStringParam(p, "section", false);
            const limit = p.limit as number | undefined;
            return rpcCall("config.history", { section, limit, _trustLevel });
          }

          case "diff": {
            const sha = readStringParam(p, "sha", false);
            return rpcCall("config.diff", { sha, _trustLevel });
          }

          case "apply": {
            const section = readStringParam(p, "section");
            // Pre-gate immutability check: reject before asking for confirmation
            if (isImmutableConfigPath(section!)) {
              throwToolError(
                "permission_denied",
                `Cannot apply to immutable config section: ${section}.`,
                { hint: "Security-sensitive sections cannot be replaced at runtime." },
              );
            }
            const gate = applyGate(p);
            if (gate.requiresConfirmation) {
              return {
                requiresConfirmation: true,
                actionType: gate.actionType,
                hint: "Ask the user to confirm this config apply, then call again with _confirmed: true.",
              };
            }
            const value = p.value;
            return rpcCall("config.apply", { section, value, _trustLevel });
          }

          case "rollback": {
            const gate = rollbackGate(p);
            if (gate.requiresConfirmation) {
              return {
                requiresConfirmation: true,
                actionType: gate.actionType,
                hint: "Ask the user to confirm this rollback, then call again with _confirmed: true.",
              };
            }
            const sha = readStringParam(p, "sha");
            return rpcCall("config.rollback", { sha, _trustLevel });
          }

          default: {
            // action === "env_set"
            const envKey = readStringParam(p, "env_key")!;
            const envValue = readStringParam(p, "env_value")!;
            const gate = envSetGate(p);
            if (gate.requiresConfirmation) {
              return {
                requiresConfirmation: true,
                actionType: gate.actionType,
                hint: `Confirm setting secret "${envKey}". Call again with _confirmed: true.`,
              };
            }
            const result = await rpcCall("env.set", { key: envKey, value: envValue, _trustLevel });
            // Return result but strip any value that might have leaked through
            return typeof result === "object" && result !== null
              ? { ...(result as Record<string, unknown>), value: undefined }
              : result;
          }
        }
      },
    },
    rpcCall,
  );
}
