// SPDX-License-Identifier: Apache-2.0
/**
 * redactValue — the pure, bounded redaction primitive.
 *
 * This is the ONLY sanctioned path from raw tool `params` to user-visible
 * activity text. It lives in
 * `core/security` — NOT `core/activity` and NOT `observability` — because the
 * pure template engine (`core/activity/template-engine.ts`) must
 * call it and `core` cannot import `observability`.
 *
 * Guarantees (the redaction keystone):
 *   - No secrets: values under the 9 Pino redact keys become
 *     `<redacted>`; values matching a secret SHAPE (sk_*, ghp_*, AKIA*, JWT
 *     triples, provider tokens) become `<redacted>` even under a benign key.
 *   - No absolute paths: `$HOME`/home roots compact to `~`; other
 *     system-absolute paths compact to their last 2 segments (compacted, NOT
 *     stripped — preserving the intended `~/.comis/...` UX). IP / hostname /
 *     MAC masked.
 *   - No PII: email / phone / credit-card / SSN shapes masked.
 *
 * The replacement token is the lowercase-angle `<redacted>` — deliberately
 * distinct from the log sanitizer's bracketed-uppercase token, so output
 * always shows WHICH layer redacted a value.
 *
 * It is PURE: no `eval`, no `Function`, no dynamic require, no logger, no I/O,
 * no input mutation. It NEVER throws. The observability layer reads
 * `redactionsApplied` post-call and emits the redaction WARN; this primitive does
 * not log.
 *
 * Bounds: recursive descent is capped at depth ≤ 4, keys ≤ 16 per
 * level, arrays ≤ 32 elements, total ≤ 4 KB. Exceeding a bound truncates with a
 * corresponding `redactionsApplied` entry — it does not hang or throw. A
 * `WeakSet` cycle guard prevents infinite recursion; a length guard mirrors the
 * log sanitizer's `MAX_SANITIZE_LENGTH` ReDoS protection.
 *
 * @module
 */

import {
  ANTHROPIC_API_KEY,
  OPENAI_PROJECT_KEY,
  SK_API_KEY,
  TELEGRAM_BOT_TOKEN,
  AWS_KEY_ID_BOUNDED,
  STRIPE_KEY,
  GOOGLE_API_KEY,
  SLACK_APP_TOKEN,
  SENDGRID_KEY,
  JWT_PATTERN,
  HEX_SECRET_LONG,
  FAL_KEY,
  GITHUB_TOKEN_FULL,
  DISCORD_BOT_TOKEN,
  BEARER_TOKEN_LOG,
  URL_PASSWORD,
  AWS_SECRET_KEY,
} from "./injection-patterns.js";
// Re-exported so the containment guard can compare the activity shape list
// against the log sanitizer's credential list from a single import site.
import { CREDENTIAL_LOG_PATTERNS } from "./patterns/credential-log.js";

export { CREDENTIAL_LOG_PATTERNS };

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The single replacement token. Lowercase-angle — NOT the bracketed-uppercase log token (keeps the redacting layer identifiable). */
const REDACTED = "<redacted>";

/**
 * Limits enforced during recursive descent. Frozen so callers cannot
 * mutate the shared default.
 */
export const REDACT_LIMITS = Object.freeze({
  /** Maximum recursive object/array depth before truncating. */
  maxDepth: 4,
  /** Maximum object keys retained at any single level. */
  maxKeysPerLevel: 16,
  /** Maximum array elements retained. */
  maxArrayLength: 32,
  /** Serialized-byte budget for the whole value; exceeding it truncates. */
  maxTotalBytes: 4096,
} as const);

/** Frozen-default type so `RedactOptions.limits` accepts the const-asserted shape. */
export type RedactLimits = typeof REDACT_LIMITS;

/**
 * Why a particular value (or subtree) was redacted or truncated.
 *
 * Closed union — never widened to `string` (AGENTS.md §2.8). The PII / bound
 * variants form a fixed reason vocabulary consumed downstream;
 * `network_identifier` extends it for the IP/hostname/MAC masks.
 */
export type RedactionReason =
  | "secret_key"
  | "secret_shape"
  | "pii_email"
  | "pii_phone"
  | "pii_credit_card"
  | "pii_ssn"
  | "absolute_path"
  | "network_identifier"
  | "depth_exceeded"
  | "keys_exceeded"
  | "array_truncated"
  | "bytes_exceeded";

/** A single redaction record: the offending key (or path hint) and the reason. */
export interface RedactionRecord {
  /** The object key whose value was redacted, or a structural hint (e.g. `<string>`). */
  readonly key: string;
  /** Why the value was redacted or truncated. */
  readonly reason: RedactionReason;
}

/** The result of {@link redactValue}: the safe value plus structured metadata. */
export interface RedactedValue {
  /** The safe-to-render value (string/number/boolean/null/array/object). */
  value: unknown;
  /** Every redaction or truncation applied during the walk. */
  redactionsApplied: readonly RedactionRecord[];
  /** True when any limit (depth/keys/array/bytes) was hit and the value was truncated. */
  truncated: boolean;
}

/** Options for {@link redactValue}. Pure — the caller injects the env-derived home dir. */
export interface RedactOptions {
  /** The `$HOME` compaction root (e.g. `systemGetEnv("HOME")`). Compacted to `~`. */
  homeDir?: string;
  /** Override the default {@link REDACT_LIMITS} (tests / callers with tighter budgets). */
  limits?: RedactLimits;
}

// ---------------------------------------------------------------------------
// Detection constants
// ---------------------------------------------------------------------------

/**
 * The 9 secret KEYS (case-insensitive) — mirrors the CLAUDE.md "Pino
 * auto-redacts" taxonomy. A value under any of these is fully replaced
 * regardless of its content (key-based).
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "apikey",
  "token",
  "password",
  "secret",
  "authorization",
  "bottoken",
  "privatekey",
  "cookie",
  "webhooksecret",
]);

/**
 * Secret-SHAPE regexes reused from `injection-patterns.ts`. We borrow the
 * detection PATTERNS only — the replacement is our own `<redacted>` token.
 * All carry the `g` flag, so `lastIndex` is reset before use.
 *
 * MUST stay a superset of the log sanitizer's `CREDENTIAL_LOG_PATTERNS`
 * (re-exported below) — a credential shape covered by the log sanitizer but
 * missing here would survive verbatim into a user-visible activity label under
 * a benign key. The containment test in `redact-value.test.ts` enforces it
 * by pattern `.source`.
 *
 * Exported for that containment guard test only — not part of the public API
 * surface (this is an internal detection constant).
 */
export const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  ANTHROPIC_API_KEY,
  OPENAI_PROJECT_KEY,
  SK_API_KEY,
  STRIPE_KEY,
  GITHUB_TOKEN_FULL,
  AWS_KEY_ID_BOUNDED,
  JWT_PATTERN,
  GOOGLE_API_KEY,
  SLACK_APP_TOKEN,
  SENDGRID_KEY,
  TELEGRAM_BOT_TOKEN,
  DISCORD_BOT_TOKEN,
  HEX_SECRET_LONG,
  // FAL key shape `<uuid>:<hex>` — mirror the log sanitizer so
  // a FAL credential under a benign activity key is masked here too.
  FAL_KEY,
  // The three shapes the log sanitizer (CREDENTIAL_LOG_PATTERNS) covers
  // that the activity redactor must not omit. Without these, a secret-shaped
  // value under a benign allowlisted key (url/cmd/note) reaches the rendered
  // label verbatim. BEARER_TOKEN_LOG and AWS_SECRET_KEY are simple-match
  // patterns. URL_PASSWORD is a capturing-group pattern (`://user:pw@`); a bare
  // `.replace(pat, "<redacted>")` (applyShape) masks the WHOLE match span, so
  // the captured password is removed (the host stays masked by HOSTNAME_RE).
  BEARER_TOKEN_LOG,
  AWS_SECRET_KEY,
  URL_PASSWORD,
];

// PII / network shapes (local — these masks are not in injection-patterns.ts).
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Credit-card-shaped: 4 groups of 4 digits, optional spaces/hyphens. Run BEFORE phone.
const CREDIT_CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
// SSN-shaped: 3-2-4 digit groups.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// Phone-shaped: optional +, then 7+ digits possibly separated by space/-/(). Run AFTER CC/SSN.
// Alphanumeric BOUNDARIES: a phone number is a STANDALONE numeric run (real phones in text are
// always flanked by whitespace/punctuation/start/end). Without the boundaries PHONE_RE matched a
// digit SUBSTRING embedded in an alphanumeric token — e.g. the `50414984` inside a hex tool-call id
// `fc_0df8…ded50414984b629.json` — and redacted the middle of a NON-secret filename (comis-harel
// 2026-07-12). The lookarounds exclude digit runs abutting a letter/digit (hex ids, base64, …) while
// preserving every standard phone format in free text.
const PHONE_RE = /(?<![A-Za-z0-9])\+?\d[\d ()\-.]{6,}\d(?![A-Za-z0-9])/g;
// IPv4 dotted quad.
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// MAC address (colon- or hyphen-separated hex octets).
const MAC_RE = /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g;
// Hostname-shaped: ≥ 3 dot-separated labels ending in an alpha TLD (≥ 2 chars),
// e.g. `db-primary.internal.example.com`. Requiring ≥ 3 labels avoids matching
// two-segment filenames like `config.yaml` / `bar.ts` (those are paths/leaves,
// not hosts). Run AFTER email/IP so those more-specific shapes win first.
//
// `(?<!\/\/)` negative-lookbehind exempts URL hosts (preceded by
// the scheme's two slashes) from this mask. Public URL hosts are
// information the user expects to see — `tavily.com/search` renders verbatim —
// not internal infrastructure leakage. Standalone hostnames not inside a URL
// (e.g. an internal `db-primary.internal.example.com` reference in a log line)
// remain masked as defense-in-depth.
const HOSTNAME_RE =
  /(?<!\/\/)\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.){2,}[a-zA-Z]{2,}\b/g;

/** Length guard mirroring `log-sanitizer.ts` `MAX_SANITIZE_LENGTH` — ReDoS protection. */
const MAX_SANITIZE_LENGTH = 1_048_576;

// ---------------------------------------------------------------------------
// String redaction
// ---------------------------------------------------------------------------

/**
 * Run one global pattern against `input`. If it matches, replace every match
 * with `<redacted>`, record `reason`, and return the new string; otherwise
 * return the input untouched. Resets `lastIndex` first (the regexes are global
 * and therefore stateful).
 */
function applyShape(
  input: string,
  pattern: RegExp,
  reason: RedactionReason,
  sink: RedactionRecord[],
): string {
  pattern.lastIndex = 0;
  if (!pattern.test(input)) return input;
  pattern.lastIndex = 0;
  sink.push({ key: "<string>", reason });
  return input.replace(pattern, REDACTED);
}

/**
 * Compact absolute filesystem paths within `s`. `$HOME` roots become
 * `~`; other system-absolute paths (`/var/...`, `/tmp/...`, `/etc/...`) compact
 * to their last 2 segments. Compaction PRESERVES trailing segments — it does
 * not strip — so `~/.comis/config.yaml` survives. Uses literal `replaceAll`
 * for the home root (a homeDir containing regex metachars must never break
 * or widen the match).
 */
function compactPaths(s: string, homeDir: string | undefined, sink: RedactionRecord[]): string {
  let out = s;
  let changed = false;

  // 1. $HOME → ~ (literal replacement; most-specific root).
  if (homeDir !== undefined && homeDir.length > 0 && out.includes(homeDir)) {
    out = out.replaceAll(homeDir, "~");
    changed = true;
  }

  // 2. Remaining system-absolute paths → last 2 segments.
  //    Match a leading-slash path of ≥ 2 segments; keep only the final two.
  //    URL-scheme guard: the leading `/` must not be
  //    preceded by `:` or `/`. The `:` half is obvious (first slash of `://`);
  //    the `/` half blocks the SECOND slash of `://` — without it, the matcher
  //    would still anchor at the second slash and treat `//host/path/...` as a
  //    `/host/path/...` filesystem path. URL hosts are public info
  //    (tavily.com/search renders verbatim), not filesystem paths. A
  //    two-character negative-lookbehind keeps the rest of the matcher identical
  //    so the existing filesystem-path compaction tests stay green (no leading
  //    `/` of a real FS path like `/var/folders/...` or `/Users/alice/...` is
  //    preceded by `:` or `/`).
  const ABS_PATH_RE = /(?<![:/])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g;
  out = out.replace(ABS_PATH_RE, (match) => {
    const segments = match.split("/").filter((seg) => seg.length > 0);
    if (segments.length <= 2) return match;
    changed = true;
    // Prefix an explicit `…/` ellipsis so the elision is VISIBLE, not silent.
    // Without it, a deep $HOME-rooted path compacts to `~` + `tool-results/x`
    // = `~tool-results/x`, which reads as a LITERAL `~tool-results` token rather
    // than "home / … / tool-results / x" (comis-harel Golan investigation,
    // 2026-07-12: a misleading argsPreview sent the triage the wrong way).
    return "…/" + segments.slice(-2).join("/");
  });

  if (changed) sink.push({ key: "<string>", reason: "absolute_path" });
  return out;
}

/**
 * URL-aware extract-and-restore guard. Stashes every `https?://` URL behind a
 * null-byte placeholder, runs `fn` on the placeholder-substituted string, then
 * restores the URLs verbatim. The null-byte sentinels (`\x00URL{i}\x00`) never
 * appear in legitimate input — the `MAX_SANITIZE_LENGTH` guard above already
 * bounds the input size, and no matcher's character class includes `\x00`.
 *
 * Used to wrap the network-identifier and PII matcher passes so URL paths
 * (including numeric IDs that look like phone numbers or credit-card runs) and
 * URL hosts are NOT masked. Public URL hosts AND paths are
 * user-facing context, not infrastructure leakage.
 *
 * Defense-in-depth: this runs AFTER the secret-shape pass, so URL_PASSWORD
 * still strips embedded credentials in `https://user:pw@host/...` before the
 * URL is ever stashed.
 *
 * Idempotent: running twice on the same input yields the same output (the
 * restored URL exactly equals the stashed URL, and the placeholders aren't
 * matched by any pattern in `fn`).
 */
function withUrlsProtected(input: string, fn: (s: string) => string): string {
  // Conservative URL match: `https?://` scheme, terminate at whitespace or
  // typical free-text URL boundaries (`<`, `>`, `"`, `'`).
  const URL_RE = /https?:\/\/[^\s<>"']+/g;
  const urls: string[] = [];
  const stashed = input.replace(URL_RE, (match) => {
    urls.push(match);
    return `\x00URL${urls.length - 1}\x00`;
  });
  if (urls.length === 0) return fn(input); // hot-path: no URLs, no wrapping cost
  const processed = fn(stashed);
  // NUL (\x00) is a deliberate stash sentinel — it cannot occur in normal text
  // or URLs, so it is an unambiguous, injection-proof placeholder delimiter.
  // eslint-disable-next-line no-control-regex
  return processed.replace(/\x00URL(\d+)\x00/g, (_, i) => urls[Number(i)] ?? "");
}

/**
 * Redact a single string leaf. The pass order guarantees that more-specific
 * shapes always win over the greedy phone matcher AND that public URLs
 * (hosts + paths) survive verbatim:
 *   (1) secret-shape pass (sk_*, ghp_*, AKIA*, JWT, provider tokens). Runs
 *       FIRST so URL-embedded credentials (`https://user:pw@host`) are
 *       URL_PASSWORD-masked BEFORE the URL guard stashes the URL — the
 *       defense-in-depth ordering is preserved.
 *   (2) absolute-path compaction. Has its own URL-scheme `(?<![:/])` guard.
 *   (3)+(4)+(5) URL-aware pre-pass wraps the remaining network + PII matcher
 *       passes (IPV4/MAC/HOSTNAME + EMAIL/CC/SSN/PHONE). URL hosts AND URL
 *       paths are stashed behind null-byte placeholders, the matchers run on
 *       the placeholder-substituted string, then URLs are restored verbatim.
 *       Standalone shapes outside any URL (e.g. a phone number in free text,
 *       or an internal `db-primary.internal.example.com` reference) are still
 *       masked exactly as before — the URL exemption is span-precise.
 *
 * Oversized strings short-circuit (ReDoS guard) and are returned untouched.
 */
function redactString(
  input: string,
  homeDir: string | undefined,
  sink: RedactionRecord[],
): string {
  if (input.length > MAX_SANITIZE_LENGTH) return input;

  let out = input;

  // (1) Secret shapes — defense-in-depth even under a benign key.
  //     URL-embedded credentials (`https://user:pw@host`) get URL_PASSWORD-masked
  //     HERE, BEFORE the URL guard below stashes the URL — so the credential
  //     never survives the URL guard's extract-and-restore.
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    out = applyShape(out, pattern, "secret_shape", sink);
  }

  // (2) Absolute-path compaction. Has its own URL-scheme `(?<![:/])` guard.
  out = compactPaths(out, homeDir, sink);

  // (3)+(4)+(5) URL-aware pre-pass wraps all remaining network + PII matchers.
  //     URL hosts AND URL paths are public, user-facing context —
  //     numeric IDs in URL paths must not false-positive as phone/CC/SSN, and
  //     URL hosts must not be masked as network identifiers. Standalone
  //     hostnames / IPs / MACs / phones / CCs / SSNs / emails OUTSIDE any URL
  //     stay masked exactly as before.
  out = withUrlsProtected(out, (s) => {
    // (3) Network identifiers. IP/MAC are precise digit/hex shapes the greedy
    //     phone matcher would otherwise consume; hostname requires ≥ 3 labels.
    s = applyShape(s, IPV4_RE, "network_identifier", sink);
    s = applyShape(s, MAC_RE, "network_identifier", sink);
    s = applyShape(s, HOSTNAME_RE, "network_identifier", sink);
    // (4) Email + structured PII. Credit-card and SSN are specific digit shapes
    //     that must be caught before the broad phone pass.
    s = applyShape(s, EMAIL_RE, "pii_email", sink);
    s = applyShape(s, CREDIT_CARD_RE, "pii_credit_card", sink);
    s = applyShape(s, SSN_RE, "pii_ssn", sink);
    // (5) Phone LAST — broadest digit-with-separators shape.
    s = applyShape(s, PHONE_RE, "pii_phone", sink);
    return s;
  });

  return out;
}

// ---------------------------------------------------------------------------
// Recursive walker (same walk discipline as observability/value-shapes.ts)
// ---------------------------------------------------------------------------

/** Case-insensitive exact match of a key against the 9 secret keys. */
function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

/** Mutable accumulator threaded through the recursive walk. */
interface WalkState {
  readonly homeDir: string | undefined;
  readonly limits: RedactLimits;
  readonly sink: RedactionRecord[];
  readonly seen: WeakSet<object>;
  /** Running byte estimate (against `limits.maxTotalBytes`). */
  bytes: number;
  truncated: boolean;
}

/** Add `reason` to the sink (deduped per reason+key) and flag truncation. */
function flagTruncation(state: WalkState, key: string, reason: RedactionReason): void {
  state.truncated = true;
  state.sink.push({ key, reason });
}

/**
 * Recurse over an arbitrary value, returning a NEW redacted graph (input never
 * mutated). Scalars pass through; strings are redacted; objects/arrays are
 * rebuilt within the depth/keys/array/byte bounds; cycles return a sentinel.
 */
function walk(value: unknown, depth: number, keyForValue: string, state: WalkState): unknown {
  // Byte budget — once blown, everything below collapses to the token.
  if (state.bytes >= state.limits.maxTotalBytes) {
    if (!state.truncated) flagTruncation(state, keyForValue, "bytes_exceeded");
    else state.truncated = true;
    return REDACTED;
  }

  if (typeof value === "string") {
    const before = state.sink.length;
    let redacted = redactString(value, state.homeDir, state.sink);
    // Re-key the structural-hint records to the owning object key when known.
    for (let i = before; i < state.sink.length; i++) {
      if (state.sink[i].key === "<string>" && keyForValue !== "<root>") {
        state.sink[i] = { key: keyForValue, reason: state.sink[i].reason };
      }
    }
    // Byte budget: a single oversized string leaf is hard-truncated so the
    // total serialized value stays under maxTotalBytes.
    const remaining = state.limits.maxTotalBytes - state.bytes;
    if (redacted.length > remaining) {
      redacted = redacted.slice(0, Math.max(0, remaining));
      flagTruncation(state, keyForValue === "<root>" ? "<string>" : keyForValue, "bytes_exceeded");
    }
    state.bytes += redacted.length;
    return redacted;
  }

  if (value === null || value === undefined) return value;

  // Numbers, booleans, bigints, symbols, functions — pass through untouched.
  if (typeof value !== "object") {
    state.bytes += 8;
    return value;
  }

  const obj = value as object;

  // Cycle guard.
  if (state.seen.has(obj)) return REDACTED;
  state.seen.add(obj);

  // Depth bound.
  if (depth >= state.limits.maxDepth) {
    flagTruncation(state, keyForValue, "depth_exceeded");
    return REDACTED;
  }

  if (Array.isArray(obj)) {
    const arr = obj as unknown[];
    const limit = state.limits.maxArrayLength;
    const slice = arr.length > limit ? arr.slice(0, limit) : arr;
    if (arr.length > limit) flagTruncation(state, keyForValue, "array_truncated");
    const out: unknown[] = [];
    for (let i = 0; i < slice.length; i++) {
      if (state.bytes >= state.limits.maxTotalBytes) {
        flagTruncation(state, keyForValue, "bytes_exceeded");
        break;
      }
      out.push(walk(slice[i], depth + 1, keyForValue, state));
    }
    return out;
  }

  // Plain object — rebuild within the key cap; never mutate the input.
  const entries = Object.entries(obj as Record<string, unknown>);
  const keyLimit = state.limits.maxKeysPerLevel;
  if (entries.length > keyLimit) flagTruncation(state, keyForValue, "keys_exceeded");
  const kept = entries.length > keyLimit ? entries.slice(0, keyLimit) : entries;

  const out: Record<string, unknown> = {};
  for (const [k, v] of kept) {
    if (state.bytes >= state.limits.maxTotalBytes) {
      flagTruncation(state, k, "bytes_exceeded");
      break;
    }
    state.bytes += k.length;
    if (isSecretKey(k)) {
      // Key-based redaction: the whole value collapses regardless of content.
      out[k] = REDACTED;
      state.sink.push({ key: k, reason: "secret_key" });
      state.bytes += REDACTED.length;
      continue;
    }
    out[k] = walk(v, depth + 1, k, state);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Redact an arbitrary (untrusted) value into a safe, bounded shape suitable for
 * user-visible activity text. Pure, non-throwing, non-mutating. See the module
 * docblock for the full contract.
 *
 * @param value - any JavaScript value (raw tool params, a string, etc.)
 * @param opts  - `homeDir` for `$HOME`→`~` compaction; optional `limits` override
 * @returns `{ value, redactionsApplied, truncated }`
 */
export function redactValue(value: unknown, opts: RedactOptions = {}): RedactedValue {
  const state: WalkState = {
    homeDir: opts.homeDir,
    limits: opts.limits ?? REDACT_LIMITS,
    sink: [],
    seen: new WeakSet<object>(),
    bytes: 0,
    truncated: false,
  };

  const redacted = walk(value, 0, "<root>", state);

  return {
    value: redacted,
    redactionsApplied: state.sink,
    truncated: state.truncated,
  };
}
