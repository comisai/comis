// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  evaluateResponseLocale,
  resolveResponseLocalePolicy,
} from "./resolve-response-locale-policy.js";

describe("resolveResponseLocalePolicy", () => {
  it("canonicalizes an unknown but valid locale without a closed language list", () => {
    expect(resolveResponseLocalePolicy({ explicitLocale: "sr-latn-rs" })).toEqual({
      locale: "sr-Latn-RS",
      source: "explicit",
      enforceLocale: true,
    });
  });

  it("uses typed resolution order and keeps translation target separate", () => {
    expect(resolveResponseLocalePolicy({
      requestLocale: "fr-CA",
      workspaceLocale: "de-DE",
      translationTarget: "ja-JP",
    })).toEqual({
      locale: "fr-CA",
      source: "request",
      translationTarget: "ja-JP",
      enforceLocale: false,
    });
  });

  it("returns unset for invalid or absent hints instead of coercing script to English", () => {
    expect(resolveResponseLocalePolicy({ workspaceLocale: "not a locale" })).toEqual({
      source: "unset",
      enforceLocale: false,
    });
  });

  it("reports a script quality finding without rewriting the response", () => {
    const finding = evaluateResponseLocale(
      { locale: "el-GR", source: "explicit", enforceLocale: true },
      "This response uses a different script.",
    );
    expect(finding).toEqual(expect.objectContaining({
      kind: "locale_script_mismatch",
      expectedScript: "Grek",
      actualScript: "Latn",
    }));
    expect(JSON.stringify(finding)).not.toContain("This response uses a different script.");
  });

  it("does not flag mixed or unenforced responses", () => {
    expect(evaluateResponseLocale(
      { locale: "ar-EG", source: "request", enforceLocale: false },
      "mixed text نص",
    )).toBeUndefined();
  });
});
