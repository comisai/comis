// SPDX-License-Identifier: Apache-2.0
/**
 * Browser exposure security check.
 *
 * Evaluates browser automation configuration for sandbox bypass
 * and unconfigured browser tool usage that may increase attack surface.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/**
 * Browser exposure check.
 *
 * Inspects browser and agent configurations for:
 * - Browser running without sandbox
 * - Browser tool enabled without explicit configuration
 */
export const browserExposureCheck: SecurityCheck = {
  id: "browser-exposure",
  name: "Browser Exposure",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config?.agents) {
      return findings;
    }

    const browserConfig = context.config.browser;
    let anyAgentHasBrowser = false;

    for (const [agentId, agent] of Object.entries(context.config.agents)) {
      const hasBrowserTool = agent.skills?.builtinTools?.browser === true;

      if (!hasBrowserTool) {
        continue;
      }

      anyAgentHasBrowser = true;

      // Check for no-sandbox mode
      if (browserConfig?.noSandbox === true) {
        findings.push({
          category: "browser-exposure",
          severity: "warning",
          message: `Agent "${agentId}": Browser running without sandbox increases attack surface`,
          remediation: "Set browser.noSandbox to false unless absolutely required by the environment",
          code: "SEC-BROWSER-001",
        });
      }
    }

    // Info finding for browser enabled without explicit config review
    if (anyAgentHasBrowser && !browserConfig?.enabled) {
      findings.push({
        category: "browser-exposure",
        severity: "info",
        message: "Browser tool enabled -- ensure appropriate restrictions are configured",
        remediation: "Review browser configuration: viewport limits, timeout, sandbox settings",
        code: "SEC-BROWSER-002",
      });
    }

    return findings;
  },
};
