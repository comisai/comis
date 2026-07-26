// SPDX-License-Identifier: Apache-2.0
// @allow-throw: boot-path wiring guard — the throw aborts daemon startup for a genuine composition-root regression (same contract as the daemon.ts call site it was extracted from).
/**
 * Honest degradation when proactive schedulers cannot be armed.
 *
 * `constructCapabilityLayer` returns `capEndpointHandle: undefined` BY DESIGN
 * when no agent has autonomy enabled, and `setupProactiveSchedulers` treats that
 * handle as mandatory. The daemon used to throw on the failed Result — so a fully
 * supported config completed its entire boot (channels registered, adapter
 * polling) and then exited 1, forever. `systemctl is-active` read `active`
 * throughout while the box served nothing.
 *
 * Reachability is the severity: an omitted `autonomy` block defaults to ENABLED,
 * but writing any sub-key without `enabled: true` — e.g. the documented
 * `autonomy.durability` — resolves to DISABLED. One documented knob bricked it.
 *
 * @module
 */

/** The failure shape a failed `setupProactiveSchedulers` returns. */
interface ProactiveSetupError {
  readonly code: string;
  readonly message: string;
}

/**
 * True when the ONLY unmet proactive-scheduler dependency is the capability
 * endpoint — i.e. the supported autonomy-disabled configuration, not a
 * composition-root regression.
 *
 * @param error - the failed setup Result's error.
 * @returns whether the daemon may boot without the proactive surface.
 */
export function isAutonomyDisabledProactiveMiss(error: ProactiveSetupError): boolean {
  return (
    error.code === "dependency_unavailable"
    && /capEndpointHandle \(1 of 11/.test(error.message)
  );
}

/**
 * Structured fields for the boot ERROR that says what is off and which knob
 * turns it back on. Never a silent loss.
 *
 * @returns content-free log fields.
 */
export function proactiveNotArmedLogFields(): Record<string, unknown> {
  return {
    module: "daemon",
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

/**
 * Abort boot unless a failed proactive-scheduler setup is the SUPPORTED
 * autonomy-disabled case.
 *
 * @param proactive - the `setupProactiveSchedulers` Result.
 * @throws when the failure is a genuine composition-root regression.
 */
export function assertProactiveFailureIsSupported(
  proactive: { ok: true } | { ok: false; error: ProactiveSetupError },
): void {
  if (proactive.ok) return;
  if (isAutonomyDisabledProactiveMiss(proactive.error)) return;
  throw new Error(`Proactive scheduler activation failed: ${proactive.error.message}`);
}

/** Handle placeholders for the degraded (schedulers-not-armed) boot. */
export const EMPTY_PROACTIVE_HANDLES = {
  heartbeatRunner: undefined,
  duplicateDetector: undefined,
  coordinator: undefined,
} as const;
