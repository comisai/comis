// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { computeFeatureFlagHash, renderResponseLocalePolicy } from "./prompt-assembly-shared.js";

describe("prompt assembly shared helpers", () => {
  it("renders an explicit response locale without a closed language list", () => {
    expect(renderResponseLocalePolicy({
      locale: "he-IL",
      source: "explicit",
      enforceLocale: true,
    })).toContain("he-IL");
  });

  it("describes an undetermined-language script tag without inventing a language", () => {
    expect(renderResponseLocalePolicy({
      locale: "und-Arab",
      source: "request",
      enforceLocale: true,
    })).toContain("same human language as the current user request");
  });

  it("computes stable hashes for identical feature inputs", () => {
    const input = { toolPolicy: { mode: "allowlist" }, tools: { enabledGroups: ["read"] } };
    expect(computeFeatureFlagHash(input)).toBe(computeFeatureFlagHash(input));
  });
});
