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

  it("tells the model that a clear current-request language change outranks history", () => {
    expect(renderResponseLocalePolicy({
      locale: "und-Latn",
      source: "request",
      enforceLocale: false,
    })).toContain("current request takes precedence over earlier conversation turns");
  });

  it("forbids satisfying a script tag by transliterating", () => {
    // A script-only tag plus "use the same human language" is satisfiable by
    // romanization, which is what a Hebrew conversation actually received once
    // a Latin script tag was enforced. The tag must never license that.
    const rendered = renderResponseLocalePolicy({
      locale: "und-Latn",
      source: "request",
      enforceLocale: true,
    });
    expect(rendered).toContain("transliterate");
    expect(rendered).toContain("its own script");
  });

  it("computes stable hashes for identical feature inputs", () => {
    const input = { toolPolicy: { mode: "allowlist" }, tools: { enabledGroups: ["read"] } };
    expect(computeFeatureFlagHash(input)).toBe(computeFeatureFlagHash(input));
  });
});
