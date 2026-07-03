// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { EmbeddingConfigSchema } from "./schema-embedding.js";

// ---------------------------------------------------------------------------
// The optional `embedding.multilingual` advisory config key.
//
// An optional boolean (NO default) on the top-level z.strictObject. Undeclared
// -> the name heuristic infers the multilingual flag for the `comis fleet`
// model-health line (advisory only; no behavior is gated on it). z.strictObject
// rejects an unknown/typo'd key — the desired strictness.
// ---------------------------------------------------------------------------

describe("EmbeddingConfigSchema — multilingual advisory key", () => {
  it("parses multilingual: true and yields multilingual === true", () => {
    const parsed = EmbeddingConfigSchema.parse({ multilingual: true });
    expect(parsed.multilingual).toBe(true);
  });

  it("parses multilingual: false and yields multilingual === false", () => {
    const parsed = EmbeddingConfigSchema.parse({ multilingual: false });
    expect(parsed.multilingual).toBe(false);
  });

  it("leaves multilingual undefined when omitted (optional, NO default -> heuristic path)", () => {
    const parsed = EmbeddingConfigSchema.parse({});
    expect(parsed.multilingual).toBeUndefined();
  });

  it("throws on a typo'd key (multiligual) — z.strictObject rejects unknown keys", () => {
    expect(() => EmbeddingConfigSchema.parse({ multiligual: true })).toThrow();
  });
});
