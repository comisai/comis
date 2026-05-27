// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { OAuthConfigSchema } from "./schema-oauth.js";

describe("OAuthConfigSchema", () => {
  it("parses an empty object and applies the default storage = 'file'", () => {
    const parsed = OAuthConfigSchema.parse({});
    expect(parsed).toEqual({ storage: "file" });
  });

  it("accepts storage = 'file' explicitly", () => {
    const parsed = OAuthConfigSchema.parse({ storage: "file" });
    expect(parsed).toEqual({ storage: "file" });
  });

  it("accepts storage = 'encrypted'", () => {
    const parsed = OAuthConfigSchema.parse({ storage: "encrypted" });
    expect(parsed).toEqual({ storage: "encrypted" });
  });

  it("rejects an invalid storage value with a ZodError", () => {
    expect(() => OAuthConfigSchema.parse({ storage: "invalid" })).toThrow(z.ZodError);
  });

  it("rejects extra fields with a ZodError (strictObject)", () => {
    expect(() => OAuthConfigSchema.parse({ storage: "file", extraField: "x" })).toThrow(z.ZodError);
  });
});

// ---------------------------------------------------------------------------
// R8: oauth.storage default changed to "encrypted" for provider tokens
// This describe block fails until schema-oauth.ts is patched (RED phase).
// ---------------------------------------------------------------------------

describe("OAuthConfigSchema R8 provider default", () => {
  it("oauth.storage defaults to 'encrypted' when not specified (R8 provider token default)", () => {
    // RED: This test fails on the current schema because the default is "file".
    // GREEN: After patching schema-oauth.ts default to "encrypted", this passes.
    const parsed = OAuthConfigSchema.parse({});
    expect(parsed.storage).toBe("encrypted");
  });
});
