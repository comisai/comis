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

  it("rejects a substantial Latin prose preamble hidden by a longer Arabic tail", () => {
    const finding = evaluateResponseLocale(
      { locale: "ar", source: "request", enforceLocale: true },
      "I'm here for project management only, so I can't answer general questions like that — even in one sentence.\n\n"
        + "بدلاً من ذلك يمكنني عرض مواقع المركبات أو التحقق من حالة التنبيهات النشطة.",
    );

    expect(finding).toEqual(expect.objectContaining({
      kind: "locale_script_mismatch",
      expectedScript: "Arab",
      actualScript: "Latn",
    }));
  });

  it("rejects a Hebrew prose preamble hidden by a longer Arabic tail", () => {
    const finding = evaluateResponseLocale(
      { locale: "ar", source: "request", enforceLocale: true },
      "זהו סירוב שנכתב בעברית.\n\n"
        + "بدلاً من ذلك يمكنني عرض مواقع المركبات أو التحقق من حالة التنبيهات النشطة في أسطولك.",
    );

    expect(finding).toEqual(expect.objectContaining({
      kind: "locale_script_mismatch",
      expectedScript: "Arab",
      actualScript: "Hebr",
    }));
  });
});

describe("request-locale vs conversation-script precedence", () => {
  // The transport/request locale (a Telegram client's UI language_code, a
  // REST caller's locale field) is a DEVICE setting, not the conversation's
  // language. When it contradicts the script the user is actually writing
  // in, the conversation wins — a correct same-script reply must never be
  // "repaired" toward the device UI language.
  it("yields to the current message's script when the transport locale contradicts it", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "en",
      requestText: "מה מזג האוויר מחר בתל אביב ואיך כדאי להתארגן ליום?",
    });
    expect(policy.locale).toBe("und-Hebr");
    expect(policy.source).toBe("request");
    expect(policy.enforceLocale).toBe(true);
  });

  it("keeps the request locale when it agrees with the message script", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "מה מזג האוויר מחר בתל אביב?",
    });
    expect(policy.locale).toBe("he");
    expect(policy.source).toBe("request");
    expect(policy.enforceLocale).toBe(true);
  });

  it("enforces the current Latin prose script when it contradicts a non-Latin transport locale", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "What is the weather tomorrow in Tel Aviv?",
    });
    expect(policy.locale).toBe("und-Latn");
    expect(policy.source).toBe("request");
    expect(policy.enforceLocale).toBe(true);
  });

  it("does not treat a short Latin identifier as a conversation-language override", () => {
    expect(resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "npm test",
    })).toEqual({
      locale: "he",
      source: "request",
      enforceLocale: true,
    });
  });

  it("keeps the request locale when the message carries no script signal", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "",
    });
    expect(policy.locale).toBe("he");
    expect(policy.enforceLocale).toBe(true);
  });

  it("never overrides the explicit operator locale with the message script", () => {
    const policy = resolveResponseLocalePolicy({
      explicitLocale: "he",
      requestText: "Plain English text in the current message.",
    });
    expect(policy.locale).toBe("he");
    expect(policy.source).toBe("explicit");
    expect(policy.enforceLocale).toBe(true);
  });
});
