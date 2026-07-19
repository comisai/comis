// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  evaluateResponseLocale,
  resolveLocale,
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
      translationTarget: "ja-JP",
    })).toEqual({
      locale: "fr-CA",
      source: "request",
      translationTarget: "ja-JP",
      enforceLocale: true,
    });
  });

  it("returns unset for invalid or absent request hints instead of coercing script to English", () => {
    expect(resolveResponseLocalePolicy({ requestLocale: "not a locale" })).toEqual({
      source: "unset",
      enforceLocale: false,
    });
  });

  it("derives an open undetermined-language script tag from the current request text", () => {
    expect(resolveResponseLocalePolicy({ requestText: "اكتب ملخصًا قصيرًا" })).toEqual({
      locale: "und-Arab",
      source: "request",
      enforceLocale: true,
    });
    expect(resolveResponseLocalePolicy({ requestText: "10978704" })).toEqual({
      source: "unset",
      enforceLocale: false,
    });
  });

  it("records deterministic locale source confidence", () => {
    expect(resolveLocale({ explicitLocale: "he-IL", requestLocale: "fr-CA" })).toEqual({
      policy: { locale: "he-IL", source: "explicit", enforceLocale: true },
      confidence: "high",
    });
    expect(resolveLocale({ requestLocale: "fr-CA" })).toEqual({
      policy: { locale: "fr-CA", source: "request", enforceLocale: true },
      confidence: "medium",
    });
    expect(resolveLocale({})).toEqual({
      policy: { source: "unset", enforceLocale: false },
      confidence: "low",
    });
  });

  it("does not accept workspace or conversation prose as locale input", () => {
    const proseHints = {
      workspaceLocale: "de-DE",
      conversationLocale: "ja-JP",
    } as unknown as Parameters<typeof resolveLocale>[0];
    expect(resolveLocale(proseHints)).toEqual({
      policy: { source: "unset", enforceLocale: false },
      confidence: "low",
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

  it("enforces a validated request locale while allowing matching mixed-script prose", () => {
    expect(evaluateResponseLocale(
      { locale: "ar-EG", source: "request", enforceLocale: true },
      "This response uses a different script.",
    )).toEqual(expect.objectContaining({
      kind: "locale_script_mismatch",
      expectedScript: "Arab",
      actualScript: "Latn",
    }));
    expect(evaluateResponseLocale(
      { locale: "ar-EG", source: "request", enforceLocale: true },
      "إجابة عن Docker 25 وURL",
    )).toBeUndefined();
  });
});
