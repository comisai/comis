// SPDX-License-Identifier: Apache-2.0
//
// DET-02 — the pure resolveReplyLanguage resolution-order matrix.
//
// Resolution order (design/multilingual-excellence.md §4 DET-02):
//   1. agents.<id>.language config value (tier-1, operator-set) → normalized.
//   2. USER.md preferred language (tier-2, already placeholder-filtered by the
//      call site's extractUserLanguage) → normalized.
//   3. Inbound message script (tier-3) — he/ar/ru ONLY, and ONLY on a STRICT
//      majority (>0.5) of NON-NEUTRAL codepoints. cjk maps to nothing.
//   4. "en" (the total floor — the resolver never throws).
//
// THE keystone (Pitfall 4): tier-3 uses scriptShares with a strict >0.5 check,
// NOT dominantScript's 0.30 non-Latin floor. A plurality-but-not-majority
// Hebrew message resolves to "en", never "he".
//
// These cases fail on the pre-patch tree (the module does not exist) — RED.

import { describe, it, expect } from "vitest";
import { resolveReplyLanguage } from "./resolve-reply-language.js";

describe("resolveReplyLanguage — tier-1 (agents.<id>.language config)", () => {
  it("config wins over USER.md and script (tier-1 precedence)", () => {
    // All three tiers point different ways; config must win.
    expect(
      resolveReplyLanguage({
        inboundText: "это сообщение на русском языке полностью", // all-Russian (tier-3 → ru)
        userMdLanguage: "Arabic", // tier-2 → ar
        configLanguage: "he", // tier-1 → he WINS
      }),
    ).toBe("he");
  });

  it("normalizes an English display name to its table key", () => {
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "Hebrew" })).toBe("he");
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "Arabic" })).toBe("ar");
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "Russian" })).toBe("ru");
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "English" })).toBe("en");
  });

  it("normalizes a BCP-47 region tag to its primary subtag", () => {
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "he-IL" })).toBe("he");
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "ar-EG" })).toBe("ar");
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "ru-RU" })).toBe("ru");
    // Case-insensitive primary subtag.
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "HE" })).toBe("he");
  });

  it("accepts the iw legacy alias for Hebrew", () => {
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "iw" })).toBe("he");
  });

  it("an unsupported config value falls through (does NOT short-circuit), reaching the en floor when no other tier matches", () => {
    // "fr" is not in the closed table → tier-1 yields nothing → tier-2 absent →
    // tier-3 (empty text) nothing → "en". Never throws.
    expect(resolveReplyLanguage({ inboundText: "", configLanguage: "fr" })).toBe("en");
  });

  it("an unsupported config value still lets a lower tier win (fall-through, not en-shortcut)", () => {
    // Unknown config "fr" must NOT force "en" — tier-3 all-Hebrew still resolves "he".
    expect(
      resolveReplyLanguage({ inboundText: "שלום עולם זהו טקסט עברי בלבד", configLanguage: "fr" }),
    ).toBe("he");
  });
});

describe("resolveReplyLanguage — tier-2 (USER.md preferred language)", () => {
  it("uses USER.md language when config is absent", () => {
    expect(resolveReplyLanguage({ inboundText: "", userMdLanguage: "Arabic" })).toBe("ar");
    expect(resolveReplyLanguage({ inboundText: "", userMdLanguage: "ar" })).toBe("ar");
    expect(resolveReplyLanguage({ inboundText: "", userMdLanguage: "Hebrew" })).toBe("he");
    expect(resolveReplyLanguage({ inboundText: "", userMdLanguage: "ru-RU" })).toBe("ru");
  });

  it("USER.md wins over the inbound script (tier-2 over tier-3)", () => {
    // All-Hebrew inbound (tier-3 → he) but USER.md says Arabic → ar.
    expect(
      resolveReplyLanguage({ inboundText: "שלום עולם זהו טקסט עברי", userMdLanguage: "Arabic" }),
    ).toBe("ar");
  });

  it("an unsupported USER.md value falls through to the script tier", () => {
    // USER.md "Klingon" is not in the table → fall through; all-Russian script → ru.
    expect(
      resolveReplyLanguage({
        inboundText: "это сообщение на русском языке",
        userMdLanguage: "Klingon",
      }),
    ).toBe("ru");
  });

  it("a USER.md value the call site already filtered to undefined falls through (resolver takes the value)", () => {
    // extractUserLanguage returns undefined for placeholder/empty values; the
    // resolver receives undefined → tier-2 contributes nothing.
    expect(resolveReplyLanguage({ inboundText: "", userMdLanguage: undefined })).toBe("en");
  });
});

describe("resolveReplyLanguage — tier-3 (inbound message script, strict >0.5 majority)", () => {
  it("resolves all-Hebrew text to he", () => {
    expect(resolveReplyLanguage({ inboundText: "שלום עולם זהו טקסט עברי בלבד" })).toBe("he");
  });

  it("resolves all-Arabic text to ar", () => {
    expect(resolveReplyLanguage({ inboundText: "مرحبا بالعالم هذا نص عربي فقط" })).toBe("ar");
  });

  it("resolves all-Russian Cyrillic text to ru", () => {
    expect(resolveReplyLanguage({ inboundText: "это полностью русский текст без латиницы" })).toBe(
      "ru",
    );
  });

  it("resolves plurality-but-not-majority Hebrew to en, not he (THE KEYSTONE, Pitfall 4)", () => {
    // Construct a string where Hebrew is the plurality of non-neutral codepoints
    // but NOT a strict majority. dominantScript (0.30 non-Latin floor) would
    // return "hebrew"; DET-02's strict >0.5 rule must fall through to "en".
    //
    // "שלום שלום docker test 12345":
    //   Hebrew letters (non-neutral): "שלום" + "שלום" = 8 letters
    //   Latin letters (non-neutral): "docker" (6) + "test" (4) = 10 letters
    //   Digits/spaces are NEUTRAL → excluded from the share denominator.
    //   Hebrew share = 8/18 ≈ 0.444 (≤ 0.5) → NO strict majority → fall through.
    const text = "שלום שלום docker test 12345";
    expect(resolveReplyLanguage({ inboundText: text })).toBe("en");
  });

  it("a bare-plurality Hebrew share just under 0.5 still resolves en (boundary, exclusive >)", () => {
    // 5 Hebrew letters vs 6 Latin letters → Hebrew share 5/11 ≈ 0.4545 ≤ 0.5 → en.
    // (Mirrors the script-classes.ts:243 'ספר על docker' fixture intuition.)
    expect(resolveReplyLanguage({ inboundText: "ספר על docker" })).toBe("en");
  });

  it("an exact 50/50 Hebrew/Latin split is NOT a strict majority → en", () => {
    // "שלום test" — 4 Hebrew letters, 4 Latin letters → share 0.5 exactly.
    // The check is strictly > 0.5, so 0.5 falls through to en.
    expect(resolveReplyLanguage({ inboundText: "שלום test" })).toBe("en");
  });

  it("cjk-dominant text → en (cjk maps to nothing), even at a >0.5 CJK share", () => {
    // All-Japanese: CJK share is 1.0 (>0.5) but cjk has no language mapping →
    // fall through to en. This is the explicit DET-02 'cjk → nothing' rule.
    expect(resolveReplyLanguage({ inboundText: "これはテストです" })).toBe("en");
  });

  it("a strong Hebrew majority over a little Latin still → he (above 0.5)", () => {
    // Many Hebrew letters + one short English tool name: Hebrew share > 0.5.
    expect(resolveReplyLanguage({ inboundText: "שלום עולם זהו טקסט עברי ארוך מאוד docker" })).toBe(
      "he",
    );
  });

  it("empty / whitespace / all-digit text with no config or USER.md → en", () => {
    expect(resolveReplyLanguage({ inboundText: "" })).toBe("en");
    expect(resolveReplyLanguage({ inboundText: "    \n\t  " })).toBe("en");
    expect(resolveReplyLanguage({ inboundText: "12345 67890 !!! ???" })).toBe("en");
  });

  it("resolves pure-English Latin text to en", () => {
    expect(resolveReplyLanguage({ inboundText: "this is a normal english sentence" })).toBe("en");
  });
});

describe("resolveReplyLanguage — totality (never throws, always a closed-set tag)", () => {
  it("returns one of en|he|ar|ru for any input combination", () => {
    const inputs: Array<{ inboundText: string; configLanguage?: string; userMdLanguage?: string }> =
      [
        { inboundText: "" },
        { inboundText: "שלום" },
        { inboundText: "مرحبا" },
        { inboundText: "привет" },
        { inboundText: "これは" },
        { inboundText: "mixed שלום text", configLanguage: "zzz" },
        { inboundText: "x", userMdLanguage: "" },
      ];
    for (const input of inputs) {
      const out = resolveReplyLanguage(input);
      expect(["en", "he", "ar", "ru"]).toContain(out);
    }
  });
});
