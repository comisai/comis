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

  it("enforces an open script tag from clear current-request prose", () => {
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

  // A response with NO script-bearing characters cannot satisfy ANY script
  // requirement, so enforcing one throws away a correct answer. `dominantScript`
  // defaults to "latin" when the share map is empty, so a bare number reads as
  // Latin and fails a Hebrew/Greek/Arabic target on every repair attempt.
  //
  // Measured live on comis-moshe (claude-opus-5): asked "give me one number: how
  // many vehicles in total?", the agent answered with the number and the user
  // received "I couldn't produce an answer in the requested language and script…
  // choose a model that supports it" instead. Log:
  // locale=und-Hebr expectedScript=Hebr actualScript=Latn, after a failed repair.
  it("does not enforce a script on a response that carries no script at all", () => {
    for (const response of ["161", "  161  ", "<b>161</b> 🚗", "162 / 161 = 1.006", "42%"]) {
      expect(
        evaluateResponseLocale({ locale: "und-Hebr", source: "request", enforceLocale: true }, response),
        `script-free response must be exempt: ${response}`,
      ).toBeUndefined();
    }
  });

  it("still enforces the script once the response carries real prose", () => {
    // Negative control: the exemption must not become a blanket bypass — a
    // numeric answer WITH Latin prose is a genuine mismatch against Hebrew.
    expect(evaluateResponseLocale(
      { locale: "und-Hebr", source: "request", enforceLocale: true },
      "161 vehicles are currently moving.",
    )).toEqual(expect.objectContaining({
      kind: "locale_script_mismatch",
      expectedScript: "Hebr",
      actualScript: "Latn",
    }));
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
    expect(policy.enforceLocale).toBe(true);
  });

  it("uses clear current prose instead of a matching device locale", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "מה מזג האוויר מחר בתל אביב?",
    });
    expect(policy.locale).toBe("und-Hebr");
    expect(policy.source).toBe("request");
    expect(policy.enforceLocale).toBe(true);
  });

  it("prefers and enforces clear current Latin prose over a contradicting device locale", () => {
    const policy = resolveResponseLocalePolicy({
      requestLocale: "he",
      requestText: "What is the weather tomorrow in Tel Aviv?",
    });
    expect(policy.locale).toBe("und-Latn");
    expect(policy.source).toBe("request");
    expect(policy.enforceLocale).toBe(true);
  });

  it("switches back to Latin prose immediately after a non-Latin conversation turn", () => {
    expect(resolveResponseLocalePolicy({
      requestLocale: "en",
      requestText: "ok and the weather?",
    })).toEqual({
      locale: "und-Latn",
      source: "request",
      enforceLocale: true,
    });
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

describe("clear prose and operator pins are the enforcing locale tiers", () => {
  it("a short technical fragment does not enforce its incidental script", () => {
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

// ---------------------------------------------------------------------------
// Batched messages
//
// A turn can coalesce several inbound messages. The prose threshold qualifies a
// message as a language signal; summing word counts across independent messages
// manufactures evidence that none of them individually carries. Two
// sub-threshold command pastes must not add up to an enforced script.
// ---------------------------------------------------------------------------

describe("batched request messages are qualified individually", () => {
  // Verbatim from the production incident: two consecutive install pastes, each
  // correctly sub-threshold on its own, coalesced into one turn.
  const SKILL_PASTE = "Install this skill: https://example.invalid/skills/xlsx";
  const MCP_PASTE = [
    "Install this MCP:",
    "npx -y some-mcp,",
    '"SOME_USERNAME": "u",',
    '"SOME_PASSWORD": "p",',
    '"SOME_GLOBAL_BASE_URL": "https://api.example.invalid/api/v2"',
  ].join("\n");
  const HEBREW_PROSE = "אני גר בישראל, רם-און, דובר עברית";

  it("does not enforce a script that no single batched message justifies", () => {
    // Each paste alone stays unset (pinned above); batched they must not sum
    // into an enforced Latin locale, which is what produced a romanized reply.
    expect(resolveResponseLocalePolicy({ requestTexts: [SKILL_PASTE, MCP_PASTE] }).enforceLocale)
      .toBe(false);
  });

  it("keeps the conversation script when only command pastes follow it", () => {
    // The Hebrew message is the only real prose in the batch, so it — not the
    // concatenation's dominant script — decides the reply script.
    expect(resolveResponseLocalePolicy({
      requestTexts: [HEBREW_PROSE, SKILL_PASTE, MCP_PASTE],
    })).toEqual({ locale: "und-Hebr", source: "request", enforceLocale: true });
  });

  it("takes the most recent batched message that carries a real signal", () => {
    // Documented precedence: the current request outranks earlier turns.
    expect(resolveResponseLocalePolicy({
      requestTexts: [HEBREW_PROSE, "Please summarize what happened here this week."],
    })).toEqual({ locale: "und-Latn", source: "request", enforceLocale: true });
  });

  it("still enforces when a batched message is genuine prose", () => {
    expect(resolveResponseLocalePolicy({
      requestTexts: [SKILL_PASTE, HEBREW_PROSE],
    })).toEqual({ locale: "und-Hebr", source: "request", enforceLocale: true });
  });

  it("falls back to the single requestText when no batch is supplied", () => {
    expect(resolveResponseLocalePolicy({ requestText: HEBREW_PROSE }))
      .toEqual({ locale: "und-Hebr", source: "request", enforceLocale: true });
  });
});

describe("transport-tier locale is advisory, never enforced", () => {
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
    expect(resolveResponseLocalePolicy({
      requestLocale: "en",
      requestText: "שלום, מה שלומך היום?",
    })).toEqual({ locale: "und-Hebr", source: "request", enforceLocale: true });
  });
});

// ---------------------------------------------------------------------------
// Script fused INSIDE a word
// ---------------------------------------------------------------------------

/**
 * The foreign-script check requires a minimum SHARE (15%) and a minimum unit COUNT (8). Both are
 * right for bulk foreign text, and both are structurally blind to a few characters fused into a
 * single token: three foreign letters inside a long reply clear neither threshold.
 *
 * Live: under `enforce="true"` for a Hebrew response locale, a reply opened with `אبدأ` — one
 * Hebrew letter followed by the Arabic أبدأ — and enforcement reported no mismatch while claiming
 * to enforce. A fused token is not prose: legitimately quoting a foreign name puts it in its own
 * word, it does not weld two scripts inside one. So intra-word fusion is a signal that needs no
 * share threshold at all, which is exactly why the thresholds could not see it.
 */
describe("evaluateResponseLocale — intra-word script fusion", () => {
  it("reports a mismatch for a token welding two non-Latin scripts, whatever its share", () => {
    const finding = evaluateResponseLocale(
      { locale: "he-IL", source: "explicit", enforceLocale: true },
      // One fused token in an otherwise wholly Hebrew reply: ~3 foreign chars, far under both
      // the 15% share and the 8-unit floor.
      "אبدأ בבדיקת הנתונים ואחזור עם סיכום מסודר על כל הרכבים במערכת הזאת בהקדם האפשרי",
    );

    expect(finding).toEqual(expect.objectContaining({
      kind: "locale_script_mismatch",
      expectedScript: "Hebr",
      actualScript: "Arab",
    }));
  });

  it("leaves a legitimately quoted foreign word alone", () => {
    // Its own token, not fused — this is real prose and must not be flagged, which is what the
    // share/unit thresholds exist to protect.
    expect(evaluateResponseLocale(
      { locale: "he-IL", source: "explicit", enforceLocale: true },
      "הדוח מזכיר את השם أحمد ואת שאר הנתונים שנאספו במהלך הבדיקה הזאת על הרכבים",
    )).toBeUndefined();
  });

  it("does not flag a word mixing a non-Latin script with Latin characters", () => {
    // Latin mixes into non-Latin prose constantly (identifiers, units, URLs) and is already
    // handled by the prose-share rule; treating it as fusion would flag ordinary text.
    expect(evaluateResponseLocale(
      { locale: "he-IL", source: "explicit", enforceLocale: true },
      "הבדיקה הסתיימה בהצלחה ומספר הרכבים הוא 162 לפי הדוח שהופק במערכת הזאת כולה",
    )).toBeUndefined();
  });

  it("does not report the offending text itself in the finding", () => {
    const finding = evaluateResponseLocale(
      { locale: "he-IL", source: "explicit", enforceLocale: true },
      "אبدأ בבדיקת הנתונים ואחזור עם סיכום מסודר על כל הרכבים במערכת הזאת בהקדם האפשרי",
    );

    // The finding is a quality signal that rides telemetry; it carries counts and scripts, never
    // the response body.
    expect(JSON.stringify(finding)).not.toContain("אبدأ");
  });
});
