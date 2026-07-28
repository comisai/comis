// SPDX-License-Identifier: Apache-2.0
/**
 * Local checks for runtime posture that otherwise appears only at daemon boot.
 */

import { resolveAutonomy } from "@comis/core";
import type { DoctorCheck, DoctorFinding } from "../types.js";

const CATEGORY = "runtime-posture";

export const runtimePostureHealthCheck: DoctorCheck = {
  id: "runtime-posture-health",
  name: "Runtime posture",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    if (context.secretPresent?.("CANARY_SECRET") === false) {
      findings.push({
        category: CATEGORY,
        check: "Canary secret",
        status: "warn",
        message:
          "CANARY_SECRET is not configured; canary tokens use a deterministic fallback",
        suggestion:
          `Set CANARY_SECRET in the selected secret store or ${context.dataDir}/.env, then restart the daemon`,
        repairable: false,
      });
    }

    const autonomyAgentIds = Object.entries(context.config?.agents ?? {})
      .filter(([, agent]) => resolveAutonomy(agent.autonomy).enabled)
      .map(([agentId]) => agentId);
    if ((context.platform ?? process.platform) !== "linux" && autonomyAgentIds.length > 0) {
      findings.push({
        category: CATEGORY,
        check: "Autonomy isolation",
        status: "warn",
        message:
          `Autonomy is configured for ${autonomyAgentIds.join(", ")}, but the namespace jail requires Linux; the daemon downshifts these agents to the assistant profile`,
        suggestion:
          "Run autonomy-bearing agents on a Linux host where the namespace preflight succeeds, or set agents.<id>.autonomy.profile: assistant on this host",
        repairable: false,
      });
    }

    if (findings.length === 0) {
      findings.push({
        category: CATEGORY,
        check: "Runtime posture",
        status: "pass",
        message: "Runtime posture prerequisites are satisfied",
        repairable: false,
      });
    }
    return findings;
  },
};
