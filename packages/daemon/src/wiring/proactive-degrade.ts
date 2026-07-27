// SPDX-License-Identifier: Apache-2.0
// @allow-throw: boot-path wiring guard — the throw aborts daemon startup for a genuine composition-root regression (same contract as the daemon.ts call site it was extracted from).
/**
 * Honest degradation when proactive schedulers cannot be armed.
 *
 * `constructCapabilityLayer` returns `capEndpointHandle: undefined` when no
 * agent has autonomy enabled or when endpoint activation fails, while
 * `setupProactiveSchedulers` treats that handle as mandatory. Both supported
 * degradation paths keep channels available and report why proactive work is
 * unavailable.
 *
 * Reachability is the severity: an omitted `autonomy` block defaults to ENABLED,
 * but writing any sub-key without `enabled: true` — e.g. the documented
 * `autonomy.durability` — resolves to DISABLED. One documented knob bricked it.
 *
 * @module
 */

import type { CapabilityEndpointUnavailableReason } from "./setup-capability-endpoint-boot.js";

/** The failure shape a failed `setupProactiveSchedulers` returns. */
interface ProactiveSetupError {
  readonly code: string;
  readonly message: string;
}

/**
 * True when the only unmet proactive-scheduler dependency is a capability
 * endpoint omitted because autonomy is disabled.
 *
 * @param error - the failed setup Result's error.
 * @returns whether the daemon may boot without the proactive surface.
 */
export function isAutonomyDisabledProactiveMiss(
  error: ProactiveSetupError,
  capEndpointUnavailableReason?: CapabilityEndpointUnavailableReason,
): boolean {
  return (
    capEndpointUnavailableReason === "autonomy_disabled"
    && error.code === "dependency_unavailable"
    && /capEndpointHandle \(1 of 11/.test(error.message)
  );
}

function isCapabilityActivationProactiveMiss(
  error: ProactiveSetupError,
  capEndpointUnavailableReason?: CapabilityEndpointUnavailableReason,
): boolean {
  return (
    capEndpointUnavailableReason === "activation_failed"
    && error.code === "dependency_unavailable"
    && /capEndpointHandle \(1 of 11/.test(error.message)
  );
}

/**
 * Structured fields for the boot ERROR that says what is off and which knob
 * turns it back on. Never a silent loss.
 *
 * @returns content-free log fields.
 */
export function proactiveNotArmedLogFields(
  reason?: CapabilityEndpointUnavailableReason,
): Record<string, unknown> {
  if (reason === "activation_failed") {
    return {
      submodule: "setup-proactive-schedulers",
      errorKind: "config" as const,
      hint:
        "Cron jobs and the heartbeat are NOT armed for this boot because the capability "
        + "endpoint could not activate. Check that config.dataDir is absolute and writable "
        + "and that its cap.sock path can be created, then restart the daemon.",
    };
  }
  return {
    submodule: "setup-proactive-schedulers",
    errorKind: "config" as const,
    hint:
      "Cron jobs and the heartbeat are NOT armed for this boot. The capability endpoint "
      + "is only built when at least one agent has autonomy enabled, and no agent does. "
      + "Set `agents.<id>.autonomy.enabled: true` to arm them. NOTE: writing any "
      + "`autonomy.*` sub-key (e.g. `autonomy.durability`) WITHOUT `autonomy.enabled: true` "
      + "resolves to DISABLED — an omitted `autonomy` block defaults to enabled, so adding "
      + "a sub-key can silently turn the whole surface off.",
  };
}

/** The boot ERROR message for {@link proactiveNotArmedLogFields}. */
export const PROACTIVE_NOT_ARMED_MSG =
  "Proactive schedulers not armed: autonomy is disabled for every agent";

export function proactiveNotArmedMessage(
  reason?: CapabilityEndpointUnavailableReason,
): string {
  return reason === "activation_failed"
    ? "Proactive schedulers not armed: capability endpoint activation failed"
    : PROACTIVE_NOT_ARMED_MSG;
}

/**
 * Abort boot unless a failed proactive-scheduler setup has a known capability
 * endpoint degradation reason.
 *
 * @param proactive - the `setupProactiveSchedulers` Result.
 * @throws when the failure is a genuine composition-root regression.
 */
export function assertProactiveFailureIsSupported(
  proactive: { ok: true } | { ok: false; error: ProactiveSetupError },
  capEndpointUnavailableReason?: CapabilityEndpointUnavailableReason,
): void {
  if (proactive.ok) return;
  if (
    isAutonomyDisabledProactiveMiss(proactive.error, capEndpointUnavailableReason)
    || isCapabilityActivationProactiveMiss(proactive.error, capEndpointUnavailableReason)
  ) return;
  throw new Error(`Proactive scheduler activation failed: ${proactive.error.message}`);
}

/** Handle placeholders for the degraded (schedulers-not-armed) boot. */
export const EMPTY_PROACTIVE_HANDLES = {
  heartbeatRunner: undefined,
  duplicateDetector: undefined,
  coordinator: undefined,
} as const;
