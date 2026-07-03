// SPDX-License-Identifier: Apache-2.0
/**
 * Keystone secret-detection tests.
 *
 * Anchors (the leak classes the keystone exists to catch):
 *   - looksLikeSecretValue("Bearer hf_<44+>") === true
 *   - isSecretFieldName("Authorization") === true
 *   - scanForSecrets({headers:{Authorization:"Bearer ${TOK}"}}) === []  (env-ref exemption)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  looksLikeSecretValue,
  isSecretFieldName,
  scanForSecrets,
  redactForDisplay,
} from "./secret-detection.js";

// NOTE: the cross-package "drift guard" — which compares core's keystone
// `PLAINTEXT_SECRET_PREFIXES` against `@comis/observability`'s redact patterns —
// lives in `packages/observability/src/redact/keystone-parity.test.ts`, NOT
// here. A `@comis/observability` (dev)dependency on `@comis/core` closes a
// workspace build cycle (observability already depends on core), which
// scrambles `pnpm -r run build` ordering. See the package.json cycle-invariant
// test in `secret-egress-guard.test.ts`.

// A high-entropy 44+ char credential body (no delimiter chars) so the entropy
// backstop fires after a leading scheme is stripped.
const HF_BODY = "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEf";

describe("looksLikeSecretValue — auth-scheme and quote stripping", () => {
  it("detects a Bearer-prefixed high-entropy token", () => {
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

describe("isSecretFieldName — superset", () => {
  it("flags the Authorization header field name", () => {
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

  it("flags pattern-matched secret field names (botToken, appSecret, …)", () => {
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

describe("scanForSecrets — findings + exemptions", () => {
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

// ── regression tests ────────────────────────────────────────────────────────

describe("scanForSecrets — secret-named array elements", () => {
  // A value that does NOT trigger the value heuristic on its own (short, no
  // known prefix, no high entropy) but lives under a secret-named key.
  const PLAIN = "plainsecret_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd";

  it("flags each element of a secret-named array", () => {
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

describe("redactForDisplay — secret-named array values", () => {
  it("redacts each string element under a secret-named key", () => {
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

// ── explicit prefix entries — tokens below the entropy-backstop floor ───────

describe("explicit prefix entries — hf_/hfr_/r8_ tokens below the entropy floor", () => {
  // Tokens that are above the minimum-body-length gate (patterns.ts requires 18+)
  // but below the 44-char entropy backstop floor, so they only match via the
  // explicit prefix entry. Without explicit entries in PLAINTEXT_SECRET_PREFIXES,
  // these 21-30 char tokens slip the entropy backstop (length < 44). The
  // explicit prefix entry + length gate detects them.
  const SHORT_HF = "hf_" + "a".repeat(20); // 23 chars total — prefix + 20 body (> 18 gate, < 44 entropy floor)
  const SHORT_HFR = "hfr_" + "a".repeat(20); // 24 chars total

  it("looksLikeSecretValue returns true for hf_ token below entropy backstop length floor", () => {
    // Explicit prefix match with 20-char body >= 18-char gate.
    expect(looksLikeSecretValue(SHORT_HF)).toBe(true);
  });

  it("scanForSecrets flags hfr_ value in a non-secret-named field", () => {
    // Returns a non-empty findings array (hfr_ prefix is explicit, length-gated).
    const findings = scanForSecrets({ k: SHORT_HFR });
    expect(findings.length).toBeGreaterThan(0);
  });
});

// ── short provider tokens — must match via explicit prefixes, not entropy ───

describe("looksLikeSecretValue detects short provider-prefixed credentials (AIza/ya29./xapp-/pplx-/comis_)", () => {
  // These provider prefixes are explicit PLAINTEXT_SECRET_PREFIXES entries
  // because realistic tokens of these shapes are too short for the entropy
  // backstop — without the explicit entry each would return false.

  it("realistic Google API key (AIzaSy...) detected as secret", () => {
    // AIzaSy + 33 chars = 39 chars total — below the 44-char entropy backstop floor
    expect(looksLikeSecretValue("AIzaSyA1234567890abcdefghijklmnopqrstu")).toBe(true);
  });

  it("realistic Google OAuth bearer token (ya29....) detected as secret", () => {
    // ya29.a0AfH6SMBxxxxxxxxxxxxxxxxx — 31 chars, well below entropy backstop
    expect(looksLikeSecretValue("ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true);
  });

  it("realistic Slack app token (xapp-...) detected as secret", () => {
    // xapp-1-A0123456789-ABCDEF012345 — 31 chars
    expect(looksLikeSecretValue("xapp-1-A0123456789-ABCDEF012345")).toBe(true);
  });

  it("realistic Perplexity key (pplx-...) detected as secret", () => {
    expect(looksLikeSecretValue("pplx-abc123def456ghi789jkl012m")).toBe(true);
  });

  it("Comis platform token (comis_...) detected as secret", () => {
    expect(looksLikeSecretValue("comis_abc123def456ghi789")).toBe(true);
  });

  it("scanForSecrets flags AIza key inside MCP args array", () => {
    // End-to-end guard: a plaintext Google API key in mcp args must be flagged
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

// ── keystone false-positives — short/ambiguous prefixes falsely flag legit config ──

describe("looksLikeSecretValue does NOT false-positive on legit config strings", () => {
  // Bare startsWith() with no length gate would return true for all these.
  // With length/format gating (matching patterns.ts minimum body length),
  // these short/legit strings return false.

  it("npm_config_cache is NOT flagged as a secret", () => {
    // npm_ prefix but this is a standard npm env var name — 16 chars total, benign
    expect(looksLikeSecretValue("npm_config_cache")).toBe(false);
  });

  it("AKIDNEYBEAN is NOT flagged as a secret", () => {
    // AKID prefix but only 11 chars — not a real AWS key (needs 20 total: AKID + 16)
    expect(looksLikeSecretValue("AKIDNEYBEAN")).toBe(false);
  });

  it("LTAILGATE is NOT flagged as a secret", () => {
    // LTAI prefix but only 9 chars — not a real Alibaba key (needs 20+ total)
    expect(looksLikeSecretValue("LTAILGATE")).toBe(false);
  });

  it("hf_model_config is NOT flagged as a secret", () => {
    // hf_ prefix but only 14 chars — real HuggingFace tokens are hf_ + 18+ alphanumerics
    expect(looksLikeSecretValue("hf_model_config")).toBe(false);
  });

  it("gsk_test is NOT flagged as a secret", () => {
    // gsk_ prefix but only 8 chars — real Groq keys are gsk_ + 18+ alphanumerics
    expect(looksLikeSecretValue("gsk_test")).toBe(false);
  });

  it("r8_unit_tests is NOT flagged as a secret", () => {
    // r8_ prefix but only 13 chars — real Replicate tokens are r8_ + 18+ alphanumerics
    expect(looksLikeSecretValue("r8_unit_tests")).toBe(false);
  });

  // Positive controls: real long tokens with the same prefixes MUST still be detected.
  it("a real long npm token (npm_ + 40+ chars) IS still flagged", () => {
    // Real npm automation tokens are npm_ + 36-char UUID-like body
    expect(looksLikeSecretValue("npm_" + "a".repeat(40))).toBe(true);
  });

  it("a real AWS AKID key (AKID + 16 uppercase alphanumerics) IS still flagged", () => {
    // AWS AKID prefix + 16 chars minimum per patterns.ts AKID[A-Z0-9]{14,}
    expect(looksLikeSecretValue("AKIDABCDEF1234567890")).toBe(true);
  });

  it("a real Alibaba LTAI key (LTAI + 16 alphanumerics) IS still flagged", () => {
    // Alibaba LTAI prefix + 16 chars minimum per patterns.ts LTAI[A-Za-z0-9]{16,}
    expect(looksLikeSecretValue("LTAIabcdef123456789012")).toBe(true);
  });

  it("a real HuggingFace token (hf_ + 18+ chars) IS still flagged", () => {
    expect(looksLikeSecretValue("hf_" + "A".repeat(18))).toBe(true);
  });
});
