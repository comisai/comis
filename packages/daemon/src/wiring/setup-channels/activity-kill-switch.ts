// SPDX-License-Identifier: Apache-2.0
/**
 * Fail-closed kill-switch slice resolver.
 *
 * The daemon's inbound `coordinatorFactory` (setup-channels-runtime.ts) needs a
 * live kill-switch getter that RE-READS the per-agent activity config fresh on
 * every `flushApply` (so a hot-reload that replaces the per-agent object is
 * observed). The coordinator reads an `undefined` return as "no suppression"
 * (`activity-turn-coordinator.ts`: `if (!ks) return false`). That `undefined`
 * contract exists for the UN-WIRED path (no killSwitch at all) — but a WIRED
 * getter must NEVER return undefined, or an agentId absent from the live
 * `agents` map (a removed agent, or a default-fallback id mismatch) would render
 * activity UNCONDITIONALLY: fail-OPEN, the opposite of the §22.2 Day-0 mandate.
 *
 * This resolver fails CLOSED by construction: a missing agent or missing
 * `activity` slice collapses to "no emergency, no channel enabled" → every
 * renderer is suppressed by the gate (`channels[rendererKey]?.enabled !== true`).
 *
 * @module
 */

/** The non-undefined slice a wired `ActivityKillSwitch` getter must return. */
export interface ActivityKillSwitchSlice {
  emergencyDisabled: boolean;
  channels: Record<string, { enabled: boolean }>;
  /** §22.2 operator opt-in to default-ON. A no-entry renderer is enabled only
   *  when this is true; an absent agent collapses to false (fail-closed). */
  defaultEnabled: boolean;
}

/** The minimal per-agent shape this resolver reads (a structural supertype of
 *  the parsed `container.config.agents` value). */
export type AgentActivityConfigMap = Record<
  string,
  {
    activity?: {
      emergencyDisabled?: boolean;
      channels?: Record<string, { enabled: boolean }>;
      defaultChannelEnabled?: boolean;
    };
  }
>;

/**
 * Resolve the fail-closed kill-switch slice for a turn's agentId. Returns a
 * fully-suppressing slice ({@link ActivityKillSwitchSlice} with `channels: {}`
 * and `defaultEnabled: false`) when the agent is absent from the map or carries
 * no `activity` config — never `undefined`. When the agent set
 * `activity.defaultChannelEnabled`, that flows through as `defaultEnabled` so a
 * no-entry renderer follows the operator's default-on opt-in (§22.2).
 */
export function resolveActivityKillSwitchSlice(
  agents: AgentActivityConfigMap,
  agentId: string,
): ActivityKillSwitchSlice {
  const activity = agents[agentId]?.activity;
  return {
    emergencyDisabled: activity?.emergencyDisabled ?? false,
    channels: activity?.channels ?? {},
    defaultEnabled: activity?.defaultChannelEnabled ?? false,
  };
}
