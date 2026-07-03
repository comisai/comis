// SPDX-License-Identifier: Apache-2.0
/**
 * `redactSecretsInText` tests.
 *
 * Behavior:
 *   - Applies the default pattern set via `replacePatternBounded`.
 *   - Each match is replaced with the edge-keeping mask of the captured
 *     secret substring (callers see correlation across the same input)
 *     OR the `***` short-token sentinel for sub-MIN_LENGTH matches.
 *   - Non-credential text is unchanged.
 *   - Cross-context credential bodies are individually masked.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { redactSecretsInText } from "./redact-text.js";

describe("redactSecretsInText — single-secret scenarios", () => {
  it("masks a Bearer-token Authorization header — secret survives only as edge-mask", () => {
    const out = redactSecretsInText(
      "Error: HTTP 401 - Authorization: Bearer sk-1234567890abcdef rejected",
    );
    // The Bearer's original 18+ char token must NOT survive verbatim.
    expect(out.includes("sk-1234567890abcdef")).toBe(false);
    // Non-credential context preserved.
    expect(out.includes("Error: HTTP 401")).toBe(true);
    expect(out.includes("rejected")).toBe(true);
  });

  it("masks an ENV-style ANTHROPIC_API_KEY=sk-… line", () => {
    const out = redactSecretsInText("ANTHROPIC_API_KEY=sk-abc1234567890def0");
    expect(out.includes("sk-abc1234567890def0")).toBe(false);
  });

  it("masks an api_key URL query param", () => {
    const out = redactSecretsInText("https://example.com/v1?api_key=sk-abc1234567890def0&other=1");
    expect(out.includes("sk-abc1234567890def0")).toBe(false);
    expect(out.includes("&other=1")).toBe(true);
  });

  it("masks a PEM private-key block — body replaced, BEGIN/END label survive", () => {
    const pem = [
      "before",
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDuY/SECRET",
      "-----END PRIVATE KEY-----",
      "after",
    ].join("\n");

    const out = redactSecretsInText(pem);
    // The base64-shaped body line is gone (or replaced).
    expect(out.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDuY/SECRET")).toBe(false);
    // The bracketing labels and surrounding context survive.
    expect(out.includes("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(out.includes("-----END PRIVATE KEY-----")).toBe(true);
    expect(out.includes("before")).toBe(true);
    expect(out.includes("after")).toBe(true);
  });
});

describe("redactSecretsInText — preservation of benign text", () => {
  it("leaves a diagnostic message like 'Unrecognized key: \"llm\"' unchanged", () => {
    const msg = 'Unrecognized key: "llm" in config';
    const out = redactSecretsInText(msg);
    expect(out).toBe(msg);
  });

  it("leaves a generic INFO log message with no secrets unchanged", () => {
    const msg = "Execution complete | durationMs=42 | agentId=sha256:abc";
    const out = redactSecretsInText(msg);
    expect(out).toBe(msg);
  });

  it("preserves lowercase api_key=… in prose (does not trigger ENV pattern)", () => {
    // The case-sensitive ENV pattern only fires on UPPERCASE identifiers.
    // Lowercase `api_key=` in body prose passes through unless caught
    // by another pattern (CLI/URL-query do also match these forms).
    // This test pins the ENV branch's case-sensitivity, so we use a
    // bare " api_key=foo " body with no leading flag-dash and no
    // leading URL-query separator — neither the CLI nor URL-query
    // patterns fire.
    const msg = "config api_key=lowercaseshort";
    const out = redactSecretsInText(msg);
    expect(out).toBe(msg);
  });
});

describe("redactSecretsInText — multi-pattern composition", () => {
  it("masks multiple distinct credentials in the same input independently", () => {
    const input =
      "logs: Authorization: Bearer sk-1234567890abcdef and ?api_key=ghp_abcdefghij1234567890 done";
    const out = redactSecretsInText(input);
    expect(out.includes("sk-1234567890abcdef")).toBe(false);
    expect(out.includes("ghp_abcdefghij1234567890")).toBe(false);
    expect(out.includes("done")).toBe(true);
  });

  it("returns the same output for the same input (deterministic)", () => {
    const input = "Authorization: Bearer sk-1234567890abcdef";
    expect(redactSecretsInText(input)).toBe(redactSecretsInText(input));
  });

  it("returns the input unchanged when no pattern matches", () => {
    const input = "the quick brown fox";
    expect(redactSecretsInText(input)).toBe(input);
  });
});
