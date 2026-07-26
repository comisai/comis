// SPDX-License-Identifier: Apache-2.0
/**
 * The trust × verdict install-policy matrix.
 *
 * Replaces the fixed fail-closed policy the vetting gate shipped with, so the
 * same finding set yields different decisions depending on where the skill came
 * from. An operator's own CRITICAL is a confirmable mistake — they wrote it, and
 * they can read the findings and decide. A stranger's CRITICAL is not.
 *
 * |                | safe  | caution | dangerous |
 * |----------------|-------|---------|-----------|
 * | first-party    | allow | allow   | allow     |
 * | operator       | allow | allow   | confirm   |
 * | community      | allow | confirm | **block** |
 * | agent-authored | allow | confirm | **block** |
 *
 * Two properties are load-bearing and asserted by the tests:
 *   - **Monotonicity.** A worse verdict is never a softer decision at the same
 *     tier, and a lower-trust tier is never a softer decision for the same
 *     verdict. A future edit that breaks either has almost certainly created a
 *     privilege inversion.
 *   - **`force` cannot override a `block`.** It upgrades a `confirm` to an
 *     `allow` and nothing else. `force` means "I read the findings and accept
 *     them", never "skip the scan" — so no flag makes a community CRITICAL
 *     bundle installable.
 *
 * Pure: no fs, no net, no clock, no mutation.
 *
 * @module
 */

import type { SkillTrustTier } from "./trust-tier.js";
import type { SkillBundleDecision, SkillBundleVerdict } from "./bundle-types.js";

/** Inputs to {@link decideSkillInstall}. */
export interface DecideSkillInstallInput {
  /** Derived tier for this install (never declared by the skill). */
  readonly trust: SkillTrustTier;
  /** Content-risk verdict from the vetting gate. */
  readonly verdict: SkillBundleVerdict;
}

/**
 * The matrix itself, as data rather than branches — so it reads the way the
 * docs table does and a change to one cell cannot accidentally alter another.
 */
const POLICY: Readonly<
  Record<SkillTrustTier, Readonly<Record<SkillBundleVerdict, SkillBundleDecision>>>
> = {
  // Seeded by the daemon itself; there is no less-trusted party to protect
  // against, and blocking here would make the daemon unable to install its own
  // bundled skills.
  "first-party": { safe: "allow", caution: "allow", dangerous: "allow" },
  // The operator authored it. A CRITICAL is worth stopping for, but it is their
  // content and their call — so it is confirmable, not fatal.
  operator: { safe: "allow", caution: "allow", dangerous: "confirm" },
  // Remote origin. A WARN deserves a look before it lands, and a CRITICAL is
  // not installable at all.
  community: { safe: "allow", caution: "confirm", dangerous: "block" },
  // Written at runtime by a non-default agent — held to the same bar as a
  // remote import, because the model is not the operator.
  "agent-authored": { safe: "allow", caution: "confirm", dangerous: "block" },
};

/**
 * Decide what to do about a vetted bundle, before any `force` override.
 *
 * @returns `allow` to install, `confirm` to require an explicit re-run, or
 *   `block` to refuse outright.
 */
export function decideSkillInstall(input: DecideSkillInstallInput): SkillBundleDecision {
  return POLICY[input.trust][input.verdict];
}

/**
 * Apply the caller's `force` flag to a decision.
 *
 * `confirm` → `allow`. Everything else is returned unchanged — in particular a
 * `block` stays a `block`, which is the property that keeps a CRITICAL finding
 * on a community skill genuinely un-installable rather than merely inconvenient.
 */
export function applyForceOverride(
  decision: SkillBundleDecision,
  force: boolean,
): SkillBundleDecision {
  return force && decision === "confirm" ? "allow" : decision;
}
