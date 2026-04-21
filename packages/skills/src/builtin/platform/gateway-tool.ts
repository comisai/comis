// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway control tool: multi-action tool for infrastructure management.
 *
 * Supports 11 actions: read, patch, apply, restart, schema, status, history, diff, rollback, env_set, env_list.
 * Destructive actions (restart, rollback, apply, env_set) and mutation action (patch) require
 * confirmation via action gates. Read-only actions (read, schema, status, history, diff, env_list)
 * are unconfirmed. All actions delegate to the daemon backend via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { tryGetContext, isImmutableConfigPath, MUTABLE_CONFIG_OVERRIDES, matchesOverridePattern, getMutableOverridesForSection } from "@comis/core";
import {
  readStringParam,
  throwToolError,
  createActionGate,
} from "./tool-helpers.js";
import { createMultiActionDispatchTool } from "./messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Canonical action list -- single source of truth
// ---------------------------------------------------------------------------

/**
 * Canonical list of gateway tool actions. Single source of truth --
 * the Typebox `action` Union below and the bridge's pre-flight
 * validator in `packages/skills/src/bridge/tool-metadata-registry.ts`
 * both derive from this tuple. Adding a new action here automatically
 * updates both the schema and the bridge whitelist, eliminating the
 * dual-source-of-truth drift that caused the `env_list`-rejected bug.
 */
export const GATEWAY_ACTIONS = [
  "read",
  "patch",
  "apply",
  "restart",
  "schema",
  "status",
  "history",
  "diff",
  "rollback",
  "env_set",
  "env_list",
] as const;

export type GatewayAction = typeof GATEWAY_ACTIONS[number];

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const GatewayToolParams = Type.Object({
  action: Type.Union(
    GATEWAY_ACTIONS.map((a) => Type.Literal(a)),
    { description: "Gateway control action. Valid values: read (view config section), patch (update single config key), apply (replace entire section), restart (restart gateway), schema (get JSON schema), status (server uptime/connections), history (config change log), diff (compare config versions), rollback (restore previous config), env_set (store secret), env_list (list configured secret names -- read-only, never returns values)" },
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
      description:
        "Maximum results. For history: default 10. For env_list: default 100, max 500 (clamped).",
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
  filter: Type.Optional(
    Type.String({
      description:
        "Glob filter for env_list (e.g., 'GEMINI*', '*_API_KEY'). Case-insensitive, " +
        "supports '*' wildcard. Matches only secret NAMES -- values are never returned.",
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a gateway control tool with 11 actions.
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
 * - **env_list** -- List configured secret NAMES (admin-only, read-only). Use before asking the user for a key to check whether it is already configured. Values are never returned.
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @returns AgentTool implementing the gateway control interface
 */
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
      validActions: GATEWAY_ACTIONS,
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

          case "env_list": {
            // Read-only: no confirmation gate. Names only; values are never returned.
            const filter = readStringParam(p, "filter", false);
            const limit = typeof p.limit === "number" ? p.limit : undefined;
            return rpcCall("env.list", { filter, limit, _trustLevel });
          }

          default: {
            // action === "env_set"
            const envKey = readStringParam(p, "env_key")!;
            const envValue = readStringParam(p, "env_value")!;

            // Reject session-redaction placeholders. This catches the replay
            // poisoning loop where a prior env_set tool call's arguments were
            // rewritten to "[REDACTED]" on disk by sanitizeSessionSecrets,
            // then replayed back into the model's context, causing it to
            // emit "[REDACTED]" as the value on the next env_set.
            // scrubRedactedToolCalls handles this upstream; this is the
            // last line of defense at the tool boundary.
            if (envValue === "[REDACTED]" || /^\[REDACTED[^\]]*\]$/.test(envValue)) {
              return {
                error: "env_value_is_placeholder",
                hint:
                  `env_value "${envValue}" is a session-redaction placeholder, ` +
                  `not a real secret. Re-read the user's most recent message ` +
                  `and call env_set again with the literal value they provided.`,
              };
            }

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
