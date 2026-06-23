// SPDX-License-Identifier: Apache-2.0
/**
 * Outward quota (QUOTA-01/02): the irreversible-action gate for agent-initiated
 * outward sends. An outward message is the visible/irreversible action an injected
 * agent could abuse (mass-DMing strangers, posting to a new public channel), so a
 * send is gated three ways:
 *
 *   1. channel allowance (QUOTA-01) — the origin channel is always allowed; a NEW
 *      target needs an explicit `perTargetGrants[]` entry, else deny `no_grant`.
 *   2. volume gate (QUOTA-02) — a high-volume / mass-recipient send over `volumeCap`
 *      is denied even to origin, even when "reversible": a mass-DM blast stays gated.
 *   3. per-hour quota — a rolling-hour window keyed on `${agentId}:${channelId}`
 *      (the `notification/rate-limiter.ts` rolling-hour limb), deny `per_hour` over cap.
 *
 * `orch:browse` needs NO code here — it is the always-escalate capability with no
 * mapped tool in M1; it is simply not granted.
 *
 * Time is INJECTED via ClockPort — there is deliberately no wall-clock-global
 * fallback (the `notification/rate-limiter.ts:19` `?? <wall-clock-global>` hazard the
 * globals.test.ts arch-gate rejects). Returns Result<void, QuotaError>, never throws
 * (raw-throw.test.ts); the message-handler chokepoint (Plan 07) maps the err to a deny.
 *
 * @module
 */

import type { ClockPort, ComisLogger } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";

export type QuotaError = { reason: "per_hour" | "no_grant" | "volume" };

export interface OutwardQuota {
  /**
   * Gate one outward send.
   * @param agentId    the sending agent (quota key half)
   * @param channelId  the target channel (quota key half)
   * @param isOrigin   true when `channelId` is the agent's origin channel
   * @param volume     recipient count / size proxy for the volume gate
   */
  tryOutward(
    agentId: string,
    channelId: string,
    isOrigin: boolean,
    volume: number,
  ): Result<void, QuotaError>;
}

export interface OutwardQuotaConfig {
  /** Whether sends default to the origin channel only (QUOTA-01). */
  readonly originOnly: boolean;
  /** Explicit per-target grants — channels a new (non-origin) send may reach. */
  readonly perTargetGrants: readonly string[];
  /** Max recipient count / size for a single send (QUOTA-02). */
  readonly volumeCap: number;
  /** Max sends per `${agentId}:${channelId}` per rolling hour. */
  readonly maxPerHour: number;
}

export interface OutwardQuotaDeps {
  /** Wall-clock reads for the rolling-hour window. */
  readonly clock: ClockPort;
  readonly config: OutwardQuotaConfig;
  readonly logger: ComisLogger;
}

const HOUR_MS = 3_600_000;

interface HourCounter {
  count: number;
  windowStartMs: number;
}

export function createOutwardQuota(deps: OutwardQuotaDeps): OutwardQuota {
  const { config, logger } = deps;
  // Rolling-hour counters keyed on `${agentId}:${channelId}`.
  const counters = new Map<string, HourCounter>();

  return {
    tryOutward(
      agentId: string,
      channelId: string,
      isOrigin: boolean,
      volume: number,
    ): Result<void, QuotaError> {
      // 1. Channel allowance (QUOTA-01): origin always allowed; a new target needs
      //    an explicit grant. `originOnly` is the default posture; a grant is the
      //    only escape for a non-origin channel.
      if (!isOrigin && !config.perTargetGrants.includes(channelId)) {
        logger.warn(
          {
            agentId,
            channelId,
            errorKind: "precondition" as const,
            hint: "Add the channel to autonomy.outward.perTargetGrants to allow sends to a non-origin target.",
          },
          "Outward send denied: no per-target grant for a non-origin channel",
        );
        return err({ reason: "no_grant" });
      }

      // 2. Volume gate (QUOTA-02): a high-volume / mass-recipient send is gated even
      //    to the origin channel — a reversible mass-DM blast is still bounded.
      if (volume > config.volumeCap) {
        logger.warn(
          {
            agentId,
            channelId,
            volume,
            volumeCap: config.volumeCap,
            errorKind: "precondition" as const,
            hint: "Reduce the recipient count / size, or raise autonomy.outward.volumeCap.",
          },
          "Outward send denied: volume over the per-send cap",
        );
        return err({ reason: "volume" });
      }

      // 3. Per-hour quota: rolling-hour window keyed on `${agentId}:${channelId}`.
      const now = deps.clock.now();
      const key = `${agentId}:${channelId}`;
      const entry = counters.get(key);
      if (!entry || now - entry.windowStartMs >= HOUR_MS) {
        counters.set(key, { count: 1, windowStartMs: now });
        return ok(undefined);
      }
      if (entry.count >= config.maxPerHour) {
        logger.warn(
          {
            agentId,
            channelId,
            maxPerHour: config.maxPerHour,
            errorKind: "precondition" as const,
            hint: "Wait for the rolling-hour window to reset, or raise autonomy.message.maxPerHour.",
          },
          "Outward send denied: per-hour quota exhausted",
        );
        return err({ reason: "per_hour" });
      }
      entry.count++;
      return ok(undefined);
    },
  };
}
