/**
 * SSRF (Server-Side Request Forgery) surface security check.
 *
 * Evaluates agent web tool configuration against Node.js permission
 * model settings to detect unprotected outbound network access.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/**
 * SSRF surface check.
 *
 * Inspects agent configurations for:
 * - Web tools enabled without Node.js permission model
 * - Permission model active but no network host restrictions
 */
export const ssrfSurfaceCheck: SecurityCheck = {
  id: "ssrf-surface",
  name: "SSRF Surface",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config?.agents) {
      return findings;
    }

    const security = context.config.security;
    const permissionEnabled = security?.permission?.enableNodePermissions === true;

    let hasWebTools = false;

    for (const [agentId, agent] of Object.entries(context.config.agents)) {
      const builtinTools = agent.skills?.builtinTools;
      if (!builtinTools) {
        continue;
      }

      const hasWebFetch = builtinTools.webFetch === true;
      const hasWebSearch = builtinTools.webSearch === true;

      if (hasWebFetch || hasWebSearch) {
        hasWebTools = true;

        if (!permissionEnabled) {
          const tools = [hasWebFetch && "webFetch", hasWebSearch && "webSearch"]
            .filter(Boolean)
            .join(", ");
          findings.push({
            category: "ssrf-surface",
            severity: "warning",
            message: `Agent "${agentId}": Web tools (${tools}) enabled without Node.js permission model`,
            remediation:
              "Enable security.permission.enableNodePermissions and configure allowedNetHosts",
            code: "SEC-SSRF-001",
          });
        }
      }
    }

    // Check for permission model active but no host restrictions
    if (hasWebTools && permissionEnabled) {
      const allowedHosts = security?.permission?.allowedNetHosts ?? [];
      if (allowedHosts.length === 0) {
        findings.push({
          category: "ssrf-surface",
          severity: "warning",
          message: "Node permissions active but no network host restrictions configured",
          remediation:
            "Add specific hosts to security.permission.allowedNetHosts to restrict outbound access",
          code: "SEC-SSRF-002",
        });
      }
    }

    return findings;
  },
};
