// SPDX-License-Identifier: Apache-2.0
/**
 * Diagnostic-payload sanitizer.
 *
 * Walks an arbitrary value and applies four sanitization rules:
 *
 *   1. **Credential field-name drop** — drop any object field whose key
 *      matches a credential-name pattern (apiKey, token, password,
 *      secret, authorization, cookie, privateKey, etc.), case-insensitive.
 *      An allowlist preserves configuration metadata names that contain
 *      credential substrings (`passwordFile`, `tokenBudget`, `tokenCount`,
 *      `tokenLimit`, etc.) so the sanitizer does not destroy legitimate
 *      operator-visible config.
 *
 *   2. **`name`/`value` pair shape** — when an object has the literal
 *      shape `{ name: <credential-name>, value: <secret>, ... }`,
 *      replace the `value` with `<redacted>` instead of dropping the
 *      whole pair (the pair shape is common in field-metadata listings
 *      where the surrounding context wants to surface the name).
 *
 *   3. **Image base-64 → sha256+bytes+format** — when an object has the
 *      shape `{ mimeType: "image/*", data: <b64>, ... }` (or
 *      `media_type`/`mime_type` aliases), replace `data` with
 *      `{ placeholder: "<redacted>", bytes, sha256, format }`. `format` is
 *      preserved from the mime-type — diagnostics needs to know the image
 *      type even though it must not log the bytes.
 *
 *   4. **In-string credential pass** — for free-text fields (no
 *      special shape), regex-replace embedded credentials:
 *      - `Authorization:` header values (Bearer/Basic/etc.)
 *      - JWT-shaped 3-segment dotted base64 substrings
 *      - `Cookie:`/`Set-Cookie:` values
 *      Each match is replaced with `<redacted>`.
 *
 * Cycle detection uses a WeakSet on the descent path. Back-edges produce
 * the literal string `"[Circular]"` (operator-readable, matches
 * Node.js util.inspect convention).
 *
 * The ENV regex is intentionally case-sensitive uppercase-only
 * (`[A-Z][A-Z0-9_]+`) so lowercase identifiers in diagnostic strings
 * like `Unrecognized key: "llm"` pass through unchanged.
 *
 * Pure function — no I/O, no clock, no fs. Composes downstream of
 * `limitPayloadValue` in the canonical chain
 * `redactSecrets(sanitizeDiagnosticPayload(limitPayloadValue(value)))`.
 *
 * The recursive `walk` body, WeakSet allocation, and `isPlainObject`
 * predicate live in the shared `combined-walker.ts`.
 * `sanitizeDiagnosticPayload` is a one-line delegate invoking
 * `combinedWalk` with `sanitizeNodeHook` only. `sanitizeString` and
 * `maybeRewriteImageObject` remain here (sanitize-stage knowledge);
 * they are narrow-exported for the combined walker.
 *
 * @module
 */

import { createHash } from "node:crypto";

import { combinedWalk, sanitizeNodeHook } from "./combined-walker.js";

/**
 * Names that, regardless of casing or word boundary, are credentials
 * and must drop their value. Compared case-insensitively against the
 * field name in full inside the diagnostic-payload sanitizer (via
 * `isCredentialFieldName`).
 *
 * **EXPORTED** because the same Set drives `@comis/infra`'s Pino
 * `redact.paths` generator. Pino's path matcher is CASE-SENSITIVE — so
 * the Set deliberately contains THREE lanes:
 *
 *   1. **bare/single-word** entries (`auth`, `token`, `secret`, …) —
 *      lower-case ASCII words, only one form needed.
 *   2. **snake_case** forms (`access_token`, `api_key`, …) — required
 *      for payloads keyed in snake_case.
 *   3. **camelCase** forms (`apiKey`, `botToken`, …) — required to
 *      preserve the legacy hand-table's camelCase coverage. Removing
 *      the hand-table without these would silently regress production
 *      `apiKey`/`botToken`/... redaction.
 *
 * The duplication is intentional and cheap (~27 entries). The
 * `isCredentialFieldName` predicate (below) lowercases its input
 * before lookup, so the camelCase entries are no-op duplicates in
 * the sanitizer's codepath; they are load-bearing for the Pino
 * `redact.paths` codepath.
 */
export const CREDENTIAL_KEYS = new Set<string>([
  // -------------------------------------------------------------------
  // Bare / single-word credential names (lower-case ASCII; one form
  // covers all uses).
  // -------------------------------------------------------------------
  "auth",
  "token",
  "password",
  "secret",
  "cookie",
  "key",                  // widening (false-positives mitigated by CREDENTIAL_ALLOWLIST)
  "passphrase",           // widening
  "credentials",          // widening
  "credential",           // singular form (preserves prior coverage)
  "authorization",
  // Bare OAuth token field names used by the auth.set RPC contract
  // ({ access: "<bearer>", refresh: "<token>" }). Absent from the set
  // prior to this fix — meaning any dispatcher error log carrying params
  // for a failed auth.set call would emit both tokens unredacted.
  // Adding them here covers: (a) sanitizeDiagnosticPayload field-drop in
  // the diagnostic chain, and (b) Pino redact.paths auto-generation
  // (case-sensitive, so the bare lowercase forms are the load-bearing lane).
  "access",
  "refresh",
  // -------------------------------------------------------------------
  // snake_case forms (required for Pino redact.paths on snake_case
  // payloads — Pino's matcher is case-sensitive).
  // -------------------------------------------------------------------
  "access_token",
  "refresh_token",
  "api_key",
  "bot_token",
  "webhook_secret",
  "private_key",
  "client_secret",
  "connection_string",
  "access_key",
  // -------------------------------------------------------------------
  // camelCase forms (REQUIRED — Pino redact.paths is case-sensitive,
  // so the lowercased forms above do NOT redact a field named
  // `apiKey`. Removing the legacy hand-table without preserving these
  // would silently regress production redaction.)
  //
  // The sanitizer's `isCredentialFieldName` predicate (below) uses
  // lowercase-compare and is unaffected by the duplication.
  // -------------------------------------------------------------------
  "accessToken",
  "refreshToken",
  "apiKey",
  "botToken",
  "webhookSecret",
  "privateKey",
  "clientSecret",
  "connectionString",
  "accessKey",
  // -------------------------------------------------------------------
  // Lowercased compatibility aliases (preserve prior `isCredentialFieldName`
  // semantics — these forms were in the original Set; keeping them is
  // a no-op given `.toLowerCase()` lookup, but is documented here for
  // archaeological clarity).
  // -------------------------------------------------------------------
  "apikey",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "webhooksecret",
  "bottoken",
]);

/**
 * Allowlist of names that LOOK like credentials but are configuration
 * metadata and must be preserved.
 *
 * Adding the bare `key` token to CREDENTIAL_KEYS triggers false-positives
 * on operational fields like `keyName`, `cacheKey`, `sessionKey`,
 * `eventKey`. The 10 entries below mitigate those.
 */
const CREDENTIAL_ALLOWLIST = new Set<string>([
  "passwordfile",
  "password_file",
  "tokenbudget",
  "token_budget",
  "tokencount",
  "token_count",
  "tokenlimit",
  "token_limit",
  "tokenizer",
  "tokenization",
  "cookiename",
  "cookie_name",
  "secretref",
  "secret_ref",
  // `key` false-positive mitigations
  "keyname",
  "key_name",
  "keypath",
  "key_path",
  "cachekey",
  "cache_key",
  "sessionkey",
  "session_key",
  "eventkey",
  "event_key",
]);

/**
 * True when `name` is a known credential key (case-insensitive).
 *
 * Exported as `isCredentialFieldName` from the package barrel for
 * use by `redactSecrets` (the structured walker) which needs the same
 * credential-key set + allowlist semantics for value-mode masking.
 * Also consumed by `combined-walker.ts`'s `sanitizeNodeHook` and
 * `redactNodeHook` for per-key decisions.
 */
export function isCredentialFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_ALLOWLIST.has(lower)) return false;
  return CREDENTIAL_KEYS.has(lower);
}

/** Mime-type alias keys for image-shape detection. */
const IMAGE_FORMAT_KEYS = ["mimeType", "media_type", "mime_type"] as const;

/**
 * Detect the `{ data: <b64>, mimeType: "image/*" }` shape and replace
 * `data` with the sha256+bytes+format breadcrumb.
 *
 * Returns a *new* object with the substitution applied if the shape
 * matches; returns `undefined` otherwise (caller falls through to the
 * normal walk).
 *
 * Exported for use by `combined-walker.ts` — the combined walker runs
 * image rewrite once per object during sanitize-stage processing.
 */
export function maybeRewriteImageObject(
  obj: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const data = obj["data"];
  if (typeof data !== "string") return undefined;

  let format: string | undefined;
  for (const key of IMAGE_FORMAT_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.startsWith("image/")) {
      format = v;
      break;
    }
  }
  if (format === undefined) return undefined;

  let bytes: number;
  let sha256: string;
  try {
    const raw = Buffer.from(data, "base64");
    bytes = raw.length;
    sha256 = createHash("sha256").update(raw).digest("hex");
  } catch {
    return undefined; // malformed base64 — let the normal walk handle it
  }

  const out: Record<string, unknown> = { ...obj };
  out["data"] = {
    placeholder: "<redacted>",
    bytes,
    sha256,
    format,
  };
  return out;
}

// --- In-string credential regex patterns ---------------------------------

// Authorization header (Bearer / Basic / Digest / etc.) — capture up to
// whitespace or end-of-line. Case-insensitive on the prefix.
const AUTH_HEADER_RE = /Authorization:\s*\S+\s+\S+/gi;

// JWT-shaped 3-segment dotted base64-url string (header.payload.signature).
// At least 8 chars per segment to avoid catching random dotted strings.
const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

// Cookie / Set-Cookie value (everything after the colon up to the next
// space or end-of-line). Case-insensitive on the prefix.
const COOKIE_RE = /Cookie:\s*\S+/gi;

/**
 * Regex-replace embedded Authorization / JWT / Cookie credentials in
 * free-text strings.
 *
 * Exported for use by `combined-walker.ts` — applied to every string
 * value during sanitize-stage processing.
 */
export function sanitizeString(input: string): string {
  let out = input;
  out = out.replace(AUTH_HEADER_RE, "<redacted>");
  out = out.replace(JWT_RE, "<redacted>");
  out = out.replace(COOKIE_RE, "<redacted>");
  return out;
}

/**
 * Sanitize a diagnostic payload.
 *
 * Delegates to `combinedWalk` with the sanitize-node hook only.
 * The walker scaffolding (WeakSet allocation, recursion, `isPlainObject`
 * predicate, per-string regex pass, image-shape rewrite sequencing)
 * lives in `combined-walker.ts`; the per-key credential-drop and
 * name/value-pair decision logic is encapsulated in `sanitizeNodeHook`.
 *
 * @param value - any JavaScript value
 * @returns a new value with credential fields stripped, images replaced
 *   by sha256+bytes+format breadcrumb, in-string credentials regex-
 *   redacted, and back-edges replaced with `"[Circular]"`.
 */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  return combinedWalk(value, { sanitizeNode: sanitizeNodeHook });
}
