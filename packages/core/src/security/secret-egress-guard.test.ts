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

  it("scrubs token with hfr_ prefix from text", () => {
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

  it("scrubs token with sk-ant- prefix from text", () => {
    const token = "sk-ant-api03-" + "X".repeat(36);
    const result = scrubSecretsFromText(`Key: ${token}`);
    expect(result.redactions).toBe(1);
    expect(result.text).not.toContain(token);
  });

  it("scrubs a quoted password assigned to an environment-style field", () => {
    const value = "ordinary-password-value";
    const result = scrubSecretsFromText(`SERVICE_PASSWORD='${value}'`);
    expect(result.redactions).toBe(1);
    expect(result.text).not.toContain(value);
    expect(result.text).toBe("SERVICE_PASSWORD='[REDACTED]'");
  });

  it("scrubs secret-bearing JSON and YAML fields without requiring token entropy", () => {
    const jsonValue = "short-json-value";
    const yamlValue = "short-yaml-value";
    const result = scrubSecretsFromText(`{"api_key":"${jsonValue}"}\npassword: ${yamlValue}`);
    expect(result.redactions).toBe(2);
    expect(result.text).not.toContain(jsonValue);
    expect(result.text).not.toContain(yamlValue);
  });

  it("preserves environment references and existing redaction sentinels", () => {
    const input = "PASSWORD=${SERVICE_PASSWORD}\napi_key: [REDACTED]";
    expect(scrubSecretsFromText(input)).toEqual({ text: input, redactions: 0 });
  });

  it("does not treat plural token-usage metrics as credential assignments", () => {
    const input = "Runtime: 2.1s | Steps: 3 | Tokens: 200 | Cost: $0.0200";
    expect(scrubSecretsFromText(input)).toEqual({ text: input, redactions: 0 });
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

  it("returns true for a non-token string that merely contains a known prefix (conservative pre-filter)", () => {
    // 'hf_model_config' — not a token-like value but contains prefix; pre-filter is
    // intentionally conservative (fast) so this returns true (see scrubSecretsFromText
    // for fine-grained regex with minBody gate)
    expect(mightContainSecret("hf_model_config")).toBe(true);
  });

  it("returns true for an environment-style password assignment", () => {
    expect(mightContainSecret("SERVICE_PASSWORD='ordinary-password-value'")).toBe(true);
  });
});

describe("cycle invariant: secret-egress-guard.ts must not import from @comis/observability", () => {
  it("does NOT import from @comis/observability", () => {
    const sourceFile = join(__dirname, "secret-egress-guard.ts");
    const source = readFileSync(sourceFile, "utf-8");
    expect(source).not.toContain("@comis/observability");
  });
});

describe("cycle invariant: @comis/core package.json must not depend on @comis/observability", () => {
  // A `@comis/observability` entry in core's dependencies OR devDependencies
  // closes a workspace dependency cycle (observability already depends on core),
  // which scrambles `pnpm -r run build` topological ordering and builds
  // observability before core on a clean checkout → "Cannot find module
  // '@comis/core'". This guards the package-manifest edge that neither the
  // madge `.d.ts` cycle check nor the project-reference check can see.
  it("declares no @comis/observability dependency in deps or devDeps", () => {
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(allDeps)).not.toContain("@comis/observability");
  });
});
