// SPDX-License-Identifier: Apache-2.0
/**
 * degraded-reply-i18n — the en/he/ar/ru phrase table + tag-driven string
 * selectors for the deterministic degraded replies a failed turn shows the end
 * user.
 *
 * This is a THIN platform-strings catalog — NEVER agent prose. It mirrors the
 * LIVE `degraded-reply.ts` composition exactly: a context-exhausted base + a
 * 3-key cause lead + a 2-variant
 * cap-knob advice (history vs default) + a 2-variant no-knob advice + the
 * output-starved annotation + the loop-detected reply.
 *
 * Invariants:
 *  - PURE: no I/O, no logging, no clock — same (lang, opts) → same string.
 *  - en byte-identical: the `en` row IS today's English literals — the
 *    single source from which `degraded-reply.ts` composes. No drift, no alias.
 *  - Fallback (never throws): an unknown language (or a missing entry) maps to
 *    the `en` row — `TABLE[normalizeKey(lang)] ?? TABLE.en`.
 *  - Verbatim across languages: the knob path
 *    (`contextEngine.budget.effectiveContextCap{Small,Nano}`), the
 *    `(0 = uncapped)` operator hint, the `(incident <traceId>)` ref, and the
 *    warning marker (U+26A0 U+FE0F) are interpolated VERBATIM — never translated
 *    — so the operator's remedy knob is correct in every language.
 *  - No Trojan-Source: NO phrase-table string carries a bidi control
 *    codepoint. RTL strings (he/ar) are authored with the technical tokens
 *    (`{knob}`, `{traceId}`) on clause boundaries and NO inline directional
 *    controls. This source NEVER contains a raw bidi glyph.
 *
 * @module
 */

import type { ContextExhaustionCause } from "../context-engine/errors.js";

/**
 * small/nano classes name the EXACT cap knob the
 * operator must raise; other classes get the generic advice (no class cap
 * applies). The SINGLE home for this map — `degraded-reply.ts` imports it back
 * (no copy, no alias). Interpolated VERBATIM into every language.
 */
export const CAP_KNOB_BY_CLASS: Record<string, string> = {
  small: "contextEngine.budget.effectiveContextCapSmall",
  nano: "contextEngine.budget.effectiveContextCapNano",
};

/** The closed set of reply-language table keys (mirrors resolveReplyLanguage's ReplyLanguage). */
export const LANG_KEYS = ["en", "he", "ar", "ru"] as const;
export type LangKey = (typeof LANG_KEYS)[number];

/**
 * One language's strings, mirroring the LIVE `degraded-reply.ts` composition.
 * Every value is a plain string (keeps the bidi-scan walk simple). The two advice
 * templates carry a literal `{knob}` placeholder the selector interpolates with
 * the resolved `CAP_KNOB_BY_CLASS` value (VERBATIM).
 */
export interface DegradedReplyStrings {
  /** Lead sentence for the context-exhausted reply. */
  contextExhaustedBase: string;
  /** The cause-specific lead, keyed by the 3 ContextExhaustionCause values. */
  causeLead: Record<ContextExhaustionCause, string>;
  /** Knob-present advice, default form ("Try raising {knob} …, reducing tools, or narrowing the ask"). */
  capKnobAdviceDefault: string;
  /** Knob-present advice, oversized-history form ("Alternatively raise {knob} (0 = uncapped)."). */
  capKnobAdviceHistory: string;
  /** Knob-present advice, fixed-overhead form: the system prompt + tools alone
   *  overflow, so "narrowing the ask" is meaningless — the remedy is the window /
   *  tool footprint / a larger model. NEVER suggests shortening the message. */
  capKnobAdviceFixedOverhead: string;
  /** No-knob advice, default form (the generic advice when no class cap applies). */
  genericAdviceDefault: string;
  /** No-knob advice, oversized-history form. */
  genericAdviceHistory: string;
  /** No-knob advice, fixed-overhead form (window / tools / larger model). */
  genericAdviceFixedOverhead: string;
  /** The output-starved annotation (APPENDED to truncated partial text). */
  outputStarvedAnnotation: string;
  /** The loop-detected reply (APPEND/REPLACE for a no-progress halt). */
  loopDetected: string;
}

// ---------------------------------------------------------------------------
// en — the single source of the English literals (the byte-identical contract):
// the `degraded-reply.ts` builders compose from this row. The "⚠️" below is the warning emoji
// (U+26A0 U+FE0F) — ALLOWED (not in the bidi set) and preserved across languages.
// ---------------------------------------------------------------------------
const EN: DegradedReplyStrings = {
  contextExhaustedBase:
    "I was unable to process your request — the context window was exhausted " +
    "before the model could run. ",
  causeLead: {
    oversized_input:
      "Your message alone is larger than this model's context window — send a " +
      "shorter message or split it into parts. ",
    oversized_history_message:
      "A previous message in this session exceeds this model's context window, " +
      "so every new turn overflows regardless of its size — reset the session " +
      "to clear it. ",
    fixed_overhead_exceeds_window:
      "This model's context window is too small for the agent's system prompt " +
      "and tools — the fixed overhead overflows before your message is even " +
      "considered, so the size of your message makes no difference. ",
    aggregate: "",
  },
  capKnobAdviceDefault:
    "Try raising {knob} (0 = uncapped), reducing the agent's active tools, or narrowing the ask.",
  capKnobAdviceHistory: "Alternatively raise {knob} (0 = uncapped).",
  capKnobAdviceFixedOverhead:
    "Raise {knob} (0 = uncapped) or the model's context window, reduce the agent's active tools, or use a model with a larger context window.",
  genericAdviceDefault: "Try raising the agent's context engine settings or narrowing the ask.",
  genericAdviceHistory: "Alternatively raise the agent's context engine settings.",
  genericAdviceFixedOverhead:
    "Raise the model's context window, reduce the agent's active tools, or use a model with a larger context window.",
  outputStarvedAnnotation:
    "\n\n⚠️ My answer was cut off at the model's output limit — too many tools are " +
    "loaded for this model's context window. Narrow the ask or raise the model's context size.",
  loopDetected:
    "I stopped because I kept repeating an action that wasn't making progress " +
    "(usually a tool that failed or was blocked) and didn't want to loop. The " +
    "request may need a different approach, or that capability isn't available here.",
};

// ---------------------------------------------------------------------------
// he — Hebrew. Authored translations; technical tokens ({knob}/{traceId}) on
// clause boundaries; the warning emoji + (0 = uncapped) verbatim. NO inline
// bidi controls.
// ---------------------------------------------------------------------------
const HE: DegradedReplyStrings = {
  contextExhaustedBase: "לא הצלחתי לעבד את הבקשה שלך — חלון ההקשר מוצה לפני שהמודל הספיק לרוץ. ",
  causeLead: {
    oversized_input:
      "ההודעה שלך לבדה גדולה מחלון ההקשר של המודל הזה — שלח הודעה קצרה יותר או פצל אותה לחלקים. ",
    oversized_history_message:
      "הודעה קודמת בשיחה הזו חורגת מחלון ההקשר של המודל, ולכן כל תור חדש עולה על גדותיו ללא תלות בגודלו — אפס את השיחה כדי לנקות אותה. ",
    fixed_overhead_exceeds_window:
      "חלון ההקשר של המודל הזה קטן מדי עבור הנחיית המערכת והכלים של הסוכן — התקורה הקבועה עולה על גדותיה עוד לפני שההודעה שלך נלקחת בחשבון, ולכן גודל ההודעה אינו משנה. ",
    aggregate: "",
  },
  capKnobAdviceDefault: "נסה להעלות את {knob} (0 = uncapped), לצמצם את הכלים הפעילים של הסוכן, או לצמצם את הבקשה.",
  capKnobAdviceHistory: "לחלופין העלה את {knob} (0 = uncapped).",
  capKnobAdviceFixedOverhead: "העלה את {knob} (0 = uncapped) או את חלון ההקשר של המודל, צמצם את הכלים הפעילים של הסוכן, או השתמש במודל עם חלון הקשר גדול יותר.",
  genericAdviceDefault: "נסה להעלות את הגדרות מנוע ההקשר של הסוכן או לצמצם את הבקשה.",
  genericAdviceHistory: "לחלופין העלה את הגדרות מנוע ההקשר של הסוכן.",
  genericAdviceFixedOverhead: "הגדל את חלון ההקשר של המודל, צמצם את הכלים הפעילים של הסוכן, או השתמש במודל עם חלון הקשר גדול יותר.",
  outputStarvedAnnotation:
    "\n\n⚠️ התשובה שלי נקטעה במגבלת הפלט של המודל — נטענו יותר מדי כלים עבור חלון ההקשר של המודל הזה. " +
    "צמצם את הבקשה או הגדל את גודל ההקשר של המודל.",
  loopDetected:
    "עצרתי כי חזרתי שוב ושוב על פעולה שלא קידמה דבר (בדרך כלל כלי שנכשל או נחסם) ולא רציתי להיכנס ללולאה. " +
    "ייתכן שהבקשה דורשת גישה אחרת, או שהיכולת הזו אינה זמינה כאן.",
};

// ---------------------------------------------------------------------------
// ar — Arabic. Authored translations; technical tokens on clause boundaries;
// warning emoji + (0 = uncapped) verbatim. NO inline bidi controls.
// ---------------------------------------------------------------------------
const AR: DegradedReplyStrings = {
  contextExhaustedBase: "تعذّر عليّ معالجة طلبك — استُنفدت نافذة السياق قبل أن يتمكن النموذج من العمل. ",
  causeLead: {
    oversized_input:
      "رسالتك وحدها أكبر من نافذة السياق لهذا النموذج — أرسل رسالة أقصر أو قسّمها إلى أجزاء. ",
    oversized_history_message:
      "رسالة سابقة في هذه الجلسة تتجاوز نافذة السياق لهذا النموذج، لذا يفيض كل دور جديد بغض النظر عن حجمه — أعد ضبط الجلسة لمسحها. ",
    fixed_overhead_exceeds_window:
      "نافذة السياق لهذا النموذج صغيرة جداً على موجّه نظام الوكيل وأدواته — يفيض الحِمل الثابت قبل أخذ رسالتك بعين الاعتبار، لذا لا يهم حجم رسالتك. ",
    aggregate: "",
  },
  capKnobAdviceDefault: "حاول رفع {knob} (0 = uncapped)، أو تقليل الأدوات النشطة للوكيل، أو تضييق الطلب.",
  capKnobAdviceHistory: "بدلاً من ذلك ارفع {knob} (0 = uncapped).",
  capKnobAdviceFixedOverhead: "ارفع {knob} (0 = uncapped) أو نافذة سياق النموذج، أو قلّل الأدوات النشطة للوكيل، أو استخدم نموذجاً بنافذة سياق أكبر.",
  genericAdviceDefault: "حاول رفع إعدادات محرك السياق للوكيل أو تضييق الطلب.",
  genericAdviceHistory: "بدلاً من ذلك ارفع إعدادات محرك السياق للوكيل.",
  genericAdviceFixedOverhead: "زِد نافذة سياق النموذج، أو قلّل الأدوات النشطة للوكيل، أو استخدم نموذجاً بنافذة سياق أكبر.",
  outputStarvedAnnotation:
    "\n\n⚠️ اقتُطعت إجابتي عند حد الإخراج للنموذج — حُمّلت أدوات كثيرة جداً على نافذة السياق لهذا النموذج. " +
    "ضيّق الطلب أو زِد حجم سياق النموذج.",
  loopDetected:
    "توقفت لأنني كررت إجراءً لم يحرز أي تقدم (عادةً أداة فشلت أو حُجبت) ولم أرغب في الدخول في حلقة. " +
    "قد يحتاج الطلب إلى نهج مختلف، أو أن هذه الإمكانية غير متاحة هنا.",
};

// ---------------------------------------------------------------------------
// ru — Russian. Authored translations; technical tokens verbatim. (Cyrillic is
// not RTL, but the same placeholder discipline applies.)
// ---------------------------------------------------------------------------
const RU: DegradedReplyStrings = {
  contextExhaustedBase: "Не удалось обработать ваш запрос — окно контекста было исчерпано до того, как модель смогла запуститься. ",
  causeLead: {
    oversized_input:
      "Само ваше сообщение больше окна контекста этой модели — отправьте более короткое сообщение или разбейте его на части. ",
    oversized_history_message:
      "Предыдущее сообщение в этой сессии превышает окно контекста модели, поэтому каждый новый ход переполняется независимо от его размера — сбросьте сессию, чтобы очистить его. ",
    fixed_overhead_exceeds_window:
      "Окно контекста этой модели слишком мало для системного промпта и инструментов агента — фиксированные накладные расходы переполняют его ещё до того, как учитывается ваше сообщение, поэтому его размер не имеет значения. ",
    aggregate: "",
  },
  capKnobAdviceDefault: "Попробуйте увеличить {knob} (0 = uncapped), сократить активные инструменты агента или сузить запрос.",
  capKnobAdviceHistory: "Либо увеличьте {knob} (0 = uncapped).",
  capKnobAdviceFixedOverhead: "Увеличьте {knob} (0 = uncapped) или окно контекста модели, сократите активные инструменты агента или используйте модель с бо́льшим окном контекста.",
  genericAdviceDefault: "Попробуйте увеличить настройки движка контекста агента или сузить запрос.",
  genericAdviceHistory: "Либо увеличьте настройки движка контекста агента.",
  genericAdviceFixedOverhead: "Увеличьте окно контекста модели, сократите активные инструменты агента или используйте модель с бо́льшим окном контекста.",
  outputStarvedAnnotation:
    "\n\n⚠️ Мой ответ был обрезан на пределе вывода модели — для окна контекста этой модели загружено слишком много инструментов. " +
    "Сузьте запрос или увеличьте размер контекста модели.",
  loopDetected:
    "Я остановился, потому что повторял действие, не дававшее результата (обычно инструмент, который не срабатывал или был заблокирован), и не хотел зациклиться. " +
    "Запросу может потребоваться другой подход, либо эта возможность здесь недоступна.",
};

/** The phrase table — the single source for every degraded-reply string. */
export const DEGRADED_REPLY_TABLE: Record<LangKey, DegradedReplyStrings> = {
  en: EN,
  he: HE,
  ar: AR,
  ru: RU,
};

/**
 * Normalize a (possibly arbitrary) language tag to a closed table key. The
 * caller (`resolveReplyLanguage`) already emits the closed en|he|ar|ru
 * set, so this is a defensive second gate: lowercase + primary subtag; anything
 * outside the four supported languages falls back to "en". NEVER throws.
 */
function normalizeKey(lang: string): LangKey {
  const primary = lang.trim().toLowerCase().split("-")[0] ?? "";
  switch (primary) {
    case "he":
    case "iw":
      return "he";
    case "ar":
      return "ar";
    case "ru":
      return "ru";
    default:
      return "en";
  }
}

/** Resolve a language's strings, falling back to the en row (never throws). */
function strings(lang: string): DegradedReplyStrings {
  // normalizeKey already collapses unknowns to "en"; the `?? en` is belt-and-suspenders.
  return DEGRADED_REPLY_TABLE[normalizeKey(lang)] ?? DEGRADED_REPLY_TABLE.en;
}

/** Build the `(incident <traceId>)` ref VERBATIM across languages, or "". */
function incidentRef(traceId?: string): string {
  return traceId !== undefined && traceId.length > 0 ? ` (incident ${traceId})` : "";
}

/**
 * The output-starved annotation to APPEND to truncated partial text, in the
 * requested language (en fallback). Carries the warning marker verbatim.
 */
export function selectOutputStarvedAnnotation(lang: string): string {
  return strings(lang).outputStarvedAnnotation;
}

/** Opts for {@link selectContextExhaustedReply} — mirrors the live builder opts. */
export interface SelectContextExhaustedOpts {
  capabilityClass?: string;
  traceId?: string;
  cause?: ContextExhaustionCause;
}

/**
 * The synthesized context-exhausted reply in the requested language (en
 * fallback). Composes via the SAME nested cause x knob branching as the live
 * builder: base + causeLead[cause] + advice + incidentRef. The knob value, the
 * `(0 = uncapped)` hint, and the incident ref are interpolated VERBATIM.
 */
export function selectContextExhaustedReply(
  lang: string,
  opts: SelectContextExhaustedOpts,
): string {
  const t = strings(lang);
  const cause: ContextExhaustionCause = opts.cause ?? "aggregate";
  const knob =
    opts.capabilityClass !== undefined ? CAP_KNOB_BY_CLASS[opts.capabilityClass] : undefined;
  // "narrowing the ask" only belongs when the ask/aggregate is the
  // problem — for an oversized history message it is the misleading clause.
  // For fixed_overhead_exceeds_window the message
  // size is irrelevant entirely, so the advice points at the window / tool
  // footprint / a larger model — never "shorten your message" or "narrow the ask".
  let advice: string;
  if (knob !== undefined) {
    advice =
      cause === "fixed_overhead_exceeds_window"
        ? t.capKnobAdviceFixedOverhead.replace("{knob}", knob)
        : cause === "oversized_history_message"
          ? t.capKnobAdviceHistory.replace("{knob}", knob)
          : t.capKnobAdviceDefault.replace("{knob}", knob);
  } else {
    advice =
      cause === "fixed_overhead_exceeds_window"
        ? t.genericAdviceFixedOverhead
        : cause === "oversized_history_message"
          ? t.genericAdviceHistory
          : t.genericAdviceDefault;
  }
  // eslint-disable-next-line security/detect-object-injection -- cause is a closed ContextExhaustionCause union (defaulted to "aggregate"), never user-controlled
  return t.contextExhaustedBase + t.causeLead[cause] + advice + incidentRef(opts.traceId);
}

/** Opts for {@link selectLoopDetectedReply}. */
export interface SelectLoopDetectedOpts {
  traceId?: string;
}

/**
 * The honest loop-detected reply in the requested language (en fallback), with
 * the incident ref appended verbatim.
 */
export function selectLoopDetectedReply(lang: string, opts: SelectLoopDetectedOpts): string {
  return strings(lang).loopDetected + incidentRef(opts.traceId);
}
