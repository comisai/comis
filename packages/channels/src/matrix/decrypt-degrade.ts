// SPDX-License-Identifier: Apache-2.0
/**
 * Decrypt-degrade decider: a PURE cause classifier over an inbound decryption
 * failure. Given whether e2ee is configured, whether the crypto backend is live,
 * and the SDK's failure-reason code, it returns a closed `kind` plus a fixed,
 * operator-actionable hint that names the exact config knob to turn — never a
 * secret, never the failure text interpolated in.
 *
 * The wrong-knob guard is the whole point: "this room is encrypted — set
 * `channels.matrix.e2ee: true`" is the correct advice ONLY when the bot has no
 * crypto backend AND e2ee is not configured. When crypto IS live, the failure is a
 * key / verification / ratchet issue, and telling the operator to enable e2ee
 * (which is already on) would be the wrong knob. So the crypto-unavailable branch
 * is evaluated FIRST and is the ONLY path that returns the e2ee-off verdict; every
 * reason-coded branch below runs only when crypto is available and therefore can
 * never emit that hint. Within the crypto-unavailable branch the hint itself
 * splits on whether e2ee is CONFIGURED: an already-configured-but-init-failed bot
 * is pointed at the crypto backend / recovery key, never told to flip a switch
 * that is already on. A dedicated test asserts this for every reason code.
 *
 *   | Condition                                  | kind              | Names the knob            |
 *   | ------------------------------------------ | ----------------- | ------------------------- |
 *   | crypto unavailable, e2ee not configured    | (e2ee-off)        | channels.matrix.e2ee      |
 *   | crypto unavailable, e2ee configured        | (e2ee-off)        | recoveryKey / daemon logs |
 *   | MEGOLM_UNKNOWN_INBOUND_SESSION_ID          | missing_session   | re-invite / re-share keys |
 *   | MEGOLM_KEY_WITHHELD                        | key_withheld      | verify the bot device     |
 *   | *_WITHHELD_FOR_UNVERIFIED_DEVICE /         | unverified_device | channels.matrix.recoveryKey
 *   |   UNSIGNED_/UNKNOWN_SENDER_DEVICE          |                   |                           |
 *   | OLM_UNKNOWN_MESSAGE_INDEX                  | ratchet_gap       | (transient, no knob)      |
 *   | HISTORICAL_MESSAGE_* (4)                   | historical        | (benign, no knob)         |
 *   | SENDER_IDENTITY_PREVIOUSLY_VERIFIED        | identity_changed  | re-verify the sender      |
 *   | UNKNOWN_ERROR / null / unmapped            | unknown           | inspect homeserver+device |
 *
 * Pure: no I/O, no client, no crypto engine. Only a value import of the SDK's
 * failure-code enum for the branch constants (a stable, closed protocol enum —
 * matching on it never drifts the way string-matching an error message would).
 *
 * @module
 */

import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";

/**
 * The closed set of degrade causes. Mirrored (as an inline literal union) by the
 * decrypt-health obs event the daemon defines, which cannot import from this
 * package — keep the two in sync.
 */
export type DecryptDegradeKind =
  | "e2ee_off" // crypto backend unavailable — the only path that names the e2ee knob
  | "missing_session" // MEGOLM_UNKNOWN_INBOUND_SESSION_ID
  | "key_withheld" // MEGOLM_KEY_WITHHELD
  | "unverified_device" // *_WITHHELD_FOR_UNVERIFIED_DEVICE / UNSIGNED_ / UNKNOWN_SENDER_DEVICE
  | "ratchet_gap" // OLM_UNKNOWN_MESSAGE_INDEX
  | "historical" // HISTORICAL_MESSAGE_* — benign / expected
  | "identity_changed" // SENDER_IDENTITY_PREVIOUSLY_VERIFIED
  | "unknown"; // UNKNOWN_ERROR / null / unmapped

/** The inputs the degrade verdict is a pure function of. */
export interface DecryptDegradeInput {
  /**
   * Whether e2ee is configured on this channel. The `kind` keys on
   * `cryptoAvailable`, but within the crypto-unavailable branch this field decides
   * the HINT: configured-but-init-failed points at the crypto backend / recovery
   * key, while genuinely-off names the `channels.matrix.e2ee` switch — so an
   * operator with e2ee already on is never told to enable it.
   */
  e2eeConfigured: boolean;
  /** Whether the crypto backend is live (`client.getCrypto() !== undefined`). */
  cryptoAvailable: boolean;
  /** The SDK `DecryptionFailureCode` string, or null when none was reported. */
  failureReason: string | null;
}

/** The verdict: a closed cause `kind` and a fixed, secret-free operator hint. */
export interface DecryptDegradeVerdict {
  /** The closed degrade cause. */
  kind: DecryptDegradeKind;
  /** An operator-actionable next step naming the exact knob. Never a secret. */
  hint: string;
}

/**
 * Classify an inbound decryption failure into a cause `kind` + operator hint.
 *
 * @param input - Whether e2ee is configured, whether crypto is live, and the
 *   SDK failure-reason code (or null).
 * @returns The closed cause and a fixed hint naming the exact config knob.
 */
export function classifyDecryptDegrade(input: DecryptDegradeInput): DecryptDegradeVerdict {
  // WRONG-KNOB GUARD: the crypto backend being unavailable is the ONLY path to the
  // e2ee-off verdict. When crypto is live the failure is a key/verification/ratchet
  // issue (branched below), so the "set e2ee: true" hint is structurally
  // unreachable on the on-but-failed path. Within the crypto-unavailable branch the
  // hint further splits on whether e2ee is CONFIGURED: telling an operator to "set
  // e2ee: true" when it is already true is itself the wrong knob, so the on-but-
  // -crypto-failed case points at the real cause (the crypto backend / recovery
  // key), and only the genuinely-off case names the e2ee switch.
  if (!input.cryptoAvailable) {
    return {
      kind: "e2ee_off",
      hint: input.e2eeConfigured
        ? "e2ee is enabled but the crypto backend failed to initialize — check the daemon logs and `channels.matrix.recoveryKey`; the bot is running without decryption"
        : "this room is encrypted but the bot has no active crypto backend — set `channels.matrix.e2ee: true` so it can decrypt",
    };
  }

  switch (input.failureReason) {
    case DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID:
      return {
        kind: "missing_session",
        hint: "the bot is missing this room's encryption key — re-invite the bot or have a room member re-share the keys",
      };
    case DecryptionFailureCode.MEGOLM_KEY_WITHHELD:
      return {
        kind: "key_withheld",
        hint: "a sender is withholding this room's key — verify the bot device so the sender will share keys with it",
      };
    case DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE:
    case DecryptionFailureCode.UNSIGNED_SENDER_DEVICE:
    case DecryptionFailureCode.UNKNOWN_SENDER_DEVICE:
      return {
        kind: "unverified_device",
        hint: "the bot device is unverified — set `channels.matrix.recoveryKey` or verify the bot from another session",
      };
    case DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX:
      return {
        kind: "ratchet_gap",
        hint: "a known session but at a later ratchet index — usually transient; no action needed unless it persists",
      };
    case DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP:
    case DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED:
    case DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP:
    case DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED:
      return {
        kind: "historical",
        hint: "an encrypted message predating the bot's device could not be decrypted — expected, no action needed",
      };
    case DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED:
      return {
        kind: "identity_changed",
        hint: "the sender's identity changed since it was last verified — re-verify before trusting messages from it",
      };
    default:
      // UNKNOWN_ERROR, null, or any code a future SDK adds: never guess a knob.
      return {
        kind: "unknown",
        hint: "an encrypted event could not be decrypted — inspect the homeserver and the bot's device verification status",
      };
  }
}
