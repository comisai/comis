// SPDX-License-Identifier: Apache-2.0
/**
 * Injection engine — applies credential injection rules to a mutable request.
 *
 * Port of OneCLI `inject.rs` `apply_injections` and `apply_set_param` (Apache-2.0).
 *
 * Pure module — no logger, no I/O, no side-effects beyond mutating the caller-
 * supplied Headers and URL objects.  The `secret` field of `InjectionInput` MUST
 * NOT appear in any log call — there are zero loggers in this module.
 *
 * Security invariants:
 *   - `replaceHeader` is a strict no-op when the target header is absent.
 *     It MUST NOT introduce credentials into requests that did not already
 *     carry the header.
 *   - `applySetParam` uses raw string append to preserve the existing query
 *     bytes verbatim.  `url.searchParams.set(...)` is FORBIDDEN here because
 *     it re-encodes the entire query string, corrupting HMAC-signed requests.
 *   - CRLF rejection in header names is delegated to the WHATWG `Headers`
 *     implementation (Node 22 built-in).
 *
 * @module
 */

import type { InjectionRule } from "./types.js";

// ── InjectionInput ────────────────────────────────────────────────────────────

/** Mutable request surfaces that `applyInjections` writes credentials into. */
export interface InjectionInput {
  /** Mutable WHATWG Headers from the intercepted request. */
  readonly headers: Headers;
  /** Mutable WHATWG URL from the intercepted request. */
  readonly url: URL;
  /** The already-resolved API key / credential.  MUST NOT be logged. */
  readonly secret: string;
}

// ── applySetParam (private) ───────────────────────────────────────────────────

/**
 * Appends `name=value` to `url.search` using raw string concatenation so that
 * pre-existing query bytes are preserved verbatim.
 *
 * DO NOT replace this with `url.searchParams.set(name, value)` — that API
 * re-encodes the entire existing query string, corrupting percent-encoded
 * sequences such as HMAC signatures (`%2F` → `%252F`).
 */
function applySetParam(url: URL, name: string, value: string): void {
  const hash = url.hash; // e.g. "#section"
  url.hash = "";

  const encodedPair = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  url.search = url.search === "" ? `?${encodedPair}` : `${url.search}&${encodedPair}`;

  url.hash = hash;
}

// ── applyInjections ───────────────────────────────────────────────────────────

/**
 * Applies the injection rule array to the mutable `input`, writing credentials
 * into the request headers and/or URL query string.
 *
 * Default-Bearer: when `rules` is empty, falls back to injecting
 * `Authorization: Bearer <secret>` — the generic REST-API credential pattern.
 *
 * Rules are applied in declaration order; later rules overwrite earlier ones on
 * the same header name (last-wins).
 */
export function applyInjections(
  rules: readonly InjectionRule[],
  input: InjectionInput,
): void {
  // Default: empty rules → Authorization: Bearer <secret>
  if (rules.length === 0) {
    input.headers.set("authorization", `Bearer ${input.secret}`);
    return;
  }

  for (const rule of rules) {
    switch (rule.kind) {
      case "setHeader": {
        const value =
          rule.format === "bearer"
            ? `Bearer ${input.secret}`
            : input.secret;
        input.headers.set(rule.name, value);
        if (rule.removeAuthorization === true) {
          input.headers.delete("authorization");
        }
        break;
      }

      case "replaceHeader": {
        // Strict no-op when the header is absent.
        // Never introduce credentials into requests that did not already
        // carry the target header.
        if (input.headers.has(rule.name)) {
          const value =
            rule.format === "bearer"
              ? `Bearer ${input.secret}`
              : input.secret;
          input.headers.set(rule.name, value);
        }
        break;
      }

      case "removeHeader": {
        // WHATWG Headers.delete() is case-insensitive.
        input.headers.delete(rule.name);
        break;
      }

      case "setParam": {
        applySetParam(input.url, rule.name, input.secret);
        break;
      }

      default: {
        // Exhaustiveness guard — catches new InjectionRule kinds at compile time.
        // At runtime the unreachable branch throws to prevent silent credential omission.
        // (File is in packages/core/src/security/ — exception zone; throw is allowed.)
        const _exhaustive: never = rule;
        // Only serialize the `kind` discriminant — never JSON.stringify the
        // full rule object, which may contain a `value` field in a future rule kind
        // that holds a credential. Restricting to `kind` prevents credential-in-log.
        throw new Error(`Unknown injection rule kind: ${String((_exhaustive as { kind?: unknown }).kind)}`);
      }
    }
  }
}
