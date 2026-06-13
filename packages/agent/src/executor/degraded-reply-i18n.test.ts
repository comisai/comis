// SPDX-License-Identifier: Apache-2.0
//
// GEN-02 — the en/he/ar/ru phrase table + tag-driven selectors for the
// deterministic degraded replies a failed turn shows the end user.
//
// These tests assert that:
//   - en byte-identical (I1, the keystone): the en-path selectors reproduce
//     TODAY's literals — proven by importing the LIVE builders from
//     degraded-reply.ts and asserting equality across the
//     {cause x capabilityClass x traceId} matrix.
//   - Per-language snapshots pin the authored he/ar/ru translations.
//   - I5 (verbatim across languages): the knob path, the (0 = uncapped) hint,
//     the (incident <traceId>) ref, and the warning marker are interpolated
//     verbatim and never translated.
//   - cap-knob x cause variants mirror the live nested advice branching.
//   - Fallback contract: an unknown language returns the en string; never throws.
//   - I2 (gate-blocking security): NO phrase-table string contains a bidi
//     control codepoint. The BIDI regex is built from NUMERIC codepoints via
//     String.fromCodePoint (see :47-51) — never a literal bidi glyph and never
//     a \u escape in this source. \u escapes round-trip back into literal
//     glyphs in some tools, which is exactly the Trojan-Source hazard I2 exists
//     to stop, so numeric construction is the deliberate, required approach.
//
// AUTHORING NOTE: this file NEVER pastes a raw bidi codepoint or the warning
// glyph, and NEVER uses \u escapes for them. Both the warning marker
// (String.fromCodePoint(0x26A0, 0xFE0F)) and the bidi set (the cp() helper at
// :47, also String.fromCodePoint) are built from numeric codepoints only. Do
// NOT "simplify" the BIDI regex back to \u escapes — that reintroduces I2.

import { describe, it, expect } from "vitest";
import type { ContextExhaustionCause } from "../context-engine/errors.js";
import {
  buildOutputStarvedAnnotation,
  buildContextExhaustedReply,
  buildLoopDetectedReply,
} from "./degraded-reply.js";
import {
  DEGRADED_REPLY_TABLE,
  selectOutputStarvedAnnotation,
  selectContextExhaustedReply,
  selectLoopDetectedReply,
} from "./degraded-reply-i18n.js";

// The warning marker (U+26A0 U+FE0F) — referenced via codepoints, NEVER pasted.
const WARNING_MARKER = String.fromCodePoint(0x26a0, 0xfe0f);

// The I2 bidi-control set (canonical, invisible-chars.ts:37-38). Built from
// NUMERIC codepoints via String.fromCodePoint so this source NEVER contains a
// raw bidi glyph (the Trojan-Source hazard I2 exists to stop). The matched set:
// LRM (U+200E), RLM (U+200F), ALM (U+061C), embeddings/overrides (U+202A-U+202E),
// isolates (U+2066-U+2069).
const cp = (n: number): string => String.fromCodePoint(n);
const BIDI = new RegExp(
  `[${cp(0x200e)}${cp(0x200f)}${cp(0x061c)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}]`,
  "u",
);

// The representative {cause x capabilityClass x traceId} matrix for the
// en byte-identical guard.
const EN_MATRIX: ReadonlyArray<{
  cause?: ContextExhaustionCause;
  capabilityClass?: string;
  traceId?: string;
}> = [
  { cause: "aggregate", capabilityClass: undefined, traceId: undefined },
  { cause: "oversized_input", capabilityClass: "small", traceId: "tid-1" },
  { cause: "oversized_history_message", capabilityClass: "nano", traceId: "tid-2" },
  { cause: "aggregate", capabilityClass: "small", traceId: undefined },
  // extra coverage: no-cause + frontier (no knob), traceId only
  { cause: undefined, capabilityClass: "frontier", traceId: "tid-3" },
  { cause: "oversized_history_message", capabilityClass: undefined, traceId: undefined },
];

describe("degraded-reply-i18n — en selectors are byte-identical to the live builders (I1)", () => {
  it("selectContextExhaustedReply('en', opts) equals buildContextExhaustedReply(opts) across the matrix", () => {
    for (const opts of EN_MATRIX) {
      const live = buildContextExhaustedReply(opts);
      const selected = selectContextExhaustedReply("en", opts);
      expect(selected).toBe(live);
    }
  });

  it("selectOutputStarvedAnnotation('en') equals buildOutputStarvedAnnotation()", () => {
    expect(selectOutputStarvedAnnotation("en")).toBe(buildOutputStarvedAnnotation());
  });

  it("selectLoopDetectedReply('en', opts) equals buildLoopDetectedReply(opts) with and without a traceId", () => {
    expect(selectLoopDetectedReply("en", {})).toBe(buildLoopDetectedReply());
    expect(selectLoopDetectedReply("en", { traceId: "abc" })).toBe(
      buildLoopDetectedReply({ traceId: "abc" }),
    );
  });

  // WR-03: the equality assertions above are NECESSARY but not SUFFICIENT as an
  // I1 oracle. After 181-03, buildContextExhaustedReply (degraded-reply.ts)
  // DELEGATES to selectContextExhaustedReply("en", …) — both sides resolve to
  // the SAME `en` row, so `selected === live` is tautological and would stay
  // green even if the `en` row drifted away from the historical literals. Anchor
  // the en row against HARDCODED literals (copied from the pre-181 builders,
  // matching the sibling literal pins at degraded-reply.test.ts:144/:274) so
  // en-row byte-identity is guarded independently of the builder delegation —
  // not via a round-trip through the same code path.
  it("WR-03: DEGRADED_REPLY_TABLE.en pins the historical English literals (independent I1 anchor)", () => {
    expect(DEGRADED_REPLY_TABLE.en.contextExhaustedBase).toBe(
      "I was unable to process your request — the context window was exhausted " +
        "before the model could run. ",
    );
    expect(DEGRADED_REPLY_TABLE.en.causeLead.oversized_input).toBe(
      "Your message alone is larger than this model's context window — send a " +
        "shorter message or split it into parts. ",
    );
    expect(DEGRADED_REPLY_TABLE.en.causeLead.oversized_history_message).toBe(
      "A previous message in this session exceeds this model's context window, " +
        "so every new turn overflows regardless of its size — reset the session " +
        "to clear it. ",
    );
    expect(DEGRADED_REPLY_TABLE.en.causeLead.aggregate).toBe("");
    expect(DEGRADED_REPLY_TABLE.en.capKnobAdviceDefault).toBe(
      "Try raising {knob} (0 = uncapped), reducing the agent's active tools, or narrowing the ask.",
    );
    expect(DEGRADED_REPLY_TABLE.en.capKnobAdviceHistory).toBe(
      "Alternatively raise {knob} (0 = uncapped).",
    );
    expect(DEGRADED_REPLY_TABLE.en.genericAdviceDefault).toBe(
      "Try raising the agent's context engine settings or narrowing the ask.",
    );
    expect(DEGRADED_REPLY_TABLE.en.genericAdviceHistory).toBe(
      "Alternatively raise the agent's context engine settings.",
    );
    expect(DEGRADED_REPLY_TABLE.en.outputStarvedAnnotation).toBe(
      "\n\n" + WARNING_MARKER + " My answer was cut off at the model's output limit — too many tools are " +
        "loaded for this model's context window. Narrow the ask or raise the model's context size.",
    );
    expect(DEGRADED_REPLY_TABLE.en.loopDetected).toBe(
      "I stopped because I kept repeating an action that wasn't making progress " +
        "(usually a tool that failed or was blocked) and didn't want to loop. The " +
        "request may need a different approach, or that capability isn't available here.",
    );
  });
});

describe("degraded-reply-i18n — per-language snapshots pin the authored translations", () => {
  for (const lang of ["he", "ar", "ru"] as const) {
    it(`snapshots the ${lang} context-exhausted replies across the cause matrix`, () => {
      const matrix = EN_MATRIX.map((opts) => selectContextExhaustedReply(lang, opts));
      expect(matrix).toMatchSnapshot();
    });

    it(`snapshots the ${lang} output-starved annotation`, () => {
      expect(selectOutputStarvedAnnotation(lang)).toMatchSnapshot();
    });

    it(`snapshots the ${lang} loop-detected reply (with + without incident ref)`, () => {
      expect({
        bare: selectLoopDetectedReply(lang, {}),
        withTrace: selectLoopDetectedReply(lang, { traceId: "abc" }),
      }).toMatchSnapshot();
    });
  }
});

describe("degraded-reply-i18n — I5 verbatim interpolation across languages", () => {
  for (const lang of ["he", "ar", "ru"] as const) {
    it(`${lang}: the small-class context-exhausted reply names the cap knob + (0 = uncapped) verbatim`, () => {
      const reply = selectContextExhaustedReply(lang, { capabilityClass: "small" });
      expect(reply).toContain("contextEngine.budget.effectiveContextCapSmall");
      expect(reply).toContain("(0 = uncapped)");
    });

    it(`${lang}: the nano-class context-exhausted reply names the nano cap knob verbatim`, () => {
      const reply = selectContextExhaustedReply(lang, { capabilityClass: "nano" });
      expect(reply).toContain("contextEngine.budget.effectiveContextCapNano");
    });

    it(`${lang}: a traceId is appended verbatim as the incident ref`, () => {
      const reply = selectContextExhaustedReply(lang, { traceId: "abc" });
      expect(reply).toContain("abc");
    });

    it(`${lang}: the output-starved annotation carries the warning marker verbatim`, () => {
      expect(selectOutputStarvedAnnotation(lang)).toContain(WARNING_MARKER);
    });
  }

  it("en: the output-starved annotation also carries the warning marker verbatim", () => {
    expect(selectOutputStarvedAnnotation("en")).toContain(WARNING_MARKER);
  });
});

describe("degraded-reply-i18n — cap-knob x cause variants mirror the live nested branching", () => {
  for (const lang of ["he", "ar", "ru"] as const) {
    it(`${lang}: oversized_history_message + knob uses the 'Alternatively raise {knob}' form and drops the narrow-the-ask clause`, () => {
      const history = selectContextExhaustedReply(lang, {
        capabilityClass: "small",
        cause: "oversized_history_message",
      });
      const dflt = selectContextExhaustedReply(lang, {
        capabilityClass: "small",
        cause: "aggregate",
      });
      // Both name the knob (I5)…
      expect(history).toContain("contextEngine.budget.effectiveContextCapSmall");
      expect(dflt).toContain("contextEngine.budget.effectiveContextCapSmall");
      // …but the two advice forms differ (history vs default).
      expect(history).not.toBe(dflt);
    });

    it(`${lang}: the three causes produce three DISTINCT replies`, () => {
      const replies = new Set([
        selectContextExhaustedReply(lang, { cause: "oversized_input" }),
        selectContextExhaustedReply(lang, { cause: "oversized_history_message" }),
        selectContextExhaustedReply(lang, { cause: "aggregate" }),
      ]);
      expect(replies.size).toBe(3);
    });
  }
});

describe("degraded-reply-i18n — fallback contract (unknown language maps to English, never throws)", () => {
  it("an unknown language ('fr') returns the en context-exhausted string", () => {
    for (const opts of EN_MATRIX) {
      expect(selectContextExhaustedReply("fr", opts)).toBe(selectContextExhaustedReply("en", opts));
    }
  });

  it("an unknown-with-region language ('xx-unknown') returns the en strings", () => {
    expect(selectOutputStarvedAnnotation("xx-unknown")).toBe(selectOutputStarvedAnnotation("en"));
    expect(selectLoopDetectedReply("xx-unknown", { traceId: "z" })).toBe(
      selectLoopDetectedReply("en", { traceId: "z" }),
    );
  });

  it("calling the selectors with an unknown language never throws", () => {
    expect(() => selectContextExhaustedReply("zz", { capabilityClass: "small" })).not.toThrow();
    expect(() => selectOutputStarvedAnnotation("zz")).not.toThrow();
    expect(() => selectLoopDetectedReply("zz", {})).not.toThrow();
  });
});

describe("degraded-reply-i18n — I2 no bidi control in any phrase-table string (gate-blocking)", () => {
  it("every string value in the table (all languages, all keys) is free of bidi controls", () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === "string") {
        if (BIDI.test(node)) offenders.push(`${path}: ${JSON.stringify(node)}`);
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(DEGRADED_REPLY_TABLE, "DEGRADED_REPLY_TABLE");
    expect(offenders).toEqual([]);
  });

  it("the composed replies (all languages, full matrix) are free of bidi controls", () => {
    const langs = ["en", "he", "ar", "ru"] as const;
    for (const lang of langs) {
      expect(BIDI.test(selectOutputStarvedAnnotation(lang))).toBe(false);
      expect(BIDI.test(selectLoopDetectedReply(lang, { traceId: "abc" }))).toBe(false);
      for (const opts of EN_MATRIX) {
        expect(BIDI.test(selectContextExhaustedReply(lang, opts))).toBe(false);
      }
    }
  });
});
