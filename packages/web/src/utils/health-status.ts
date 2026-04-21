// SPDX-License-Identifier: Apache-2.0
/**
 * Shared health-status utility module.
 *
 * Single source of truth for all health state rendering across the web console.
 * Maps the 8 backend health states to a 4-color severity system with visual
 * properties (color, label, icon, pulse animation).
 *
 * All functions are pure -- no side effects, no DOM dependencies.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All 8 backend channel health states from the health machine. */
export type ChannelHealthState =
  | "healthy"
  | "idle"
  | "stale"
  | "startup-grace"
  | "stuck"
  | "errored"
  | "disconnected"
  | "unknown";

/** 4-color severity grouping for health states. */
export type HealthSeverity = "green" | "yellow" | "red" | "gray";

/** Visual properties for rendering a health state. */
export interface HealthVisual {
  readonly color: string;
  readonly label: string;
  readonly severity: HealthSeverity;
  readonly pulse: boolean;
  readonly icon: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Complete mapping of all 8 health states to their visual representation. */
export const HEALTH_STATUS: Readonly<Record<ChannelHealthState, HealthVisual>> = {
  // Green states -- connected and operational
  healthy: {
    color: "var(--ic-success)",
    label: "Healthy",
    severity: "green",
    pulse: false,
    icon: "check-circle",
  },
  idle: {
    color: "var(--ic-success)",
    label: "Idle",
    severity: "green",
    pulse: false,
    icon: "pause-circle",
  },

  // Yellow states -- transitional or degraded
  stale: {
    color: "var(--ic-warning)",
    label: "Stale",
    severity: "yellow",
    pulse: false,
    icon: "clock",
  },
  "startup-grace": {
    color: "var(--ic-warning)",
    label: "Starting",
    severity: "yellow",
    pulse: true,
    icon: "loader",
  },

  // Red states -- broken or stuck
  stuck: {
    color: "var(--ic-error)",
    label: "Stuck",
    severity: "red",
    pulse: false,
    icon: "alert-triangle",
  },
  errored: {
    color: "var(--ic-error)",
    label: "Error",
    severity: "red",
    pulse: false,
    icon: "x-circle",
  },

  // Gray states -- offline or indeterminate
  disconnected: {
    color: "var(--ic-text-dim)",
    label: "Disconnected",
    severity: "gray",
    pulse: false,
    icon: "wifi-off",
  },
  unknown: {
    color: "var(--ic-text-dim)",
    label: "Unknown",
    severity: "gray",
    pulse: false,
    icon: "help-circle",
  },
};

/** Set of valid health states for O(1) membership checks. */
const VALID_STATES = new Set<string>(Object.keys(HEALTH_STATUS));

/**
 * Legacy/transport status aliases mapped to canonical health states.
 * These handle values that may come from older backends or transport layers.
 */
const LEGACY_ALIASES: Readonly<Record<string, ChannelHealthState>> = {
  connected: "healthy",
  running: "healthy",
  error: "errored",
  stopped: "disconnected",
  reconnecting: "healthy",
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Normalize a raw status string to a canonical ChannelHealthState.
 *
 * Handles:
 * - Valid health states pass through unchanged
 * - Legacy aliases ("connected" -> "healthy", "error" -> "errored", etc.)
 * - Unknown strings map to "unknown"
 */
export function normalizeChannelStatus(raw: string): ChannelHealthState {
  const lower = raw.toLowerCase().trim();
  if (VALID_STATES.has(lower)) return lower as ChannelHealthState;
  return LEGACY_ALIASES[lower] ?? "unknown";
}

/**
 * Get the full visual representation for a raw status string.
 *
 * Convenience function combining normalizeChannelStatus() + HEALTH_STATUS lookup.
 */
export function getHealthVisual(raw: string): HealthVisual {
  return HEALTH_STATUS[normalizeChannelStatus(raw)];
}

/**
 * Whether uptime should be displayed for the given health state.
 *
 * Returns true for "healthy" and "idle" (both green states) -- uptime is
 * meaningful when the channel is connected, even if no recent messages.
 */
export function showUptime(state: ChannelHealthState): boolean {
  return state === "healthy" || state === "idle";
}
