// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for schema-broker.ts — HostRuleSchema, StaticHeaderSchema,
 * RequestFinalizerSchema, and supporting schemas.
 *
 * HostRuleSchema must accept staticHeaders and finalizer fields so
 * z.strictObject does not reject valid operator YAML that includes them.
 *
 * pathPrefix must reject empty string — min(1) required.
 *
 * suffix HostPatternSchema must require a leading '.' or '-' separator.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  HostPatternSchema,
  HostRuleSchema,
} from "./schema-broker.js";

// ── HostRuleSchema accepts staticHeaders and finalizer ───────────────────────

describe("HostRuleSchema — staticHeaders field", () => {
  it("accepts a HostRule with a staticHeaders array", () => {
    const raw = {
      pattern: { kind: "exact", host: "vertex.googleapis.com" },
      inject: [],
      staticHeaders: [
        { name: "x-goog-user-project", valueRef: "GCP_PROJECT_ID" },
      ],
    };
    const result = HostRuleSchema.safeParse(raw);
    expect(result.success, "HostRuleSchema must accept staticHeaders").toBe(true);
  });

  it("rejects a staticHeaders entry with an empty name (min-1 enforcement)", () => {
    const raw = {
      pattern: { kind: "exact", host: "vertex.googleapis.com" },
      inject: [],
      staticHeaders: [{ name: "", valueRef: "GCP_PROJECT_ID" }],
    };
    const result = HostRuleSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

describe("HostRuleSchema — finalizer field", () => {
  it("accepts a HostRule with finalizer kind=awsSigV4", () => {
    const raw = {
      pattern: { kind: "exact", host: "s3.amazonaws.com" },
      inject: [],
      finalizer: { kind: "awsSigV4" },
    };
    const result = HostRuleSchema.safeParse(raw);
    expect(result.success, "HostRuleSchema must accept finalizer").toBe(true);
  });

  it("rejects an unknown finalizer kind via z.strictObject", () => {
    const raw = {
      pattern: { kind: "exact", host: "s3.amazonaws.com" },
      inject: [],
      finalizer: { kind: "unknown" },
    };
    const result = HostRuleSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

// ── pathPrefix rejects empty string ──────────────────────────────────────────

describe("HostRuleSchema — pathPrefix min(1) enforcement", () => {
  it("rejects a HostRule with an empty string pathPrefix", () => {
    const raw = {
      pattern: { kind: "exact", host: "example.com" },
      inject: [],
      pathPrefix: "",
    };
    const result = HostRuleSchema.safeParse(raw);
    expect(result.success, "empty pathPrefix must be rejected").toBe(false);
  });

  it("accepts a HostRule with a non-empty pathPrefix", () => {
    const raw = {
      pattern: { kind: "exact", host: "example.com" },
      inject: [],
      pathPrefix: "/api/",
    };
    const result = HostRuleSchema.safeParse(raw);
    expect(result.success, "non-empty pathPrefix must be accepted").toBe(true);
  });
});

// ── suffix HostPattern must start with '.' or '-' ────────────────────────────

describe("HostPatternSchema — suffix domain-separator validation", () => {
  it("accepts a suffix starting with '.' (e.g. .amazonaws.com)", () => {
    const result = HostPatternSchema.safeParse({ kind: "suffix", suffix: ".amazonaws.com" });
    expect(result.success).toBe(true);
  });

  it("accepts a suffix starting with '-' (e.g. -aiplatform.googleapis.com)", () => {
    const result = HostPatternSchema.safeParse({ kind: "suffix", suffix: "-aiplatform.googleapis.com" });
    expect(result.success).toBe(true);
  });

  it("rejects a suffix that does not start with '.' or '-' (e.g. amazonaws.com without leading dot)", () => {
    // 'amazonaws.com' would match 'notamazonaws.com' — must require separator
    const result = HostPatternSchema.safeParse({ kind: "suffix", suffix: "amazonaws.com" });
    expect(result.success, "suffix without leading separator must be rejected").toBe(false);
  });

  it("rejects an empty suffix", () => {
    const result = HostPatternSchema.safeParse({ kind: "suffix", suffix: "" });
    expect(result.success).toBe(false);
  });
});
