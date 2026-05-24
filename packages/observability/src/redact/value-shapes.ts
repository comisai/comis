// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle-time value-shape redactors (Phase 5 D9, REDACT-01).
 *
 * The 11 patterns target the bundle export pipeline — distinct from
 * the Pino-level credential patterns in patterns.ts (which carry
 * different sentinel shape — edge-keeping masks, not `<REDACTED:type>`).
 *
 * Application contract:
 *   - redactString applies all 11 patterns to a string leaf.
 *   - walkAndRedactStrings recurses through arrays/objects, redacting
 *     string leaves and leaving numbers/booleans/null untouched. This
 *     prevents false positives on number-typed timestamps and counts
 *     (landmine §7.1 from 05-RESEARCH.md).
 *   - redactEventForExport wraps walkAndRedactStrings for a TrajectoryEvent's
 *     `data` field, returning a new event with envelope fields preserved.
 *     Returns the event reference unchanged when `data` is undefined.
 *
 * Pattern ordering: shape-anchored patterns (aws-access-key-id, jwt,
 * url-userinfo, url-param, email, long-decimal-id, basic-auth,
 * cookie-header) run BEFORE field-name patterns (secret-field,
 * payload-field, identifier-field) so a literal "Authorization: Basic …"
 * is caught by basic-auth first, with the residual "Authorization"
 * substring caught by the field-name pass.
 *
 * Performance: all replacements go through replacePatternBounded for
 * ReDoS protection (CHUNK_SIZE=16384, SINGLE_PASS_THRESHOLD=32768).
 * Worst-case 11 patterns × bounded regex backtracking per event = O(n).
 *
 * @module
 */

import { replacePatternBounded } from "./regex-bounded.js";
import type { TrajectoryEvent } from "../trajectory/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single value-shape redaction pattern with its sentinel. */
export interface ValueShapePattern {
  /** Unique identifier, also embedded in the sentinel: `<REDACTED:${id}>`. */
  readonly id: string;
  /** The compiled regex. Must carry the `g` flag. */
  readonly regex: RegExp;
  /** The literal replacement string: exactly `<REDACTED:${id}>`. */
  readonly sentinel: string;
}

/**
 * Options for path substitution at bundle export time (REDACT-02, Plan 05-03).
 * Declared here so redactEventForExport's signature is forward-compatible.
 * The fields are not used by this module — they are consumed by the path
 * substitution primitive that Plan 05-03 will wire into the pipeline.
 */
export interface RedactionOpts {
  /** Agent workspace directory path (longest; substituted first). */
  readonly workspaceDir?: string;
  /** User home directory path. */
  readonly homeDir?: string;
  /** Comis state directory path (e.g., ~/.comis). */
  readonly stateDir?: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions (verbatim from OBSERVABILITY_DESIGN.md §5 D9 /
// 05-CONTEXT.md decision 4 — 11 patterns)
// ---------------------------------------------------------------------------

/**
 * The 11 value-shape patterns, each producing a `<REDACTED:${id}>` sentinel.
 *
 * Field-name patterns (secret-field, payload-field, identifier-field):
 * Apply to string contents without `^...$` anchors — they catch substring
 * mentions in body text (e.g., "my password is foo" → "<REDACTED:secret-field>
 * is foo"). See 05-PLAN.md Reading A decision.
 *
 * Shape-anchored patterns use `\b...\b` word boundaries for precision.
 *
 * Order within this array is implementation-internal; the exported
 * ORDERED_PATTERNS const applies shape-anchored patterns first.
 */
const PATTERNS: ReadonlyArray<ValueShapePattern> = Object.freeze([
  {
    id: "secret-field",
    regex: /(authorization|cookie|credential|key|password|secret|token)/gi,
    sentinel: "<REDACTED:secret-field>",
  },
  {
    id: "payload-field",
    regex:
      /(body|chat|content|error|header|instruction|message|payload|prompt|result|text|tool|transcript)/gi,
    sentinel: "<REDACTED:payload-field>",
  },
  {
    id: "identifier-field",
    regex:
      /(account[-_]?id|chat[-_]?id|conversation[-_]?id|email|message[-_]?id|phone|thread[-_]?id|user[-_]?id|username)/gi,
    sentinel: "<REDACTED:identifier-field>",
  },
  {
    id: "aws-access-key-id",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    sentinel: "<REDACTED:aws-access-key-id>",
  },
  {
    id: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    sentinel: "<REDACTED:jwt>",
  },
  {
    id: "url-userinfo",
    // eslint-disable-next-line no-useless-escape -- verbatim from OBSERVABILITY_DESIGN.md §5 D9
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)([^\/@\s:?#]+)(?::([^\/@\s?#]+))?@/gi,
    sentinel: "<REDACTED:url-userinfo>",
  },
  {
    id: "url-param",
    regex: /([?&])([^=&\s]+)=([^&#\s]+)/g,
    sentinel: "<REDACTED:url-param>",
  },
  {
    id: "email",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    sentinel: "<REDACTED:email>",
  },
  {
    id: "long-decimal-id",
    regex: /\b\d{9,}\b/g,
    sentinel: "<REDACTED:long-decimal-id>",
  },
  {
    id: "basic-auth",
    regex: /\bBasic\s+[A-Za-z0-9+/]+=*/g,
    sentinel: "<REDACTED:basic-auth>",
  },
  {
    id: "cookie-header",
    regex: /\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
    sentinel: "<REDACTED:cookie-header>",
  },
]);

/**
 * Pattern application order: shape-anchored patterns run before field-name
 * patterns so structured credentials are caught at the most-specific level
 * first, with field-name patterns mopping up residual keyword text.
 */
const ORDERED_PATTERNS: ReadonlyArray<ValueShapePattern> = (() => {
  const fieldIds = new Set<string>(["secret-field", "payload-field", "identifier-field"]);
  const shape = PATTERNS.filter((p) => !fieldIds.has(p.id));
  const field = PATTERNS.filter((p) => fieldIds.has(p.id));
  return Object.freeze([...shape, ...field]);
})();

/**
 * Placeholder that stands in for already-placed sentinels during a
 * redactString pass. We replace `<REDACTED:*>` tokens with a non-matching
 * placeholder before applying field-name patterns, then restore them.
 *
 * This prevents the field-name patterns from corrupting sentinel text
 * (e.g., "key" inside "<REDACTED:aws-access-key-id>" would otherwise
 * be caught by the secret-field pattern on the second pass).
 */
const SENTINEL_PLACEHOLDER_RE = /<REDACTED:[^>]+>/g;
const PLACEHOLDER_PREFIX = "\x00REDACTED_";
const PLACEHOLDER_SUFFIX = "\x00";

/**
 * Encode all existing `<REDACTED:...>` sentinels in `s` to placeholder
 * tokens so field-name patterns cannot corrupt them.
 *
 * Uses replacePatternBounded for ReDoS safety.
 */
function encodeSentinels(s: string): { encoded: string; tokens: string[] } {
  const tokens: string[] = [];
  const encoded = replacePatternBounded(s, SENTINEL_PLACEHOLDER_RE, (match) => {
    const idx = tokens.length;
    tokens.push(match);
    return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_SUFFIX}`;
  });
  return { encoded, tokens };
}

/**
 * Restore placeholder tokens back to their original sentinel strings.
 *
 * Uses replacePatternBounded for ReDoS safety.
 */
function decodeSentinels(s: string, tokens: string[]): string {
  const DECODE_RE = new RegExp(
    `${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`,
    "g",
  );
  return replacePatternBounded(s, DECODE_RE, (_, idx: string) => tokens[Number(idx)] ?? "");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the frozen array of all 11 value-shape patterns.
 * Each pattern has `id`, `regex`, and `sentinel` fields.
 * The sentinel is exactly `<REDACTED:${id}>`.
 *
 * Use this accessor in tests to iterate patterns by id (REDACT-03 fixture
 * completeness check).
 */
export function getValueShapePatterns(): ReadonlyArray<ValueShapePattern> {
  return PATTERNS;
}

/**
 * Apply all 11 value-shape patterns to a single string, returning the
 * redacted string with `<REDACTED:type>` sentinels replacing each match.
 *
 * Shape-anchored patterns are applied before field-name patterns.
 * All replacements go through `replacePatternBounded` (ReDoS guard).
 *
 * Sentinel protection: before applying field-name patterns (which use
 * unanchored substring regexes), existing `<REDACTED:...>` sentinels are
 * encoded to NUL-delimited placeholders so field-name patterns cannot
 * corrupt them (e.g., "key" inside `<REDACTED:aws-access-key-id>` would
 * otherwise be matched by the secret-field pattern).
 *
 * @param value - the string to redact
 * @returns the redacted string
 */
export function redactString(value: string): string {
  const fieldIds = new Set<string>(["secret-field", "payload-field", "identifier-field"]);

  let out = value;

  // Pass 1: shape-anchored patterns (no sentinel corruption risk — they use \b boundaries).
  for (const p of ORDERED_PATTERNS) {
    if (!fieldIds.has(p.id)) {
      out = replacePatternBounded(out, p.regex, p.sentinel);
    }
  }

  // Pass 2: field-name patterns — protect existing sentinels first.
  const { encoded, tokens } = encodeSentinels(out);
  let encodedOut = encoded;
  for (const p of ORDERED_PATTERNS) {
    if (fieldIds.has(p.id)) {
      encodedOut = replacePatternBounded(encodedOut, p.regex, p.sentinel);
    }
  }
  out = decodeSentinels(encodedOut, tokens);

  return out;
}

/**
 * Pure-data walker. Recurses through arrays and plain objects, applying
 * `redactString` to every string-typed leaf. Numbers, booleans, null,
 * and undefined pass through unchanged.
 *
 * Cycle detection via a `WeakSet<object>`. Back-edges return
 * `{ __cycle: true }` instead of throwing or infinite-recursing.
 *
 * Returns a new value graph — the input is never mutated.
 *
 * @param value - any JavaScript value
 * @param seen - internal WeakSet for cycle detection (callers omit this)
 * @returns the redacted copy of `value` with the same shape
 */
export function walkAndRedactStrings(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  // Numbers, booleans, bigints, symbols — pass through untouched.
  if (typeof value !== "object") return value;

  const obj = value as object;
  if (seen.has(obj)) return { __cycle: true };
  seen.add(obj);

  if (Array.isArray(obj)) {
    return (obj as unknown[]).map((v) => walkAndRedactStrings(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = walkAndRedactStrings(v, seen);
  }
  return out;
}

/**
 * Walk `event.data`, apply the 11 value-shape patterns to every
 * string-typed leaf, and return a new event with the redacted data.
 * Envelope fields (`ts`, `seq`, `traceId`, `sessionId`, etc.) are
 * byte-equal pre/post — only `data` is transformed.
 *
 * Returns the event reference unchanged when `event.data` is undefined.
 *
 * The `opts` parameter is reserved for path substitution (REDACT-02,
 * Plan 05-03) and is unused here.
 *
 * @param event - a TrajectoryEvent whose data field will be redacted
 * @param opts - path substitution hints (reserved, not yet consumed)
 * @returns a new TrajectoryEvent with redacted data, or the original event
 */
export function redactEventForExport(
  event: TrajectoryEvent,
  _opts: RedactionOpts = {},
): TrajectoryEvent {
  if (event.data === undefined) return event;
  const redactedData = walkAndRedactStrings(event.data) as Record<string, unknown>;
  return { ...event, data: redactedData };
}
