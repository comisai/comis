// SPDX-License-Identifier: Apache-2.0
/**
 * Keystone secret-detection tests (Phase 1 — SEC).
 *
 * RED anchors (fail on pre-patch code where the module does not exist, and
 * where the old `looksLikePlaintextSecret` returns the WRONG answer):
 *   - looksLikeSecretValue("Bearer hf_<44+>") === true  (old returns false — SEC-02)
 *   - isSecretFieldName("Authorization") === true        (old pattern misses it — SEC-03)
 *   - scanForSecrets({headers:{Authorization:"Bearer ${TOK}"}}) === []  (SEC-04 exemption)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
// R0 parity guard: test-file cross-import of @comis/observability is allowed.
// Production @comis/core must NOT import @comis/observability — forbidden edge.
// This import lives in a test file only; devDependency in package.json.
import { getDefaultRedactPatterns } from "@comis/observability";
import {
  looksLikeSecretValue,
  isSecretFieldName,
  scanForSecrets,
  redactForDisplay,
  PLAINTEXT_SECRET_PREFIXES,
} from "./secret-detection.js";

// A high-entropy 44+ char credential body (no delimiter chars) so the entropy
// backstop fires after a leading scheme is stripped.
const HF_BODY = "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEf";

describe("looksLikeSecretValue — scheme strip (SEC-02 bug closure)", () => {
  it("detects a Bearer-prefixed high-entropy token (pre-patch returned false)", () => {
    expect(looksLikeSecretValue(`Bearer ${HF_BODY}`)).toBe(true);
  });

  it("is case-insensitive on the scheme word (bearer / BEARER)", () => {
    expect(
      looksLikeSecretValue("bearer sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef"),
    ).toBe(true);
    expect(
      looksLikeSecretValue("BEARER sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef"),
    ).toBe(true);
  });

  it("strips Basic scheme before the entropy gate", () => {
    // Base64 body without `=`/`+`/`/` padding (those are delimiter chars the
    // entropy gate rejects — same set that excludes connection strings/URLs).
    expect(
      looksLikeSecretValue("Basic dXNlcjpsb25ncGFzc3dvcmR3aXRoaGlnaGVudHJvcHkxMjM0NTY3OA"),
    ).toBe(true);
  });

  it("strips Token and Digest schemes", () => {
    expect(
      looksLikeSecretValue("Token sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"),
    ).toBe(true);
    expect(
      looksLikeSecretValue("Digest sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef"),
    ).toBe(true);
  });

  it("strips surrounding double and single quotes", () => {
    expect(
      looksLikeSecretValue('"ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"'),
    ).toBe(true);
    expect(
      looksLikeSecretValue("'sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef'"),
    ).toBe(true);
  });

  it("does NOT flag a scheme wrapping an env-ref placeholder", () => {
    expect(looksLikeSecretValue("Bearer ${GITHUB_TOKEN}")).toBe(false);
  });
});

describe("isSecretFieldName — superset (SEC-03)", () => {
  it("flags Authorization (the old pattern missed it)", () => {
    expect(isSecretFieldName("Authorization")).toBe(true);
  });

  it("flags the full header superset case-insensitively", () => {
    for (const name of [
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "x-auth-token",
      "api-key",
      "X-Api-Key",
      "Set-Cookie",
      "Proxy-Authorization",
    ]) {
      expect(isSecretFieldName(name)).toBe(true);
    }
  });

  it("preserves the old SECRET_FIELD_PATTERN positives", () => {
    for (const name of [
      "botToken",
      "appSecret",
      "webhookSecret",
      "hmacSecret",
      "anyApiKey",
      "some_api_key",
      "dbPassword",
      "myCredential",
      "private_key",
    ]) {
      expect(isSecretFieldName(name)).toBe(true);
    }
  });

  it("does not flag plainly non-secret field names", () => {
    expect(isSecretFieldName("name")).toBe(false);
    expect(isSecretFieldName("url")).toBe(false);
    expect(isSecretFieldName("description")).toBe(false);
  });
});

describe("scanForSecrets — findings + exemptions (SEC-04)", () => {
  it("flags a secret-bearing header value at the correct path", () => {
    const findings = scanForSecrets({
      headers: { Authorization: `Bearer ${HF_BODY}` },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("headers.Authorization");
    expect(["secret-field", "secret-value"]).toContain(findings[0]!.reason);
  });

  it("exempts ${VAR} / $VAR / $${VAR} string references", () => {
    expect(scanForSecrets({ headers: { Authorization: "Bearer ${TOK}" } })).toEqual([]);
    expect(scanForSecrets({ apiKey: "${API_KEY}" })).toEqual([]);
    expect(scanForSecrets({ apiKey: "$API_KEY" })).toEqual([]);
    expect(scanForSecrets({ apiKey: "$${API_KEY}" })).toEqual([]);
  });

  it("exempts a valid SecretRef object", () => {
    expect(
      scanForSecrets({ apiKey: { source: "env", provider: "vault", id: "API_KEY" } }),
    ).toEqual([]);
  });

  it("catches a plaintext secret value in a non-secret-named field", () => {
    const findings = scanForSecrets({
      note: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("note");
  });

  it("walks arrays and nested objects, reporting bracket+dot paths", () => {
    const findings = scanForSecrets({
      servers: [{ headers: { Authorization: `Bearer ${HF_BODY}` } }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("servers[0].headers.Authorization");
  });
});

describe("redactForDisplay", () => {
  it("masks secret-bearing fields and leaves the input unmutated", () => {
    const input = { headers: { Authorization: "Bearer hf_secret" }, name: "ok" };
    const out = redactForDisplay(input);
    expect(out).toEqual({ headers: { Authorization: "[REDACTED]" }, name: "ok" });
    // input is not mutated
    expect(input.headers.Authorization).toBe("Bearer hf_secret");
  });

  it("recurses into arrays", () => {
    const out = redactForDisplay({ list: [{ apiKey: "raw-secret-value" }, { name: "fine" }] });
    expect(out).toEqual({ list: [{ apiKey: "[REDACTED]" }, { name: "fine" }] });
  });
});

// ── WR-01 / IN-01 regression tests (Phase 1 code-review) ────────────────────

describe("scanForSecrets — secret-named array elements (WR-01)", () => {
  // A value that does NOT trigger the value heuristic on its own (short, no
  // known prefix, no high entropy) but lives under a secret-named key.
  const PLAIN = "plainsecret_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd";

  it("flags each element of a secret-named array (pre-patch returns [])", () => {
    const findings = scanForSecrets({ authorization: [PLAIN] });
    // Must find a finding whose path is authorization[0]
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.path === "authorization[0]")).toBe(true);
  });

  it("flags every element of a multi-element secret-named array", () => {
    const findings = scanForSecrets({
      headers: { Authorization: ["Bearer plainA", "Bearer plainB"] },
    });
    expect(findings.some((f) => f.path === "headers.Authorization[0]")).toBe(true);
    expect(findings.some((f) => f.path === "headers.Authorization[1]")).toBe(true);
  });

  it("still exempts ${VAR} / SecretRef elements inside a secret-named array", () => {
    expect(
      scanForSecrets({ authorization: ["${TOKEN}", "$TOKEN", "$${TOKEN}"] }),
    ).toEqual([]);
    expect(
      scanForSecrets({
        authorization: [{ source: "env", provider: "vault", id: "TOKEN" }],
      }),
    ).toEqual([]);
  });

  it("still flags a plaintext secret value in a non-secret-named array", () => {
    // value-heuristic path must still work for array elements
    const findings = scanForSecrets({
      note: ["ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"],
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.path).toBe("note[0]");
  });
});

describe("redactForDisplay — secret-named array values (IN-01)", () => {
  it("redacts each string element under a secret-named key (pre-patch leaves them plain)", () => {
    const out = redactForDisplay({
      authorization: ["Bearer hf_secret", "x"],
    });
    expect(out).toEqual({ authorization: ["[REDACTED]", "[REDACTED]"] });
  });

  it("does NOT mutate the input when the secret-named value is an array", () => {
    const input = { authorization: ["Bearer hf_secret", "x"] };
    redactForDisplay(input);
    expect(input.authorization[0]).toBe("Bearer hf_secret");
  });

  it("redacts nested arrays under a secret-named key", () => {
    const out = redactForDisplay({
      headers: { authorization: ["Bearer x", "Bearer y"] },
    });
    expect(out).toEqual({ headers: { authorization: ["[REDACTED]", "[REDACTED]"] } });
  });
});

// ── R0: explicit prefix entries — vocabulary unification (Phase 1) ──────────

describe("R0: explicit prefix entries — hf_/hfr_/r8_ (vocabulary unification)", () => {
  // Tokens that are above the minimum-body-length gate (patterns.ts requires 18+)
  // but below the 44-char entropy backstop floor, so they only match via the
  // explicit prefix entry. Pre-patch: missing from PLAINTEXT_SECRET_PREFIXES so
  // these 21-30 char tokens slipped the entropy backstop (length < 44).
  // Post-patch: explicit prefix entry + length gate detects them.
  const SHORT_HF = "hf_" + "a".repeat(20); // 23 chars total — prefix + 20 body (> 18 gate, < 44 entropy floor)
  const SHORT_HFR = "hfr_" + "a".repeat(20); // 24 chars total
  const SHORT_R8 = "r8_" + "a".repeat(20); // 23 chars total

  it("R0-a: looksLikeSecretValue returns true for hf_ token below entropy backstop length floor (fails pre-patch: no prefix entry)", () => {
    // PRE-PATCH: returns false (no hf_ prefix entry; entropy backstop requires length >= 44)
    // POST-PATCH: returns true (explicit prefix match with 20-char body >= 18-char gate)
    expect(looksLikeSecretValue(SHORT_HF)).toBe(true);
  });

  it("R0-b: scanForSecrets flags hfr_ value in a non-secret-named field (fails pre-patch: no prefix match, below entropy floor)", () => {
    // PRE-PATCH: returns [] (no prefix match; field name "k" is not secret-named; short value below entropy floor)
    // POST-PATCH: returns a non-empty findings array (hfr_ prefix is explicit, length-gated)
    const findings = scanForSecrets({ k: SHORT_HFR });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("R0-c: PLAINTEXT_SECRET_PREFIXES covers every prefix-kind pattern in observability patterns.ts (drift guard)", () => {
    // WR-01 fix: extract prefixes that include - and . characters (the old \b([A-Za-z0-9_]*)
    // regex stopped at - and . so sk-, ya29., xapp-, pplx- were silently skipped).
    //
    // Strategy: for each prefix-kind pattern, extract the literal token sequence after \b
    // up to the first character-class [ or quantifier { or end-of-pattern.
    // Then assert it's in PLAINTEXT_SECRET_PREFIXES unless explicitly exempted.
    //
    // Explicit exemptions (not a single fixed provider-prefix — the regex uses a
    // character class or non-alphanumeric anchor rather than a plain literal prefix):
    //   "eyJ"   — JWT: base64 header anchor, body-shaped, no fixed 4-char prefix
    //   telegram — \d{8,}: pattern; numeric prefix, no \b match on a letter
    //   apple   — [a-z]{4}-[a-z]{4}-...; character-class start, no fixed prefix
    //   slack-legacy-token — xox[abprs]-: character class after "xox"; keystone has xoxb-/xoxp-.
    //   google-refresh-token — 1//0: prefix contains "/" which is a NON_CREDENTIAL_DELIMITER
    //     char; looksLikeSecretValue always returns false for these (delimiter gate rejects
    //     them before the prefix scan hits). Not possible to add to the keystone value heuristic.
    const EXEMPT_PATTERN_NAMES = new Set([
      "jwt-token",
      "telegram-bot-token",
      "apple-app-password",
      "slack-legacy-token", // xox[abprs]- uses char-class; keystone has xoxb-/xoxp-
      "google-refresh-token", // 1//0 prefix contains "/" delimiter; blocked by delimiter gate
    ]);

    const keystonePrefixes = PLAINTEXT_SECRET_PREFIXES;
    const patterns = getDefaultRedactPatterns();
    const prefixKindPatterns = patterns.filter((p) => p.kind === "prefix");

    for (const p of prefixKindPatterns) {
      if (EXEMPT_PATTERN_NAMES.has(p.name)) continue;

      // Extract the literal prefix after the mandatory \b anchor.
      // Character class [A-Za-z0-9_.\-] captures hyphens and dots so sk-, ya29., xapp- are included.
      // Stop at the first [ (character class) or { (quantifier) in the regex source.
      const m = /\\b([A-Za-z0-9][A-Za-z0-9_.\\-]*)/.exec(p.regex.source);
      if (!m) continue; // no \b anchor — truly not a prefix pattern, skip

      // Unescape any \\ sequences (the regex source represents literal \ as \\)
      const raw = m[1]!;
      // Extract up to the first unescaped quantifier or character class opener
      // The match already stops at [ or { because those aren't in the char class above.
      // Remove any trailing backslash-escaped fragment (e.g. \\ from \. in the source).
      const prefix = raw.replace(/\\(.)/g, "$1"); // unescape \\. → . etc.

      expect(keystonePrefixes, `keystone missing "${prefix}" (from pattern "${p.name}")`).toContain(prefix);
    }

    // Also verify the short tokens (the direct R0 regression) are explicitly covered:
    expect(keystonePrefixes, 'keystone must contain "hf_" (Higgsfield/HuggingFace)').toContain("hf_");
    expect(keystonePrefixes, 'keystone must contain "hfr_" (HuggingFace refresh)').toContain("hfr_");
    expect(keystonePrefixes, 'keystone must contain "r8_" (Replicate)').toContain("r8_");

    // Verify the short tokens are detected by looksLikeSecretValue
    expect(looksLikeSecretValue(SHORT_HF), "hf_ short token must be detected").toBe(true);
    expect(looksLikeSecretValue(SHORT_HFR), "hfr_ short token must be detected").toBe(true);
    expect(looksLikeSecretValue(SHORT_R8), "r8_ short token must be detected").toBe(true);
  });
});

// ── WR-02: keystone false-negatives — common credential shapes slip the scanner ──

describe("WR-02: looksLikeSecretValue correctly detects provider prefixes absent from keystone", () => {
  // PRE-PATCH: these all return false because their prefixes are absent from
  // PLAINTEXT_SECRET_PREFIXES and they are too short for the entropy backstop.
  // POST-PATCH: returns true after adding missing prefixes to PLAINTEXT_SECRET_PREFIXES.

  it("WR-02-a: realistic Google API key (AIzaSy...) detected as secret (pre-patch returns false)", () => {
    // AIzaSy + 33 chars = 39 chars total — below the 44-char entropy backstop floor
    expect(looksLikeSecretValue("AIzaSyA1234567890abcdefghijklmnopqrstu")).toBe(true);
  });

  it("WR-02-b: realistic Google OAuth bearer token (ya29....) detected as secret (pre-patch returns false)", () => {
    // ya29.a0AfH6SMBxxxxxxxxxxxxxxxxx — 31 chars, well below entropy backstop
    expect(looksLikeSecretValue("ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true);
  });

  it("WR-02-c: realistic Slack app token (xapp-...) detected as secret (pre-patch returns false)", () => {
    // xapp-1-A0123456789-ABCDEF012345 — 31 chars
    expect(looksLikeSecretValue("xapp-1-A0123456789-ABCDEF012345")).toBe(true);
  });

  it("WR-02-d: realistic Perplexity key (pplx-...) detected as secret (pre-patch returns false)", () => {
    expect(looksLikeSecretValue("pplx-abc123def456ghi789jkl012m")).toBe(true);
  });

  it("WR-02-e: Comis platform token (comis_...) detected as secret (pre-patch returns false)", () => {
    expect(looksLikeSecretValue("comis_abc123def456ghi789")).toBe(true);
  });

  it("WR-02-f: scanForSecrets flags AIza key inside MCP args array (pre-patch returns [])", () => {
    // Confirmed end-to-end regression: plaintext Google API key in mcp args passes the firewall
    const findings = scanForSecrets({
      integrations: {
        mcp: {
          servers: [{ args: ["--key", "AIzaSyA1234567890abcdefghijklmnopqrstu"] }],
        },
      },
    });
    expect(findings.length, "AIza key in mcp args must be flagged by scanForSecrets").toBeGreaterThan(0);
  });
});

// ── WR-03: keystone false-positives — short/ambiguous prefixes falsely flag legit config ──

describe("WR-03: looksLikeSecretValue does NOT false-positive on legit config strings", () => {
  // PRE-PATCH: bare startsWith() with no length gate returns true for all these.
  // POST-PATCH: length/format gating (matching patterns.ts minimum body length)
  // means these short/legit strings return false.

  it("WR-03-a: npm_config_cache is NOT flagged as a secret (pre-patch returns true)", () => {
    // npm_ prefix but this is a standard npm env var name — 16 chars total, benign
    expect(looksLikeSecretValue("npm_config_cache")).toBe(false);
  });

  it("WR-03-b: AKIDNEYBEAN is NOT flagged as a secret (pre-patch returns true)", () => {
    // AKID prefix but only 11 chars — not a real AWS key (needs 20 total: AKID + 16)
    expect(looksLikeSecretValue("AKIDNEYBEAN")).toBe(false);
  });

  it("WR-03-c: LTAILGATE is NOT flagged as a secret (pre-patch returns true)", () => {
    // LTAI prefix but only 9 chars — not a real Alibaba key (needs 20+ total)
    expect(looksLikeSecretValue("LTAILGATE")).toBe(false);
  });

  it("WR-03-d: hf_model_config is NOT flagged as a secret (pre-patch returns true)", () => {
    // hf_ prefix but only 14 chars — real HuggingFace tokens are hf_ + 18+ alphanumerics
    expect(looksLikeSecretValue("hf_model_config")).toBe(false);
  });

  it("WR-03-e: gsk_test is NOT flagged as a secret (pre-patch returns true)", () => {
    // gsk_ prefix but only 8 chars — real Groq keys are gsk_ + 18+ alphanumerics
    expect(looksLikeSecretValue("gsk_test")).toBe(false);
  });

  it("WR-03-f: r8_unit_tests is NOT flagged as a secret (pre-patch returns true)", () => {
    // r8_ prefix but only 13 chars — real Replicate tokens are r8_ + 18+ alphanumerics
    expect(looksLikeSecretValue("r8_unit_tests")).toBe(false);
  });

  // Positive controls: real long tokens with the same prefixes MUST still be detected.
  it("WR-03-g: a real long npm token (npm_ + 40+ chars) IS still flagged", () => {
    // Real npm automation tokens are npm_ + 36-char UUID-like body
    expect(looksLikeSecretValue("npm_" + "a".repeat(40))).toBe(true);
  });

  it("WR-03-h: a real AWS AKID key (AKID + 16 uppercase alphanumerics) IS still flagged", () => {
    // AWS AKID prefix + 16 chars minimum per patterns.ts AKID[A-Z0-9]{14,}
    expect(looksLikeSecretValue("AKIDABCDEF1234567890")).toBe(true);
  });

  it("WR-03-i: a real Alibaba LTAI key (LTAI + 16 alphanumerics) IS still flagged", () => {
    // Alibaba LTAI prefix + 16 chars minimum per patterns.ts LTAI[A-Za-z0-9]{16,}
    expect(looksLikeSecretValue("LTAIabcdef123456789012")).toBe(true);
  });

  it("WR-03-j: a real HuggingFace token (hf_ + 18+ chars) IS still flagged", () => {
    expect(looksLikeSecretValue("hf_" + "A".repeat(18))).toBe(true);
  });
});
