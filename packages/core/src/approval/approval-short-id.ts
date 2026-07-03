// SPDX-License-Identifier: Apache-2.0
import { randomInt } from "node:crypto";

/**
 * Short, callback-safe identifier for an approval request.
 *
 * The approval-gate is the SOLE minter: when it creates a new pending request it
 * mints a `shortId` alongside the 36-char `requestId`. The short id is the only
 * approval identifier exposed to channel callbacks; the full `requestId` is never
 * emitted to a renderer.
 *
 * @module
 */

/** Base62 alphabet (0-9, A-Z, a-z) — URL/callback-safe, no separator chars. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Number of characters in a minted short id. */
const SHORT_ID_LENGTH = 12;

/**
 * Mint a 12-char base62 callback-safe approval identifier.
 *
 * Each character is drawn independently from a CSPRNG (`node:crypto` `randomInt`,
 * the same house pattern as `security/token-generator.ts`), giving ~71 bits of
 * entropy (62^12 ≈ 3.2e21). That is large enough that brute-forcing a live id is
 * uneconomic (Spoofing) yet small enough to fit a channel callback
 * budget (e.g. Telegram's 64-byte `callback_data`). The wide space also makes a
 * birthday collision between two concurrent pending approvals negligible
 * (Tampering).
 *
 * A predictable `Date.now()`/counter id is deliberately avoided — guessability
 * would let an attacker forge an approval callback for a victim's pending request.
 * The signed-HMAC callback wrapper provides defense-in-depth; this primitive
 * guarantees only that the id itself is unpredictable.
 *
 * Matches `ApprovalRequestSchema.shortId` exactly: `z.string().length(12).regex(/^[0-9A-Za-z]+$/)`.
 *
 * @returns A 12-character base62 string.
 */
export function mintApprovalShortId(): string {
  let out = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    out += ALPHABET.charAt(randomInt(ALPHABET.length));
  }
  return out;
}
