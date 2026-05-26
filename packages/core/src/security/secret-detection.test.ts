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
import {
  looksLikeSecretValue,
  isSecretFieldName,
  scanForSecrets,
  redactForDisplay,
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
