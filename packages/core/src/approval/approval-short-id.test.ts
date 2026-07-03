// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { mintApprovalShortId } from "./approval-short-id.js";

// The approval-gate mints a 12-char base62 callback-safe id
// drawn from a CSPRNG. These assertions pin shape, charset, length, and
// non-trivial entropy (collision-freedom across a small sample).

const BASE62 = /^[0-9A-Za-z]+$/;

// The exact domain-schema constraint (approval-request.ts) the minted id must satisfy.
const ShortIdSchema = z.string().length(12).regex(/^[0-9A-Za-z]+$/);

describe("mintApprovalShortId", () => {
  it("returns a string of length exactly 12", () => {
    const id = mintApprovalShortId();
    expect(typeof id).toBe("string");
    expect(id).toHaveLength(12);
  });

  it("returns a value whose every character is base62 (0-9A-Za-z)", () => {
    for (let i = 0; i < 256; i++) {
      const id = mintApprovalShortId();
      expect(id).toMatch(BASE62);
    }
  });

  it("satisfies the ApprovalRequest shortId schema (length 12 + base62 regex)", () => {
    const id = mintApprovalShortId();
    expect(ShortIdSchema.safeParse(id).success).toBe(true);
  });

  it("two successive calls return different values", () => {
    const a = mintApprovalShortId();
    const b = mintApprovalShortId();
    expect(a).not.toBe(b);
  });

  it("produces collision-free ids across a 1000-sample (CSPRNG entropy)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(mintApprovalShortId());
    }
    expect(seen.size).toBe(1000);
  });

  it("does not always emit the same character in any single position (not a constant)", () => {
    // Guards against a degenerate impl (e.g. always ALPHABET[0]) that would still
    // be length-12 base62 but trivially guessable. Each position must vary across samples.
    const positionValues: Array<Set<string>> = Array.from({ length: 12 }, () => new Set<string>());
    for (let i = 0; i < 200; i++) {
      const id = mintApprovalShortId();
      for (let pos = 0; pos < 12; pos++) {
        positionValues[pos]!.add(id.charAt(pos));
      }
    }
    for (let pos = 0; pos < 12; pos++) {
      expect(positionValues[pos]!.size).toBeGreaterThan(1);
    }
  });
});
