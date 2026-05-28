// SPDX-License-Identifier: Apache-2.0
/**
 * Header-credential classifier — the keystone's typed view of a single
 * `(headerName, value)` credential. Ships as part of the Phase 1 keystone;
 * consumed by the Phase 3 (CRED) credential-extraction lifecycle.
 *
 *   - "ref"           — a store-backed reference: an `${VAR}`/`$VAR`/`$${VAR}`
 *                       string (optionally scheme/quote-wrapped) OR a SecretRef
 *                       object. Already externalized — nothing to extract.
 *   - "oauth-bearer"  — a `Bearer `-scheme value wrapping a secret-looking
 *                       remainder (an OAuth/PAT bearer token pasted inline).
 *   - "static-secret" — a raw secret value with no auth scheme.
 *
 * Reuses the canonical env-substitution patterns (no re-authored ref regexes)
 * and the keystone `looksLikeSecretValue` heuristic.
 *
 * @module
 */

import { isSecretRef } from "../domain/secret-ref.js";
import { looksLikeSecretValue, isEnvRefString } from "./secret-detection.js";

/** Classification of a header credential. */
export type CredentialKind = "ref" | "oauth-bearer" | "static-secret";

/** Result of `classifyHeaderCredential`. */
export interface HeaderCredentialClassification {
  readonly kind: CredentialKind;
}

const BEARER_SCHEME_RE = /^Bearer\s+/i;

/**
 * Classify a header credential by `(name, value)`.
 *
 * Precedence: SecretRef object → ref; env-ref string → ref; Bearer-scheme
 * value → oauth-bearer; otherwise → static-secret.
 */
export function classifyHeaderCredential(
  _name: string,
  value: unknown,
): HeaderCredentialClassification {
  if (isSecretRef(value)) {
    return { kind: "ref" };
  }
  if (typeof value === "string") {
    if (isEnvRefString(value)) {
      return { kind: "ref" };
    }
    const trimmed = value.trim();
    // A Bearer-scheme value wrapping a secret-looking remainder is an inline
    // OAuth/PAT bearer token. looksLikeSecretValue strips the scheme internally,
    // so it sees the remainder.
    if (BEARER_SCHEME_RE.test(trimmed) && looksLikeSecretValue(trimmed)) {
      return { kind: "oauth-bearer" };
    }
    return { kind: "static-secret" };
  }
  // A present, non-ref, non-string credential value — treat as a static secret.
  return { kind: "static-secret" };
}
