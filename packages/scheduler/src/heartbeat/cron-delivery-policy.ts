// SPDX-License-Identifier: Apache-2.0
/**
 * Cron delivery policy: configurable suppression of HEARTBEAT_OK-only
 * responses from cron-triggered heartbeats.
 *
 * When enabled (default), cron jobs that trigger a heartbeat resulting in
 * HEARTBEAT_OK are silently suppressed. Users don't receive "your scheduled
 * reminder ran but there's nothing to say" messages.
 *
 * When disabled, HEARTBEAT_OK responses from cron triggers are still
 * delivered as acknowledgment messages.
 *
 * Only applies to cron-triggered heartbeats. Interval triggers use the
 * existing processHeartbeatResponse suppression logic.
 *
 * @module
 */

import type { HeartbeatResponseOutcome } from "./response-processor.js";
import type { HeartbeatTriggerKind } from "./file-gate.js";

/**
 * Determine whether a cron-triggered HEARTBEAT_OK response should be
 * suppressed from delivery.
 *
 * @param outcome    - The classified heartbeat response outcome
 * @param trigger    - The trigger kind that initiated the heartbeat
 * @param policyEnabled - Whether the skip policy is active
 * @returns true if delivery should be skipped
 */
export function shouldSkipHeartbeatOnlyDelivery(
  outcome: HeartbeatResponseOutcome,
  trigger: HeartbeatTriggerKind,
  policyEnabled: boolean,
): boolean {
  if (!policyEnabled) return false;
  if (trigger !== "cron") return false;
  return outcome.kind === "heartbeat_ok";
}
