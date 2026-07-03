// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Autonomy MODE vocabulary + fail-closed resolution + the
 * per-profile posture notices.
 *
 * Split from `schema-agent-autonomy.ts` (file-size cap discipline): the
 * `mode` axis (the operator-set autonomy mode the agent CANNOT self-raise),
 * the fail-closed `resolveEffectiveMode` primitive, and the two
 * `unattended`/`max` posture-notice strings are a self-contained unit the main
 * autonomy leaf imports. One-directional dependency (mode → consumed by
 * autonomy), no cycle; re-exported by the `schema-agent/index.ts` barrel so
 * consumers reach these via `@comis/core` exactly as before.
 *
 * Imports nothing from sibling leaves — pure data + a pure function (AGENTS §2.2).
 *
 * @module
 */

/** Autonomy modes. `default` is the SAFE mode the fail-closed path collapses to. */
export const AUTONOMY_MODES = ["default", "accept-reversible", "unattended", "max"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/**
 * Fail-closed mode resolution. Given a (possibly absent/forged/unparseable)
 * mode value — e.g. the chokepoint's injected `_autonomyMode`, or a future external
 * policy read — return the SAFE mode. A recognized AutonomyMode passes through; anything
 * else (undefined, non-string, an unknown string) collapses to "default", never to a
 * broader profile. This is the single fail-closed point the "unreachable policy
 * source -> default" contract is tested against. PURE (no env/clock/fs).
 */
export function resolveEffectiveMode(raw: unknown): AutonomyMode {
  return typeof raw === "string" && (AUTONOMY_MODES as readonly string[]).includes(raw)
    ? (raw as AutonomyMode)
    : "default";
}

/**
 * The `unattended` posture notice. The never-hang behaviors the `unattended`
 * MODE selects — a would-ask resolves to deny+escalate (never a blocking
 * prompt), the consecutive-denial circuit breaker, and operator
 * evict-from-mode — are ACTIVE. The capability SET stays standard-equivalent
 * (the always-on structural floor still bounds every cap — no over-grant), and
 * outward actions remain escalate-not-ask (propose), never auto-send.
 * Content-free.
 */
export const UNATTENDED_NOTICE =
  "Unattended mode: never-hang behaviors are active (a would-ask becomes deny+escalate, the denial breaker aborts a retry-loop, and an operator can evict to default). The capability set stays standard-equivalent (the structural floor bounds every cap; outward actions escalate, never auto-send).";

/**
 * The clamp notice for `max`. `max` resolves to the `standard`-equivalent cap
 * set today; its extra surface (max-mode sandbox auto-allow) is not yet
 * available. The notice discloses the clamp so there is no silent over-grant
 * and no pretense of a larger surface.
 */
export const MAX_M1_CLAMP_NOTICE =
  "Resolved to standard-equivalent: the max-mode surface (sandbox auto-allow) is not yet available.";
