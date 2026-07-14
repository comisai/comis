// SPDX-License-Identifier: Apache-2.0
/**
 * degraded-reply-i18n — the en/he/ar/ru phrase table + tag-driven string
 * selectors for the deterministic degraded replies a failed turn shows the end
 * user.
 *
 * This is a THIN platform-strings catalog — NEVER agent prose. It mirrors the
 * LIVE `degraded-reply.ts` composition exactly: a context-exhausted base + a
 * 3-key cause lead + cause-specific recovery advice + the
 * output-starved annotation + the loop-detected reply.
 *
 * Invariants:
 *  - PURE: no I/O, no logging, no clock — same (lang, opts) → same string.
 *  - en byte-identical: the `en` row IS today's English literals — the
 *    single source from which `degraded-reply.ts` composes. No drift, no alias.
 *  - Fallback (never throws): an unknown language (or a missing entry) maps to
 *    the `en` row — `TABLE[normalizeKey(lang)] ?? TABLE.en`.
 *  - User-facing: replies describe actions a chat user can take and never expose
 *    raw configuration paths. The `(incident <traceId>)` ref and warning marker
 *    (U+26A0 U+FE0F) remain verbatim so an operator can correlate the failure.
 *  - No Trojan-Source: NO phrase-table string carries a bidi control
 *    codepoint. RTL strings (he/ar) keep incident references on clause
 *    boundaries and use no inline directional controls.
 *
 * @module
 */

import type { ContextExhaustionCause } from "../context-engine/errors.js";

/**
 * Internal map retained for diagnostics that need to associate a capability
 * class with its operator setting. User-visible replies never interpolate these
 * raw paths.
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
 * Every value is a plain string, which keeps the bidi-scan walk simple.
 */
export interface DegradedReplyStrings {
  /** Lead sentence for the context-exhausted reply. */
  contextExhaustedBase: string;
  /** The cause-specific lead, keyed by the 3 ContextExhaustionCause values. */
  causeLead: Record<ContextExhaustionCause, string>;
  /** Capability-profile advice, default form. */
  capKnobAdviceDefault: string;
  /** Capability-profile advice, oversized-history form. */
  capKnobAdviceHistory: string;
  /** Knob-present advice, fixed-overhead form: the system prompt + tools alone
   *  overflow, so "narrowing the ask" is meaningless — the remedy is the window /
   *  tool footprint / a larger model. NEVER suggests shortening the message. */
  capKnobAdviceFixedOverhead: string;
  /** Generic advice, default form. */
  genericAdviceDefault: string;
  /** Generic advice, oversized-history form. */
  genericAdviceHistory: string;
  /** Generic advice, fixed-overhead form (window / tools / larger model). */
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
    "I couldn't complete that request because this conversation exceeded the model's context limit. ",
  causeLead: {
    oversized_input:
      "This message is too large for the selected model. Shorten it or split it into smaller parts. ",
    oversized_history_message:
      "An earlier message is too large for the selected model. Start a new session, then try again. ",
    fixed_overhead_exceeds_window:
      "The selected model does not have enough context capacity for this agent's instructions and tools. ",
    aggregate: "",
  },
  capKnobAdviceDefault:
    "Try a more focused request, disable tools this agent does not need, or choose a model with a larger context window.",
  capKnobAdviceHistory: "If this keeps happening, choose a model with a larger context window.",
  capKnobAdviceFixedOverhead:
    "Disable tools this agent does not need or choose a model with a larger context window.",
  genericAdviceDefault:
    "Try a more focused request, disable tools this agent does not need, or choose a model with a larger context window.",
  genericAdviceHistory: "If this keeps happening, choose a model with a larger context window.",
  genericAdviceFixedOverhead:
    "Disable tools this agent does not need or choose a model with a larger context window.",
  outputStarvedAnnotation:
    "\n\n⚠️ My response was cut short by the model's output limit. Try a more focused request or choose a model with a larger output limit.",
  loopDetected:
    "I stopped because I kept repeating an action that wasn't making progress " +
    "(usually a tool that failed or was blocked) and didn't want to loop. The " +
    "request may need a different approach, or that capability isn't available here.",
};

// ---------------------------------------------------------------------------
// he — Hebrew. Authored translations keep the incident reference on a clause
// boundary and preserve the warning emoji. No inline bidi controls.
// ---------------------------------------------------------------------------
const HE: DegradedReplyStrings = {
  contextExhaustedBase: "לא הצלחתי להשלים את הבקשה כי השיחה חרגה ממגבלת ההקשר של המודל. ",
  causeLead: {
    oversized_input:
      "ההודעה הזו גדולה מדי עבור המודל שנבחר. קצר אותה או פצל אותה לחלקים קטנים יותר. ",
    oversized_history_message:
      "הודעה קודמת גדולה מדי עבור המודל שנבחר. פתח שיחה חדשה ונסה שוב. ",
    fixed_overhead_exceeds_window:
      "למודל שנבחר אין מספיק קיבולת הקשר להוראות ולכלים של הסוכן. ",
    aggregate: "",
  },
  capKnobAdviceDefault: "נסה בקשה ממוקדת יותר, השבת כלים שהסוכן אינו צריך, או בחר מודל עם חלון הקשר גדול יותר.",
  capKnobAdviceHistory: "אם זה ממשיך לקרות, בחר מודל עם חלון הקשר גדול יותר.",
  capKnobAdviceFixedOverhead: "השבת כלים שהסוכן אינו צריך או בחר מודל עם חלון הקשר גדול יותר.",
  genericAdviceDefault: "נסה בקשה ממוקדת יותר, השבת כלים שהסוכן אינו צריך, או בחר מודל עם חלון הקשר גדול יותר.",
  genericAdviceHistory: "אם זה ממשיך לקרות, בחר מודל עם חלון הקשר גדול יותר.",
  genericAdviceFixedOverhead: "השבת כלים שהסוכן אינו צריך או בחר מודל עם חלון הקשר גדול יותר.",
  outputStarvedAnnotation:
    "\n\n⚠️ התשובה שלי נקטעה בגלל מגבלת הפלט של המודל. נסה בקשה ממוקדת יותר או בחר מודל עם מגבלת פלט גדולה יותר.",
  loopDetected:
    "עצרתי כי חזרתי שוב ושוב על פעולה שלא קידמה דבר (בדרך כלל כלי שנכשל או נחסם) ולא רציתי להיכנס ללולאה. " +
    "ייתכן שהבקשה דורשת גישה אחרת, או שהיכולת הזו אינה זמינה כאן.",
};

// ---------------------------------------------------------------------------
// ar — Arabic. Authored translations keep the incident reference on a clause
// boundary and preserve the warning emoji. No inline bidi controls.
// ---------------------------------------------------------------------------
const AR: DegradedReplyStrings = {
  contextExhaustedBase: "تعذّر عليّ إكمال الطلب لأن المحادثة تجاوزت حد سياق النموذج. ",
  causeLead: {
    oversized_input:
      "هذه الرسالة كبيرة جداً على النموذج المحدد. اختصرها أو قسّمها إلى أجزاء أصغر. ",
    oversized_history_message:
      "إحدى الرسائل السابقة كبيرة جداً على النموذج المحدد. ابدأ جلسة جديدة ثم حاول مرة أخرى. ",
    fixed_overhead_exceeds_window:
      "لا يملك النموذج المحدد سعة سياق كافية لتعليمات الوكيل وأدواته. ",
    aggregate: "",
  },
  capKnobAdviceDefault: "جرّب طلباً أكثر تحديداً، وعطّل الأدوات التي لا يحتاجها الوكيل، أو اختر نموذجاً بنافذة سياق أكبر.",
  capKnobAdviceHistory: "إذا استمرت المشكلة، فاختر نموذجاً بنافذة سياق أكبر.",
  capKnobAdviceFixedOverhead: "عطّل الأدوات التي لا يحتاجها الوكيل أو اختر نموذجاً بنافذة سياق أكبر.",
  genericAdviceDefault: "جرّب طلباً أكثر تحديداً، وعطّل الأدوات التي لا يحتاجها الوكيل، أو اختر نموذجاً بنافذة سياق أكبر.",
  genericAdviceHistory: "إذا استمرت المشكلة، فاختر نموذجاً بنافذة سياق أكبر.",
  genericAdviceFixedOverhead: "عطّل الأدوات التي لا يحتاجها الوكيل أو اختر نموذجاً بنافذة سياق أكبر.",
  outputStarvedAnnotation:
    "\n\n⚠️ اقتُطعت إجابتي بسبب حد إخراج النموذج. جرّب طلباً أكثر تحديداً أو اختر نموذجاً بحد إخراج أكبر.",
  loopDetected:
    "توقفت لأنني كررت إجراءً لم يحرز أي تقدم (عادةً أداة فشلت أو حُجبت) ولم أرغب في الدخول في حلقة. " +
    "قد يحتاج الطلب إلى نهج مختلف، أو أن هذه الإمكانية غير متاحة هنا.",
};

// ---------------------------------------------------------------------------
// ru — Russian. Authored translations; technical tokens verbatim. (Cyrillic is
// not RTL, but the same placeholder discipline applies.)
// ---------------------------------------------------------------------------
const RU: DegradedReplyStrings = {
  contextExhaustedBase: "Не удалось выполнить запрос: эта беседа превысила лимит контекста модели. ",
  causeLead: {
    oversized_input:
      "Это сообщение слишком велико для выбранной модели. Сократите его или разделите на несколько частей. ",
    oversized_history_message:
      "Одно из предыдущих сообщений слишком велико для выбранной модели. Начните новую сессию и попробуйте снова. ",
    fixed_overhead_exceeds_window:
      "У выбранной модели недостаточно контекста для инструкций и инструментов этого агента. ",
    aggregate: "",
  },
  capKnobAdviceDefault: "Попробуйте более конкретный запрос, отключите ненужные агенту инструменты или выберите модель с большим окном контекста.",
  capKnobAdviceHistory: "Если проблема повторяется, выберите модель с большим окном контекста.",
  capKnobAdviceFixedOverhead: "Отключите ненужные агенту инструменты или выберите модель с большим окном контекста.",
  genericAdviceDefault: "Попробуйте более конкретный запрос, отключите ненужные агенту инструменты или выберите модель с большим окном контекста.",
  genericAdviceHistory: "Если проблема повторяется, выберите модель с большим окном контекста.",
  genericAdviceFixedOverhead: "Отключите ненужные агенту инструменты или выберите модель с большим окном контекста.",
  outputStarvedAnnotation:
    "\n\n⚠️ Мой ответ был обрезан из-за ограничения вывода модели. Попробуйте более конкретный запрос или выберите модель с большим лимитом вывода.",
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
 * fallback). Composes via the same nested cause and capability-profile branches
 * as the live builder: base + causeLead[cause] + advice + incidentRef. Raw configuration
 * paths remain internal; the incident ref is appended verbatim.
 */
export function selectContextExhaustedReply(
  lang: string,
  opts: SelectContextExhaustedOpts,
): string {
  const t = strings(lang);
  const cause: ContextExhaustionCause = opts.cause ?? "aggregate";
  // "narrowing the ask" only belongs when the ask/aggregate is the
  // problem — for an oversized history message it is the misleading clause.
  // For fixed_overhead_exceeds_window the message
  // size is irrelevant entirely, so the advice points at the window / tool
  // footprint / a larger model — never "shorten your message" or "narrow the ask".
  let advice: string;
  const hasCapabilityProfile =
    opts.capabilityClass !== undefined && CAP_KNOB_BY_CLASS[opts.capabilityClass] !== undefined;
  if (hasCapabilityProfile) {
    advice =
      cause === "fixed_overhead_exceeds_window"
        ? t.capKnobAdviceFixedOverhead
        : cause === "oversized_history_message"
          ? t.capKnobAdviceHistory
          : t.capKnobAdviceDefault;
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
