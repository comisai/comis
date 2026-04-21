// SPDX-License-Identifier: Apache-2.0
/**
 * Channel security check.
 *
 * Validates that enabled channel adapters have required credentials
 * and appropriate access restrictions configured.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/** Credential fields that constitute required auth for a channel adapter. */
const CHANNEL_CREDENTIAL_FIELDS = ["apiKey", "botToken"] as const;

/**
 * Channel security check.
 *
 * For each enabled channel adapter, verifies that required credentials
 * are present and that sender restrictions (allowFrom) are configured.
 */
export const channelSecurityCheck: SecurityCheck = {
  id: "channel-security",
  name: "Channel Security",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config?.channels) {
      return findings;
    }

    const channels = context.config.channels;

    for (const [name, rawEntry] of Object.entries(channels)) {
      // Skip non-adapter entries (e.g. healthCheck config)
      if (name === "healthCheck") continue;
      const entry = rawEntry as Record<string, unknown>;
      // Skip disabled channels
      if (!entry.enabled) continue;

      // Check for at least one credential
      const hasCredential = CHANNEL_CREDENTIAL_FIELDS.some((field) => {
        const value = entry[field];
        return typeof value === "string" && value.length > 0;
      });

      if (!hasCredential) {
        findings.push({
          category: "channel-security",
          severity: "critical",
          message: `Channel "${name}" is enabled but has no credentials (apiKey or botToken)`,
          remediation: `Set apiKey or botToken for the ${name} channel adapter`,
          code: "SEC-CHAN-001",
        });
      }

      // Check for sender restrictions
      const allowFrom = entry.allowFrom as string[] | undefined;
      if (!allowFrom || allowFrom.length === 0) {
        findings.push({
          category: "channel-security",
          severity: "warning",
          message: `Channel "${name}" has no sender restrictions (allowFrom is empty)`,
          remediation: `Add allowed sender IDs to channels.${name}.allowFrom`,
          code: "SEC-CHAN-002",
        });
      }
    }

    return findings;
  },
};
