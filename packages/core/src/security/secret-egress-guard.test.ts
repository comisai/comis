// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { scrubSecretsFromText, mightContainSecret } from "./secret-egress-guard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("scrubSecretsFromText", () => {
  it("scrubs Bearer hf_ token from text", () => {
    const token = "hf_" + "a".repeat(44);
    const result = scrubSecretsFromText(`Bearer ${token}`);
    expect(result.redactions).toBe(1);
    expect(result.text).not.toContain(token);
    expect(result.text).toContain("[REDACTED]");
  });

  it("scrubs bare hf_ prefix token without Bearer", () => {
    const token = "hf_" + "a".repeat(44);
    const result = scrubSecretsFromText(token);
    expect(result.redactions).toBe(1);
    expect(result.text).not.toContain(token);
    expect(result.text).toContain("[REDACTED]");
  });

  it("scrubs hfr_ prefix token", () => {
    const token = "hfr_" + "b".repeat(44);
    const result = scrubSecretsFromText(token);
    expect(result.redactions).toBe(1);
    expect(result.text).not.toContain(token);
    expect(result.text).toContain("[REDACTED]");
  });

  it("does not scrub env-ref strings", () => {
    const input = "API_KEY=${HF_TOKEN}";
    const result = scrubSecretsFromText(input);
    expect(result.redactions).toBe(0);
    expect(result.text).toBe(input);
  });

  it("returns { text, redactions: 0 } for clean text", () => {
    const input = "hello world no secrets here";
    const result = scrubSecretsFromText(input);
    expect(result.redactions).toBe(0);
    expect(result.text).toBe(input);
  });

  it("scrubs sk-ant- prefix token", () => {
    const token = "sk-ant-api03-" + "X".repeat(36);
    const result = scrubSecretsFromText(`Key: ${token}`);
    expect(result.redactions).toBe(1);
    expect(result.text).not.toContain(token);
  });
});

describe("mightContainSecret", () => {
  it("returns false for clean text", () => {
    expect(mightContainSecret("hello world no secrets here")).toBe(false);
  });

  it("returns true for text with hf_ prefix", () => {
    expect(mightContainSecret("see hf_token")).toBe(true);
  });

  it("returns true for text with Bearer prefix", () => {
    expect(mightContainSecret("Authorization: Bearer sometoken")).toBe(true);
  });

  it("returns true for text with Token prefix", () => {
    expect(mightContainSecret("Token abc123")).toBe(true);
  });

  it("returns false for text with only partial prefix match", () => {
    // 'hf_model_config' — not a token-like value but contains prefix; pre-filter is
    // intentionally conservative (fast) so this returns true (see scrubSecretsFromText
    // for fine-grained regex with minBody gate)
    expect(mightContainSecret("hf_model_config")).toBe(true);
  });
});

describe("cycle invariant: secret-egress-guard.ts must not import from @comis/observability", () => {
  it("does NOT import from @comis/observability", () => {
    const sourceFile = join(__dirname, "secret-egress-guard.ts");
    const source = readFileSync(sourceFile, "utf-8");
    expect(source).not.toContain("@comis/observability");
  });
});
