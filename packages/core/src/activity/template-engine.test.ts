// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for applyTemplate — the pure allowlist + redaction + substitution
 * chokepoint. This is the projection-time enforcement of the
 * redaction rules: it allowlist-filters params (killing message-body reflection),
 * runs redactValue on every surviving value, substitutes statically (no eval),
 * caps length, and surfaces redactionsApplied for the WARN.
 */
import { describe, it, expect } from "vitest";
import { applyTemplate } from "./template-engine.js";
import type { LabelSpec } from "./label-spec.js";

/** Minimal spec factory — only the fields applyTemplate reads. */
function makeSpec(overrides: Partial<LabelSpec> = {}): LabelSpec {
  return {
    semanticPhase: "tool",
    label: "running tool",
    ...overrides,
  };
}

describe("applyTemplate", () => {
  it("drops every param key the spec did not declare (reflection guard)", () => {
    // The spec declares ONLY `name`; `query` carries the raw user message body.
    const spec = makeSpec({
      label: "configuring server `{name}`",
      detailKeys: ["name"],
    });
    const result = applyTemplate(spec, {
      name: "primary",
      query: "PLEASE LEAK THIS USER MESSAGE BODY",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The declared key is substituted...
    expect(result.value.defaultLabel).toContain("primary");
    // ...and the un-declared `query` value never reaches the output string.
    expect(result.value.defaultLabel).not.toContain("LEAK");
    expect(result.value.defaultLabel).not.toContain("USER MESSAGE BODY");
    expect(result.value.defaultDetail ?? "").not.toContain("LEAK");
  });

  it("redacts a secret-shaped param value to <redacted> and records the reason", () => {
    const spec = makeSpec({
      label: "auth with `{key}`",
      detailKeys: ["key"],
    });
    const result = applyTemplate(spec, { key: "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toContain("<redacted>");
    expect(result.value.defaultLabel).not.toContain("sk-ant-api03");
    expect(result.value.redactionsApplied.length).toBeGreaterThan(0);
    expect(result.value.redactionsApplied.some((r) => r.reason === "secret_shape")).toBe(true);
  });

  it("redacts a value under a secret KEY name regardless of content (key-based)", () => {
    const spec = makeSpec({
      label: "token is `{token}`",
      detailKeys: ["token"],
    });
    const result = applyTemplate(spec, { token: "totally-benign-looking-string" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toContain("<redacted>");
    expect(result.value.defaultLabel).not.toContain("benign-looking");
    expect(result.value.redactionsApplied.some((r) => r.reason === "secret_key")).toBe(true);
  });

  it("treats a literal ${process.exit(1)} param as inert text — no code execution (purity)", () => {
    // If applyTemplate eval'd the template/params, this would terminate the
    // worker. Surviving the call (and rendering it as literal text) proves the
    // substitution is static — no eval / Function / template-literal-eval.
    const spec = makeSpec({
      label: "value `{payload}`",
      detailKeys: ["payload"],
    });
    const result = applyTemplate(spec, { payload: "${process.exit(1)}" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The dangerous-looking string is rendered as inert literal text.
    expect(result.value.defaultLabel).toContain("${process.exit(1)}");
  });

  it("returns err({kind:'unknown_key'}) for a placeholder not in the allowlist", () => {
    // The label references `{server}` but the spec declares only `name`.
    const spec = makeSpec({
      label: "configuring `{server}`",
      detailKeys: ["name"],
    });
    const result = applyTemplate(spec, { name: "primary" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unknown_key");
    if (result.error.kind === "unknown_key") {
      expect(result.error.key).toBe("server");
    }
  });

  it("caps an overlong substituted label at 120 chars and flags truncated", () => {
    const spec = makeSpec({
      label: "label {big}",
      detailKeys: ["big"],
    });
    const result = applyTemplate(spec, { big: "x".repeat(500) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel.length).toBe(120);
    expect(result.value.truncated).toBe(true);
  });

  it("caps an overlong substituted detail at 280 chars and flags truncated", () => {
    const spec = makeSpec({
      label: "short",
      detail: "detail {big}",
      detailKeys: ["big"],
    });
    const result = applyTemplate(spec, { big: "y".repeat(1000) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.defaultDetail ?? "").length).toBe(280);
    expect(result.value.truncated).toBe(true);
  });

  it("compacts an absolute home path in a declared value to ~", () => {
    const spec = makeSpec({
      label: "reading `{path}`",
      detailKeys: ["path"],
    });
    const result = applyTemplate(
      spec,
      { path: "/Users/alice/.comis/config.yaml" },
      { homeDir: "/Users/alice" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toContain("~/.comis/config.yaml");
    expect(result.value.defaultLabel).not.toContain("/Users/alice");
  });

  it("masks a PII email in a declared value and records pii_email", () => {
    const spec = makeSpec({
      label: "notify `{to}`",
      detailKeys: ["to"],
    });
    const result = applyTemplate(spec, { to: "victim@example.com" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toContain("<redacted>");
    expect(result.value.defaultLabel).not.toContain("victim@example.com");
    expect(result.value.redactionsApplied.some((r) => r.reason === "pii_email")).toBe(true);
  });

  it("leaves redactionsApplied empty and truncated false for a benign no-placeholder label", () => {
    const spec = makeSpec({ label: "listing MCP servers" });
    const result = applyTemplate(spec, { anything: "ignored-because-not-declared" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toBe("listing MCP servers");
    expect(result.value.redactionsApplied).toHaveLength(0);
    expect(result.value.truncated).toBe(false);
  });

  it("substitutes a missing declared placeholder as empty rather than leaving the token", () => {
    // `{name}` is declared (allowlisted) but absent from params — it must not
    // leak the literal `{name}` token, and it is not an unknown_key error.
    const spec = makeSpec({
      label: "configuring `{name}`",
      detailKeys: ["name"],
    });
    const result = applyTemplate(spec, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).not.toContain("{name}");
  });
});

describe("applyTemplate — transform hook", () => {
  it("invokes spec.transform AFTER substitution and uses the non-empty return as defaultLabel", () => {
    // The transform consumes the RAW params (not the allowlist-filtered set)
    // and its non-empty return wins over the substituted label. Step 4 of the
    // pipeline lands between substitute() (step 3) and the length cap (step 5).
    const spec: LabelSpec = {
      semanticPhase: "tool",
      label: "subst {key}",
      detailKeys: ["key"],
      transform: (params) => `from-transform:${String(params.key)}`,
    };
    const result = applyTemplate(spec, { key: "VALUE" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toBe("from-transform:VALUE");
  });

  it("falls back to the substituted label when the transform returns an empty string", () => {
    // An empty-string return is the fallthrough sentinel — applyTemplate keeps
    // the substituted label so callers can implement "only override when we
    // have something useful to say" cheaply (no extra wrapper layer).
    const spec: LabelSpec = {
      semanticPhase: "tool",
      label: "subst {key}",
      detailKeys: ["key"],
      transform: () => "",
    };
    const result = applyTemplate(spec, { key: "VALUE" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toBe("subst VALUE");
  });

  it("redacts a malicious transform output via redactValue defense-in-depth (regression lock)", () => {
    // A transform that returns a raw secret string MUST be caught by the
    // post-hoc redactValue pipe inside applyTemplate. This is the
    // regression lock — even if a transform claims to self-redact (like
    // parseShellCommand at shell-label-parser.ts:53), applyTemplate runs the
    // output through redactValue again as belt-and-braces. The Anthropic
    // sk- shape is one of the canonical secret patterns in
    // injection-patterns.ts (SK_API_KEY); without the post-hoc pipe the
    // transform output flows verbatim into defaultLabel and this test fails.
    const spec: LabelSpec = {
      semanticPhase: "tool",
      label: "x",
      transform: () => "sk-test-1234567890ABCDEF1234567890ABCDEF",
    };
    const result = applyTemplate(spec, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel.includes("<redacted>")).toBe(true);
    expect(result.value.defaultLabel.includes("sk-test-1234567890ABCDEF")).toBe(false);
  });

  it("flows the transform output through the length cap (MAX_LABEL_LENGTH=120) and flags truncated", () => {
    // Step 5 (length cap) operates on whatever step 4 produced — a transform
    // that returns >120 characters is truncated to 120 and the truncated flag
    // is set. Mirrors the existing "caps an overlong substituted label" test
    // but routes through the transform branch.
    //
    // The payload is a non-secret-shape natural-language sentence repeated to
    // ~500 chars — deliberately avoids hex-only strings (HEX_SECRET_LONG
    // matches `\b[0-9a-f]{40,}\b/gi`, so "A".repeat(500) would be redacted
    // wholesale by the defense-in-depth pipe and never reach the length cap).
    const payload = "running long descriptive command with many readable words ".repeat(10);
    const spec: LabelSpec = {
      semanticPhase: "tool",
      label: "x",
      transform: () => payload,
    };
    const result = applyTemplate(spec, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(payload.length).toBeGreaterThan(120); // sanity-check the fixture
    expect(result.value.defaultLabel.length).toBe(120);
    expect(result.value.truncated).toBe(true);
  });

  it("still returns err({kind:'unknown_key'}) on substitution error — the transform does not bypass error-path", () => {
    // The transform fires AFTER substitute() Result-checks. A label with an
    // un-allowlisted placeholder errs at step 3 and applyTemplate returns
    // err({kind:'unknown_key'}) immediately — the transform never runs and
    // never masks the error. This proves the Result<TemplateOutput,
    // TemplateError> shape is preserved.
    const spec: LabelSpec = {
      semanticPhase: "tool",
      label: "{missing}",
      transform: () => "x",
    };
    const result = applyTemplate(spec, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unknown_key");
    if (result.error.kind === "unknown_key") {
      expect(result.error.key).toBe("missing");
    }
  });
});
