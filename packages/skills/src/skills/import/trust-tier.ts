// SPDX-License-Identifier: Apache-2.0
/**
 * Skill trust-tier derivation.
 *
 * Trust is a property of the CALL — which source produced the bundle and which
 * identity asked for it — never of the bundle's content. A skill cannot declare
 * itself trusted, because nothing in this module reads the manifest.
 *
 * The tier axis is deliberately SEPARATE from `SkillSource`
 * (`../registry/discovery.ts`), which is derived from discovery-path index and
 * already reports `"bundled"` for the per-agent workspace skills dir — the very
 * directory a `scope: "local"` import writes into. Overloading that label with
 * trust would make "imported is never bundled" unsatisfiable.
 *
 * Pure + total: no fs, no net, no clock.
 *
 * @module
 */

/**
 * How much authority a skill's origin confers.
 *
 * - `first-party` — seeded by the daemon's own bundled-skill installer. The
 *   only tier no import path can reach.
 * - `operator` — written by the operator (the default agent) through
 *   create/update/upload, or a remote registry the operator explicitly promoted.
 * - `community` — any remote origin. The default and the ceiling for imports.
 * - `agent-authored` — written at runtime by a non-default agent.
 */
export type SkillTrustTier = "first-party" | "operator" | "community" | "agent-authored";

/** Where a bundle came from. Mirrors the `source` field on the provenance record. */
export type SkillInstallSource =
  | "seed"
  | "backfill"
  | "create"
  | "update"
  | "upload"
  | "github"
  | "archive"
  | "wellknown"
  | "registry";

/** Inputs to {@link deriveSkillTrustTier}. All properties describe the call, not the bundle. */
export interface DeriveSkillTrustTierInput {
  /** Which install path is running. */
  readonly source: SkillInstallSource;
  /** The identity performing the install. */
  readonly callingAgentId: string;
  /**
   * The daemon's default agent, or `undefined` when it cannot be resolved.
   * An unresolved default is treated as "not the caller" — the weaker tier is
   * the safe reading, so a misconfigured daemon cannot accidentally grant
   * `operator`.
   */
  readonly defaultAgentId: string | undefined;
  /**
   * An operator's explicit per-registry trust promotion, from
   * `skills.import.registries[].trust`. Honored for configured registry and
   * well-known sources only; it must not leak onto an arbitrary archive URL.
   */
  readonly registryTrust?: "community" | "operator";
}

/** Install paths where the bundle originated outside this daemon. */
const REMOTE_SOURCES: ReadonlySet<SkillInstallSource> = new Set([
  "github",
  "archive",
  "wellknown",
  "registry",
]);

/**
 * Derive the trust tier for an install.
 *
 * @param input See {@link DeriveSkillTrustTierInput}.
 * @returns The tier. `first-party` is reachable only from `source: "seed"`.
 */
export function deriveSkillTrustTier(input: DeriveSkillTrustTierInput): SkillTrustTier {
  if (input.source === "seed") return "first-party";
  if (input.source === "backfill") return "operator";

  if (REMOTE_SOURCES.has(input.source)) {
    // Only an operator-configured registry/index entry can carry a promotion.
    if (
      (input.source === "registry" || input.source === "wellknown") &&
      input.registryTrust === "operator"
    ) {
      return "operator";
    }
    return "community";
  }

  // Local authoring. The identity comparison mirrors the shared-scope authz
  // check in `skills.*` (skill-handlers.ts) rather than introducing a second
  // notion of "who is privileged here".
  const isDefaultAgent =
    input.defaultAgentId !== undefined && input.callingAgentId === input.defaultAgentId;
  return isDefaultAgent ? "operator" : "agent-authored";
}
