// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  PROFILE_ID_RE,
  validateProfileId,
} from "./oauth-credential-store.js";

describe("validateProfileId", () => {
  it("accepts a well-formed provider:email profile ID", () => {
    const result = validateProfileId("openai-codex:user_a@example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe("openai-codex");
      expect(result.value.identity).toBe("user_a@example.com");
    }
  });

  it("accepts a well-formed provider:env-bootstrap profile ID", () => {
    const result = validateProfileId("openai-codex:env-bootstrap");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe("openai-codex");
      expect(result.value.identity).toBe("env-bootstrap");
    }
  });

  it("rejects a profile ID without a colon (no identity)", () => {
    const result = validateProfileId("openai-codex");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid profile ID");
    }
  });

  it("rejects a profile ID with an empty provider", () => {
    const result = validateProfileId(":user_a@example.com");
    expect(result.ok).toBe(false);
  });

  it("rejects a profile ID with an empty identity", () => {
    const result = validateProfileId("openai-codex:");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty string profile ID", () => {
    const result = validateProfileId("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty or non-string");
    }
  });

  it("rejects an identity containing path-traversal sequences (..\\ Windows-style)", () => {
    const result = validateProfileId("openai-codex:..\\..\\etc\\passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("forbidden characters");
    }
  });

  it("rejects an identity containing forward slash", () => {
    const result = validateProfileId("openai-codex:user/path");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("forbidden characters");
    }
  });

  it("rejects an identity containing a backslash-n escape sequence", () => {
    // Plan spec: validateProfileId("openai-codex:user\\nname") — i.e. literal backslash + n.
    // The backslash in the identity triggers the forbidden-character defense-in-depth check.
    const result = validateProfileId("openai-codex:user\\nname");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("forbidden characters");
    }
  });

  it("PROFILE_ID_RE.test returns true for a well-formed provider:email profile ID", () => {
    expect(PROFILE_ID_RE.test("openai-codex:user_a@example.com")).toBe(true);
  });

  it("PROFILE_ID_RE.test returns false for a profile ID without a colon", () => {
    expect(PROFILE_ID_RE.test("openai-codex")).toBe(false);
  });
});
