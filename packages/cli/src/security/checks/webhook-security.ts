// SPDX-License-Identifier: Apache-2.0
/**
 * Webhook security check.
 *
 * Verifies that webhook endpoints are configured with authentication
 * tokens and HMAC verification to prevent unauthorized access.
 *
 * The webhooks config is not yet part of AppConfig (accessed via
 * type assertion from the config record), so this check gracefully
 * handles its absence.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/** Shape of webhooks config for type-safe access. */
interface WebhooksLike {
  enabled?: boolean;
  token?: string;
  mappings?: Array<Record<string, unknown>>;
}

/**
 * Webhook security check.
 *
 * Evaluates webhook configuration for:
 * - Webhooks enabled without authentication token
 * - Webhook endpoints configured without HMAC verification
 */
export const webhookSecurityCheck: SecurityCheck = {
  id: "webhook-security",
  name: "Webhook Security",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config) {
      return findings;
    }

    // Webhooks is not in typed AppConfig yet -- access via record cast
    const configRecord = context.config as unknown as Record<string, unknown>;
    const webhooks = configRecord.webhooks as WebhooksLike | undefined;

    if (!webhooks || webhooks.enabled !== true) {
      return findings;
    }

    // Check for missing authentication token
    if (!webhooks.token) {
      findings.push({
        category: "webhook-security",
        severity: "critical",
        message: "Webhooks enabled without authentication token",
        remediation: "Configure webhooks.token with a strong bearer token for webhook authentication",
        code: "SEC-WEBHOOK-001",
      });
    }

    // Check for endpoints without HMAC
    if (webhooks.mappings && webhooks.mappings.length > 0) {
      // If token exists but no HMAC signing is configured per-mapping, warn
      const hasAnyHmac = webhooks.mappings.some(
        (m) => typeof m.hmacSecret === "string" && m.hmacSecret.length > 0,
      );
      if (!hasAnyHmac) {
        findings.push({
          category: "webhook-security",
          severity: "warning",
          message: "Webhook endpoints configured without HMAC signature verification",
          remediation:
            "Add HMAC secret configuration to webhook mappings for payload integrity verification",
          code: "SEC-WEBHOOK-002",
        });
      }
    }

    return findings;
  },
};
