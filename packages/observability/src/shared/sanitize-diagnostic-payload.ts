// SPDX-License-Identifier: Apache-2.0
/**
 * Diagnostic-payload sanitizer.
 *
 * Walks an arbitrary value and applies four sanitization rules (design
 * §4.3 + Comis improvements):
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
 *   3. **Image base-64 → sha256+bytes+format (Comis improvement)** —
 *      when an object has the shape `{ mimeType: "image/*", data: <b64>,
 *      ... }` (or `media_type`/`mime_type` aliases), replace `data` with
 *      `{ placeholder: "<redacted>", bytes, sha256, format }`. The
 *      Comis improvement over OpenClaw is preserving `format` from the
 *      mime-type — diagnostics needs to know the image type even though
 *      it must not log the bytes.
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
 * like `Unrecognized key: "llm"` pass through unchanged (research §10).
 *
 * Pure function — no I/O, no clock, no fs. Composes downstream of
 * `limitPayloadValue` in the canonical chain
 * `redactSecrets(sanitizeDiagnosticPayload(limitPayloadValue(value)))`.
 *
 * @module
 */

import { createHash } from "node:crypto";

/**
 * Names that, regardless of casing or word boundary, are credentials
 * and must drop their value. Compared case-insensitively against the
 * field name in full.
 */
const CREDENTIAL_KEYS = new Set<string>([
  "password",
  "apikey",
  "api_key",
  "token",
  "secret",
  "authorization",
  "auth",
  "cookie",
  "privatekey",
  "private_key",
  "botToken".toLowerCase(),
  "bot_token",
  "webhooksecret",
  "webhook_secret",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "clientsecret",
  "client_secret",
  "sessionid",
  "session_id",
]);

/**
 * Allowlist of names that LOOK like credentials but are configuration
 * metadata and must be preserved.
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
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `name` is a known credential key (case-insensitive). */
function isCredentialName(name: string): boolean {
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
 */
function maybeRewriteImageObject(
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

function sanitizeString(input: string): string {
  let out = input;
  out = out.replace(AUTH_HEADER_RE, "<redacted>");
  out = out.replace(JWT_RE, "<redacted>");
  out = out.replace(COOKIE_RE, "<redacted>");
  return out;
}

// --- Recursive walker ----------------------------------------------------

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const mapped = value.map((entry) => walk(entry, seen));
    seen.delete(value);
    return mapped;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    // Image-shape rewrite first.
    const imageRewritten = maybeRewriteImageObject(value);
    const subject = imageRewritten ?? value;

    // Name/value pair shape — if `name` is a credential name, redact the
    // value but preserve the pair.
    const isNameValuePair =
      typeof subject["name"] === "string" &&
      Object.prototype.hasOwnProperty.call(subject, "value") &&
      isCredentialName(subject["name"] as string);

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(subject)) {
      const v = subject[key];

      // Name/value: keep `name`, redact `value`.
      if (isNameValuePair && key === "value") {
        out[key] = "<redacted>";
        continue;
      }
      if (isNameValuePair && key === "name") {
        out[key] = v;
        continue;
      }

      // Credential field-name drop (skip the key entirely).
      if (isCredentialName(key)) continue;

      out[key] = walk(v, seen);
    }

    seen.delete(value);
    return out;
  }

  return value;
}

/**
 * Sanitize a diagnostic payload.
 *
 * @param value - any JavaScript value
 * @returns a new value with credential fields stripped, images replaced
 *   by sha256+bytes+format breadcrumb, in-string credentials regex-
 *   redacted, and back-edges replaced with `"[Circular]"`.
 */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return walk(value, seen);
}
