// SPDX-License-Identifier: Apache-2.0
/**
 * Table oracle for the pure decrypt-degrade decider.
 *
 * One row per `DecryptionFailureCode` member (imported from the SDK so a new
 * member added upstream fails this test rather than silently defaulting), plus
 * the crypto-unavailable case, the null/unmapped fallback, and — the whole point
 * — the WRONG-KNOB guard: no on-but-failed code may ever emit the "set
 * e2ee: true" hint. Pure input → verdict; no I/O, no client, no homeserver.
 */
import { describe, it, expect } from "vitest";
import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";
import { classifyDecryptDegrade, type DecryptDegradeKind } from "../decrypt-degrade.js";

/**
 * The oracle: one row per code. `hintIncludes` is a distinctive substring the
 * operator hint for that cause must carry. Keyed by the enum so the test will
 * not compile if the SDK adds a member — the decider and this table move in
 * lockstep, so no new failure code can silently fall through unclassified.
 */
const ORACLE: Record<DecryptionFailureCode, { kind: DecryptDegradeKind; hintIncludes: string }> = {
  [DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID]: {
    kind: "missing_session",
    hintIncludes: "re-invite",
  },
  [DecryptionFailureCode.MEGOLM_KEY_WITHHELD]: {
    kind: "key_withheld",
    hintIncludes: "withholding",
  },
  [DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE]: {
    kind: "unverified_device",
    hintIncludes: "recoveryKey",
  },
  [DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX]: {
    kind: "ratchet_gap",
    hintIncludes: "transient",
  },
  [DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP]: {
    kind: "historical",
    hintIncludes: "expected",
  },
  [DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED]: {
    kind: "historical",
    hintIncludes: "expected",
  },
  [DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP]: {
    kind: "historical",
    hintIncludes: "expected",
  },
  [DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED]: {
    kind: "historical",
    hintIncludes: "expected",
  },
  [DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED]: {
    kind: "identity_changed",
    hintIncludes: "identity",
  },
  [DecryptionFailureCode.UNSIGNED_SENDER_DEVICE]: {
    kind: "unverified_device",
    hintIncludes: "recoveryKey",
  },
  [DecryptionFailureCode.UNKNOWN_SENDER_DEVICE]: {
    kind: "unverified_device",
    hintIncludes: "recoveryKey",
  },
  [DecryptionFailureCode.UNKNOWN_ERROR]: {
    kind: "unknown",
    hintIncludes: "inspect the homeserver",
  },
};

/** Substrings that may ONLY appear in the e2ee-off hint (the wrong-knob guard). */
const E2EE_ON_KNOB_SUBSTRINGS = ["e2ee: true", "channels.matrix.e2ee"];

const allCodes = Object.values(DecryptionFailureCode) as DecryptionFailureCode[];

describe("classifyDecryptDegrade — cause-branch table", () => {
  for (const code of allCodes) {
    const expected = ORACLE[code];
    it(`maps ${code} → ${expected.kind} with a cause-correct hint`, () => {
      const verdict = classifyDecryptDegrade({
        e2eeConfigured: true,
        cryptoAvailable: true,
        failureReason: code,
      });
      expect(verdict.kind).toBe(expected.kind);
      expect(verdict.hint).toContain(expected.hintIncludes);
    });
  }

  it("maps a crypto-unavailable event to e2ee_off and names channels.matrix.e2ee", () => {
    const verdict = classifyDecryptDegrade({
      e2eeConfigured: false,
      cryptoAvailable: false,
      failureReason: null,
    });
    expect(verdict.kind).toBe("e2ee_off");
    expect(verdict.hint).toContain("channels.matrix.e2ee");
  });

  it("does NOT tell the operator to enable e2ee when it is already on but the crypto backend failed to initialize", () => {
    // e2ee IS configured but the backend never came up (WASM load / initRustCrypto
    // failed). "Set channels.matrix.e2ee: true" would be the wrong knob — it is
    // already true. The hint must instead point at the real cause (the crypto
    // backend / recovery key), never at the e2ee switch.
    const verdict = classifyDecryptDegrade({
      e2eeConfigured: true,
      cryptoAvailable: false,
      failureReason: null,
    });
    for (const knob of E2EE_ON_KNOB_SUBSTRINGS) {
      expect(verdict.hint).not.toContain(knob);
    }
    expect(verdict.hint).not.toContain("e2ee: true");
    // It names the actual remedy: the crypto backend / recovery key.
    expect(verdict.hint).toContain("channels.matrix.recoveryKey");
  });

  it("still tells the operator to enable e2ee when it is genuinely off (crypto unavailable AND unconfigured)", () => {
    const verdict = classifyDecryptDegrade({
      e2eeConfigured: false,
      cryptoAvailable: false,
      failureReason: null,
    });
    expect(verdict.hint).toContain("channels.matrix.e2ee");
  });

  it("returns e2ee_off whenever crypto is unavailable, even with a failureReason present (guard is structural)", () => {
    // e2ee configured but the backend never came up: the room still cannot be
    // decrypted, so the verdict is e2ee_off regardless of the reason string.
    const verdict = classifyDecryptDegrade({
      e2eeConfigured: true,
      cryptoAvailable: false,
      failureReason: DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
    });
    expect(verdict.kind).toBe("e2ee_off");
  });

  it("NEVER emits the e2ee-on knob for any on-but-failed code (wrong-knob guard)", () => {
    for (const code of allCodes) {
      const verdict = classifyDecryptDegrade({
        e2eeConfigured: true,
        cryptoAvailable: true,
        failureReason: code,
      });
      expect(verdict.kind).not.toBe("e2ee_off");
      for (const knob of E2EE_ON_KNOB_SUBSTRINGS) {
        expect(verdict.hint).not.toContain(knob);
      }
    }
  });

  it("classifies the four historical codes as benign — no config-knob directive", () => {
    const historical = [
      DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP,
      DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
      DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP,
      DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED,
    ];
    for (const code of historical) {
      const verdict = classifyDecryptDegrade({
        e2eeConfigured: true,
        cryptoAvailable: true,
        failureReason: code,
      });
      expect(verdict.kind).toBe("historical");
      // Benign: no operator knob, no "set …" directive.
      expect(verdict.hint).not.toContain("channels.matrix");
      expect(verdict.hint.toLowerCase()).not.toContain("set ");
    }
  });

  it("falls back to unknown (never e2ee_off) for a null reason when crypto is available", () => {
    const verdict = classifyDecryptDegrade({
      e2eeConfigured: true,
      cryptoAvailable: true,
      failureReason: null,
    });
    expect(verdict.kind).toBe("unknown");
  });

  it("falls back to unknown for an unmapped reason string", () => {
    const verdict = classifyDecryptDegrade({
      e2eeConfigured: true,
      cryptoAvailable: true,
      failureReason: "SOME_FUTURE_SDK_CODE",
    });
    expect(verdict.kind).toBe("unknown");
  });
});
