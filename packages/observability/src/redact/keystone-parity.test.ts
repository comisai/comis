// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-package drift guard: every prefix-kind pattern in this package's redact
 * vocabulary (`patterns.ts`) must be detected by `@comis/core`'s public
 * `looksLikeSecretValue`, so a token shape redacted here is also caught by
 * core's secret-egress scanner.
 *
 * This test lives in `@comis/observability` (which already depends on
 * `@comis/core`) — NOT in core. A `@comis/observability` (dev)dependency on
 * core would close a workspace build cycle and scramble `pnpm -r run build`
 * ordering. See the package.json cycle-invariant test in
 * `packages/core/src/security/secret-egress-guard.test.ts`.
 *
 * It verifies the invariant BEHAVIOURALLY (via the public `looksLikeSecretValue`
 * API) rather than by reaching into core's internal `PLAINTEXT_SECRET_PREFIXES`
 * constant — keeping that keystone private (no dead public export).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { looksLikeSecretValue } from "@comis/core";
import { getDefaultRedactPatterns } from "./patterns.js";

// A body long enough to clear every keystone per-prefix min-body gate (the
// largest is 20) AND composed of a single repeated char so its Shannon entropy
// is ~0 — well below core's entropy backstop floor (3.5). That isolates the
// explicit-prefix detection path as the ONLY way a synthesized token can be
// flagged: if a prefix has drifted out of core's keystone, looksLikeSecretValue
// returns false and the assertion fails — which is exactly the drift we guard.
const BODY = "a".repeat(40);

describe("keystone parity — core detects every observability prefix-kind pattern", () => {
  it("looksLikeSecretValue flags a representative token for each prefix pattern (drift guard)", () => {
    // For each prefix-kind pattern, extract the literal prefix after the
    // mandatory \b anchor, then assert core flags `prefix + BODY`.
    //
    // Explicit exemptions — patterns whose tokens are NOT caught via core's
    // literal-prefix path (the regex uses a character class or a non-alphanumeric
    // anchor rather than a plain literal prefix):
    //   jwt-token            — base64 header anchor (eyJ…), body-shaped, no fixed prefix
    //   telegram-bot-token   — \d{8,}: numeric, no \b match on a letter
    //   apple-app-password   — [a-z]{4}-[a-z]{4}-…: character-class start, no fixed prefix
    //   slack-legacy-token   — xox[abprs]-: character class after "xox"; keystone has xoxb-/xoxp-
    //   google-refresh-token — 1//0…: prefix contains "/" (a NON_CREDENTIAL_DELIMITER char);
    //                          looksLikeSecretValue rejects delimiter-bearing values outright.
    const EXEMPT_PATTERN_NAMES = new Set([
      "jwt-token",
      "telegram-bot-token",
      "apple-app-password",
      "slack-legacy-token",
      "google-refresh-token",
    ]);

    const prefixKindPatterns = getDefaultRedactPatterns().filter((p) => p.kind === "prefix");

    for (const p of prefixKindPatterns) {
      if (EXEMPT_PATTERN_NAMES.has(p.name)) continue;

      // Character class [A-Za-z0-9_.\-] captures hyphens and dots so sk-, ya29.,
      // xapp- are included. The match stops at the first [ (character class) or
      // { (quantifier) in the regex source.
      const m = /\\b([A-Za-z0-9][A-Za-z0-9_.\\-]*)/.exec(p.regex.source);
      if (!m) continue; // no \b anchor — truly not a literal-prefix pattern, skip

      const prefix = m[1]!.replace(/\\(.)/g, "$1"); // unescape \\. → . etc.

      expect(
        looksLikeSecretValue(prefix + BODY),
        `core's looksLikeSecretValue does not flag a "${prefix}" token (from pattern "${p.name}") — keystone drift`,
      ).toBe(true);
    }

    // Short-token spot checks — prefixes whose tokens are above the per-prefix
    // min-body gate but below the 44-char entropy backstop floor, so they can
    // ONLY match via the explicit keystone prefix entry.
    expect(looksLikeSecretValue("hf_" + "a".repeat(20)), "hf_ short token must be detected").toBe(true);
    expect(looksLikeSecretValue("hfr_" + "a".repeat(20)), "hfr_ short token must be detected").toBe(true);
    expect(looksLikeSecretValue("r8_" + "a".repeat(20)), "r8_ short token must be detected").toBe(true);
  });
});
