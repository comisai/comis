// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";

/**
 * Generate a cryptographically strong token suitable for bearer authentication.
 *
 * Produces a 64-character base64url string with 384 bits of entropy using
 * node:crypto randomBytes. Suitable for gateway tokens, webhook secrets,
 * and rotation identifiers.
 *
 * @returns A 64-character URL-safe string (base64url, no padding)
 */
export function generateStrongToken(): string {
  return randomBytes(48).toString("base64url");
}

/**
 * Generate a rotation identifier by appending a random suffix to the base ID.
 *
 * Replaces the predictable `Date.now()` pattern used previously for token
 * rotation. The suffix is 11 characters of base64url randomness
 * (64 bits of entropy).
 *
 * @param baseId - The original token identifier to rotate
 * @returns `${baseId}-${11-char-random-suffix}`
 */
export function generateRotationId(baseId: string): string {
  const suffix = randomBytes(8).toString("base64url");
  return `${baseId}-${suffix}`;
}
