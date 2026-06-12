// SPDX-License-Identifier: Apache-2.0
/**
 * Channel health check for comis doctor.
 *
 * Verifies that every ENABLED channel's credential references resolved.
 * Channel credentials live in the config as `${VAR}` references (e.g.
 * `channels.telegram.botToken: ${TELEGRAM_BOT_TOKEN}`), and the shared
 * doctor resolution substitutes them the way daemon boot does: process env
 * -> `~/.comis/.env` -> the encrypted secret store. A reference nothing
 * resolved is exactly what breaks the adapter at runtime, so that — not a
 * bare env-var probe — is what this check reports. (The env-only probe used
 * to claim "Missing telegram credentials" on a live deployment whose token
 * sits in the encrypted store; 2026-06-12 C1 live finding.)
 *
 * Does NOT perform live API validation — resolution presence only.
 *
 * @module
 */

import type { DoctorCheck, DoctorFinding } from "../types.js";
import { describeConfigUnavailable, resolveDoctorConfig } from "../config-resolve.js";

const CATEGORY = "channels";

/** Extract the channel type from an unresolved-ref path like `channels.telegram.botToken`. */
const CHANNEL_REF_PATH = /^channels\.([A-Za-z0-9_]+)[.[]/;

/**
 * Keys inside the `channels` config section that are settings blocks, not
 * channel adapters (the section's schema is closed, so this set is too).
 */
const NON_CHANNEL_KEYS = new Set(["healthCheck"]);

/**
 * Doctor check: channel credential health.
 *
 * For each enabled channel, reports whether all of its `${VAR}` credential
 * references resolved (env, ~/.comis/.env, or the encrypted secret store).
 * Inline literal credentials count as resolved — the secrets-audit check
 * flags plaintext secrets separately.
 */
export const channelHealthCheck: DoctorCheck = {
  id: "channel-health",
  name: "Channels",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    if (!context.config?.channels) {
      // A valid config always carries a channels section (schema defaults),
      // so reaching here means the config itself did not resolve — say WHY
      // instead of claiming nothing is configured.
      const why = describeConfigUnavailable(context.configResolution);
      findings.push({
        category: CATEGORY,
        check: "Channel config",
        status: "skip",
        message: why !== undefined
          ? `Channel credentials not checked — ${why}`
          : "No channels configured",
        repairable: false,
      });
      return findings;
    }

    const resolution =
      context.configResolution ?? resolveDoctorConfig(context.configPaths);

    // Group unresolved references by the channel they belong to.
    const unresolvedByChannel = new Map<string, string[]>();
    for (const ref of resolution.unresolvedRefs ?? []) {
      const match = CHANNEL_REF_PATH.exec(ref.path);
      if (match?.[1] !== undefined) {
        const list = unresolvedByChannel.get(match[1]) ?? [];
        list.push(`\${${ref.varName}} at ${ref.path}`);
        unresolvedByChannel.set(match[1], list);
      }
    }

    let hasEnabledChannel = false;

    for (const [channelType, rawChannelConfig] of Object.entries(context.config.channels)) {
      if (NON_CHANNEL_KEYS.has(channelType)) {
        continue;
      }
      const channelConfig = rawChannelConfig as { enabled?: boolean } | undefined;
      if (!channelConfig || channelConfig.enabled !== true) {
        continue;
      }

      hasEnabledChannel = true;
      const unresolved = unresolvedByChannel.get(channelType);

      if (unresolved !== undefined && unresolved.length > 0) {
        findings.push({
          category: CATEGORY,
          check: `${channelType} credentials`,
          status: "fail",
          message:
            `Unresolved ${channelType} credential reference(s): ${unresolved.join(", ")}` +
            " — not in env, ~/.comis/.env, or the encrypted secret store",
          suggestion:
            "Set the variable in the environment or store it via comis secrets set",
          repairable: false,
        });
      } else {
        findings.push({
          category: CATEGORY,
          check: `${channelType} credentials`,
          status: "pass",
          message: `${channelType} credentials resolved`,
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
