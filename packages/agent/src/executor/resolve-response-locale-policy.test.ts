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
      // Transport tier: resolved and offered as a hint, but never enforced.
      enforceLocale: false,
    });
  });

  it("returns unset for invalid or absent request hints instead of coercing script to English", () => {
    expect(resolveResponseLocalePolicy({ requestLocale: "not a locale" })).toEqual({
      source: "unset",
      enforceLocale: false,
    });
  });

  // The script-derived tier still INFERS the locale (it rides the prompt as a hint),
  // but it no longer ENFORCES it: inferring from the current message alone let a
  // single message switch a whole conversation's language and then burn a repair
  // round-trip fighting the model. Only an operator pin enforces.
  it("derives an open undetermined-language script tag from the current request text, ADVISORY only", () => {
    expect(resolveResponseLocalePolicy({ requestText: "اكتب ملخصًا قصيرًا" })).toEqual({
      locale: "und-Arab",
      source: "request",
      enforceLocale: false,
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
      policy: { locale: "fr-CA", source: "request", enforceLocale: false },
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

  it("ignores uppercase URLs when evaluating response prose script", () => {
    expect(evaluateResponseLocale(
      { locale: "ar-EG", source: "request", enforceLocale: true },
      "هذه إجابة عربية مفصلة تشرح النتيجة المطلوبة بصورة واضحة ومباشرة "
        + "HTTPS://example.com/this/is/an/english/url/path",
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
    // Advisory — the script-derived tier informs but never enforces.
    expect(policy.enforceLocale).toBe(false);
  });

  it("keeps the request locale when it agrees with the message script", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "מה מזג האוויר מחר בתל אביב?",
    });
    expect(policy.locale).toBe("he");
    expect(policy.source).toBe("request");
    // Agreeing with the message script makes the hint more likely RIGHT, not
    // more authoritative — it is still a device setting.
    expect(policy.enforceLocale).toBe(false);
  });

  it("prefers the current Latin prose script over a contradicting non-Latin transport locale (advisory)", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "What is the weather tomorrow in Tel Aviv?",
    });
    expect(policy.locale).toBe("und-Latn");
    expect(policy.source).toBe("request");
    expect(policy.enforceLocale).toBe(false);
  });

  it("does not treat a short Latin identifier as a conversation-language override", () => {
    expect(resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "npm test",
    })).toEqual({
      locale: "he",
      source: "request",
      enforceLocale: false,
    });
  });

  it("keeps the request locale when the message carries no script signal", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "",
    });
    expect(policy.locale).toBe("he");
    expect(policy.enforceLocale).toBe(false);
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

describe("an operator pin is the ONLY enforcer of response locale", () => {
  // Decision (owner, 2026-07-26): pin the operator's language; remove per-message
  // locale switching. Live, one English instruction inside an otherwise-Hebrew
  // conversation set `locale=en enforce=true`, and three repair passes each cost a
  // model call plus a prompt-cache break ($1.72) while the model correctly kept
  // answering in Hebrew.
  it("an English message in a Hebrew conversation does NOT enforce English", () => {
    const policy = resolveResponseLocalePolicy({
      requestText: "Install this skill: https://example.invalid/skills/xlsx",
    });
    expect(policy.enforceLocale).toBe(false);
  });

  it("an explicit operator pin DOES enforce, and outranks the message script", () => {
    const policy = resolveResponseLocalePolicy({
      explicitLocale: "he-IL",
      requestText: "Install this skill: https://example.invalid/skills/xlsx",
    });
    expect(policy.locale).toBe("he-IL");
    expect(policy.source).toBe("explicit");
    expect(policy.enforceLocale).toBe(true);
  });

  it("no pin and no script signal stays unset (nothing to enforce)", () => {
    expect(resolveResponseLocalePolicy({ requestText: "10978704" })).toEqual({
      source: "unset",
      enforceLocale: false,
    });
  });
});

describe("transport-tier locale is advisory, never enforced", () => {
  // Observed live: a Hebrew conversation ("שלום" → Hebrew reply, correctly, from
  // the ADVISORY und-Hebr script tier). The user's next message was an English
  // technical instruction, which does not contradict their Telegram client's
  // language_code of "en" — so the transport tier took over and, because it was
  // marked enforceLocale:true, outranked the conversation's own signal. The agent
  // switched to English mid-conversation.
  //
  // The asymmetry was the bug: a DEVICE SETTING enforced, while the conversation's
  // actual language was only ever advisory. This module already documents the
  // request tier as "TRANSPORT metadata … a device setting, not the conversation's
  // language" — so it must not be the strongest signal in the system. Only an
  // operator pin (`explicitLocale`, source "explicit") enforces.
  it("does not enforce a client UI language over the conversation", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "en",
      requestText: "Install this MCP:\nnpx -y some-mcp",
    });
    expect(policy.source).toBe("request");
    expect(policy.enforceLocale).toBe(false);
  });

  it("an operator pin still enforces and still outranks the device locale", () => {
    expect(resolveResponseLocalePolicy({
      explicitLocale: "he",
      requestLocale: "en",
      requestText: "Install this MCP",
    })).toEqual({ locale: "he", source: "explicit", enforceLocale: true });
  });

  it("a script-contradicting message still drops the device locale entirely", () => {
    // Unchanged behaviour: Hebrew text under an "en" device locale falls through
    // to the advisory script tier rather than being repaired toward English.
    expect(resolveResponseLocalePolicy({
      requestLocale: "en",
      requestText: "שלום, מה שלומך היום?",
    })).toEqual({ locale: "und-Hebr", source: "request", enforceLocale: false });
  });
});
