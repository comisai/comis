// SPDX-License-Identifier: Apache-2.0
/**
 * Channel health check for comis doctor.
 *
 * Verifies that configured channels have their required credential
 * environment variables set. Does NOT perform live API validation --
 * only checks for non-empty credential values.
 *
 * @module
 */

import type { DoctorCheck, DoctorFinding } from "../types.js";
import { CHANNEL_ENV_KEYS } from "../../wizard/flow-types.js";

const CATEGORY = "channels";

/**
 * Map of channel types to their required credential environment variable names.
 *
 * Sourced from the shared CHANNEL_ENV_KEYS constant in flow-types.
 * These are format checks only -- we verify the credential appears to be
 * a non-empty string, not that it's a valid API key.
 */
const CHANNEL_CREDENTIALS: Record<string, string[]> = CHANNEL_ENV_KEYS;

/**
 * Doctor check: channel credential health.
 *
 * For each enabled channel, checks that required credential environment
 * variables are set (non-empty). Does not validate credentials against
 * external APIs.
 */
export const channelHealthCheck: DoctorCheck = {
  id: "channel-health",
  name: "Channels",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    if (!context.config?.channels) {
      findings.push({
        category: CATEGORY,
        check: "Channel config",
        status: "skip",
        message: "No channels configured",
        repairable: false,
      });
      return findings;
    }

    const channels = context.config.channels;
    let hasEnabledChannel = false;

    // Check each known channel type
    for (const [channelType, requiredVars] of Object.entries(CHANNEL_CREDENTIALS)) {
      // Check if this channel type is enabled in config
      const channelConfig = channels[channelType as keyof typeof channels] as
        | { enabled?: boolean }
        | undefined;

      if (!channelConfig || channelConfig.enabled !== true) {
        continue;
      }

      hasEnabledChannel = true;

      // Check each required credential
      const missingVars: string[] = [];
      for (const varName of requiredVars) {
        // Check env var format (non-empty string)
        // eslint-disable-next-line no-restricted-syntax -- CLI doctor check reads env directly
        const value = process.env[varName];
        if (!value || value.trim().length === 0) {
          missingVars.push(varName);
        }
      }

      if (missingVars.length > 0) {
        findings.push({
          category: CATEGORY,
          check: `${channelType} credentials`,
          status: "fail",
          message: `Missing ${channelType} credentials: ${missingVars.join(", ")}`,
          suggestion: `Set ${channelType} credentials in .env or config`,
          repairable: false,
        });
      } else {
        findings.push({
          category: CATEGORY,
          check: `${channelType} credentials`,
          status: "pass",
          message: `${channelType} credentials configured`,
          repairable: false,
        });
      }
    }

    if (!hasEnabledChannel) {
      findings.push({
        category: CATEGORY,
        check: "Channel config",
        status: "skip",
        message: "No channels enabled",
        repairable: false,
      });
    }

    return findings;
  },
};
