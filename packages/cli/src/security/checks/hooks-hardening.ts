/**
 * Hooks hardening security check.
 *
 * Inspects plugin configuration for hooks that can modify agent
 * behavior and verifies audit logging is enabled when hooks are active.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/** Hook names that can modify agent behavior (system prompts, messages). */
const BEHAVIOR_MODIFYING_HOOKS = ["before_agent_start", "before_send"];

/**
 * Hooks hardening check.
 *
 * Evaluates plugin hook registrations for:
 * - Plugins with behavior-modifying hooks
 * - Hooks active without audit logging enabled
 */
export const hooksHardeningCheck: SecurityCheck = {
  id: "hooks-hardening",
  name: "Hooks Hardening",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config?.plugins) {
      return findings;
    }

    const pluginsConfig = context.config.plugins;
    const plugins = pluginsConfig.plugins;

    if (!plugins || Object.keys(plugins).length === 0) {
      return findings;
    }

    let hasActiveHooks = false;

    for (const [pluginId, plugin] of Object.entries(plugins)) {
      if (!plugin.enabled) {
        continue;
      }

      // Check plugin config for hook registrations
      const pluginConfig = plugin.config as Record<string, unknown>;
      const hooks = pluginConfig?.hooks;

      if (!hooks || typeof hooks !== "object") {
        continue;
      }

      const hookNames = Object.keys(hooks as Record<string, unknown>);

      if (hookNames.length === 0) {
        continue;
      }

      hasActiveHooks = true;

      // Check for behavior-modifying hooks
      const behaviorHooks = hookNames.filter((h) => BEHAVIOR_MODIFYING_HOOKS.includes(h));
      if (behaviorHooks.length > 0) {
        findings.push({
          category: "hooks-hardening",
          severity: "warning",
          message: `Plugin "${pluginId}" can modify agent behavior via hooks: ${behaviorHooks.join(", ")}`,
          remediation:
            "Review plugin hook implementations; ensure audit logging captures all modifications",
          code: "SEC-HOOK-001",
        });
      }
    }

    // Check for hooks active without audit logging
    if (hasActiveHooks && context.config.security?.auditLog === false) {
      findings.push({
        category: "hooks-hardening",
        severity: "critical",
        message: "Hooks active without audit logging -- modifications are untracked",
        remediation: "Enable security.auditLog to track hook-initiated modifications",
        code: "SEC-HOOK-002",
      });
    }

    return findings;
  },
};
