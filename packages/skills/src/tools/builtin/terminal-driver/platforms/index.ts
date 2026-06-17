// SPDX-License-Identifier: Apache-2.0
// @allow-throw: fail-closed load-time validation — `assertUniqueAllowIds` + `assertSafeProfilePatterns`
// throw ONCE at module import over the static, developer-authored profile set. A throw means a
// developer shipped a malformed profile (an allowId collision or a ReDoS-prone hot-path pattern) —
// caught at load / by the registry test, NEVER a runtime user path and never a silent mis-selection.
/**
 * The platform-profile REGISTRY (design §4/§7) — `getPlatformProfile(allowId)`.
 *
 * Selection is by the operator-declared `allowId` (exact-string match, unique). `undefined` ⇒ the
 * agnostic default (§3). The driven program cannot pick its own profile (no content-sniffing —
 * §5/INV-3): only an allowId the operator declared in the allowlist resolves a profile.
 *
 * Two load-time guards run ONCE at module import over `ALL_PROFILES`, so a malformed profile set
 * FAILS AT LOAD (never a silent mis-selection):
 *   - `assertUniqueAllowIds` — no allowId maps to >1 profile (D3).
 *   - `assertSafeProfilePatterns` — every perception/dialog regex is free of nested unbounded
 *     quantifiers (the ReDoS shapes); patterns run on every read/settle frame (hot path — D1).
 *
 * @module
 */

import { claudeCodeProfile } from "./claude-code/profile.js";
import { codexProfile } from "./codex/profile.js";
import type { TerminalPlatformProfile } from "./terminal-platform-profile.js";

export type {
  TerminalPlatformProfile,
  PlatformPerception,
  PlatformDialog,
  KeySpec,
} from "./terminal-platform-profile.js";

/**
 * Throw when two profiles claim the same `allowId` — the D3 1:1 invariant. Called at module load
 * over the shipped set AND exported for the registry test. The message names the colliding allowId.
 */
export function assertUniqueAllowIds(profiles: readonly TerminalPlatformProfile[]): void {
  const seen = new Map<string, string>(); // allowId → first profile id
  for (const p of profiles) {
    for (const a of p.allowIds) {
      const prior = seen.get(a);
      if (prior !== undefined) {
        throw new Error(
          `terminal platform-profile allowId collision: "${a}" claimed by both "${prior}" and "${p.id}"`,
        );
      }
      seen.set(a, p.id);
    }
  }
}

/**
 * A conservative ReDoS heuristic: reject a regex with a QUANTIFIED group/class that itself contains
 * an unbounded quantifier (the catastrophic-backtracking shapes `(a+)+`, `(\w+)*`, `(a*){2}`,
 * `[a-z]+]*`-style). Profile patterns are hot-path; a pathological one could stall the worker per
 * frame, so the registry rejects it at LOAD rather than at the first hostile screen. Anchoring is
 * NOT forced (legitimate substring perception patterns like `Working \(\d+s\)` match mid-screen).
 */
function isReDoSProne(source: string): boolean {
  // A group `(...)` whose body contains `*`/`+`, immediately followed by another `*`/`+`/`{`.
  if (/\([^)]*[*+][^)]*\)[*+{]/.test(source)) return true;
  // A character class `[...]` immediately followed by two-or-more chained quantifiers.
  if (/\[[^\]]*\][*+]{2,}/.test(source)) return true;
  return false;
}

/**
 * Throw when any of a profile's hot-path patterns (perception.* + dialogs[].detect) is ReDoS-prone.
 * Called at module load over the shipped set AND exported for the registry test.
 */
export function assertSafeProfilePatterns(profile: TerminalPlatformProfile): void {
  const patterns: RegExp[] = [];
  const perc = profile.perception;
  if (perc !== undefined) {
    for (const field of [perc.promptAffordance, perc.workingLine, perc.menuOrPicker, perc.turnEnd]) {
      if (field !== undefined) patterns.push(...field);
    }
  }
  if (profile.dialogs !== undefined) {
    for (const d of profile.dialogs) patterns.push(d.detect);
  }
  for (const re of patterns) {
    if (isReDoSProne(re.source)) {
      throw new Error(
        `terminal platform-profile "${profile.id}" carries a ReDoS-prone pattern: /${re.source}/`,
      );
    }
  }
}

/** Every shipped profile, in registration order. */
export const ALL_PROFILES: readonly TerminalPlatformProfile[] = [claudeCodeProfile, codexProfile];

// Fail at LOAD on a malformed profile set (uniqueness + ReDoS) — never a silent mis-selection.
assertUniqueAllowIds(ALL_PROFILES);
for (const profile of ALL_PROFILES) assertSafeProfilePatterns(profile);

/** allowId → profile, built once from the validated set. */
const BY_ALLOW_ID: ReadonlyMap<string, TerminalPlatformProfile> = (() => {
  const m = new Map<string, TerminalPlatformProfile>();
  for (const p of ALL_PROFILES) {
    for (const a of p.allowIds) m.set(a, p);
  }
  return m;
})();

/**
 * Resolve the read-side platform profile for an operator-declared `allowId`. Exact-string match;
 * `undefined` ⇒ the agnostic default (§3). This is the SOLE selection path — by allowId, never by
 * content (§5/INV-3).
 */
export function getPlatformProfile(allowId: string): TerminalPlatformProfile | undefined {
  return BY_ALLOW_ID.get(allowId);
}
