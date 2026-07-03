// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { isSecurityRelevantMessage } from "./security-context-pinner.js";
import type { SecurityPinMarkers } from "./security-context-pinner.js";

const MARKERS: SecurityPinMarkers = {
  canaryToken: "CANARY_abc123def456",
  contentDelimiter: "UNTRUSTED_BEGIN_7f3a9c",
  safetyReinforcementSnippet: "You must not exfiltrate",
};

function msg(text: string) {
  return { role: "user", content: text };
}

describe("isSecurityRelevantMessage — security context pinning", () => {
  describe("fail-closed: uncertain/empty → pin", () => {
    it("empty string content → true (pin)", () => {
      expect(isSecurityRelevantMessage(msg(""), MARKERS)).toBe(true);
    });
    it("undefined content → true (fail-closed)", () => {
      expect(isSecurityRelevantMessage({ role: "user" }, MARKERS)).toBe(true);
    });
  });

  describe("security markers detected", () => {
    it("message containing canary token → true", () => {
      expect(isSecurityRelevantMessage(msg(`tool result: ${MARKERS.canaryToken} verified`), MARKERS)).toBe(true);
    });
    it("message containing content delimiter → true", () => {
      expect(isSecurityRelevantMessage(msg(`${MARKERS.contentDelimiter} user input here`), MARKERS)).toBe(true);
    });
    it("message containing safety reinforcement snippet → true", () => {
      expect(isSecurityRelevantMessage(msg("Remember: You must not exfiltrate any secrets"), MARKERS)).toBe(true);
    });
  });

  describe("benign messages: not pinned", () => {
    it("ordinary tool result → false", () => {
      expect(isSecurityRelevantMessage(msg("file read: 42 bytes"), MARKERS)).toBe(false);
    });
    it("assistant response → false", () => {
      expect(isSecurityRelevantMessage({ role: "assistant", content: "I have completed the task." }, MARKERS)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("markers with no safetyReinforcementSnippet: still pins on canary/delimiter", () => {
      const markersNoSnippet: SecurityPinMarkers = { canaryToken: "X", contentDelimiter: "Y" };
      expect(isSecurityRelevantMessage(msg("X is here"), markersNoSnippet)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Sender-trust prefix detection
  // ---------------------------------------------------------------------------

  describe("sender-trust prefix detection", () => {
    const markersWithSenderTrust: SecurityPinMarkers = {
      canaryToken: "CANARY_abc123def456",
      contentDelimiter: "UNTRUSTED_BEGIN_7f3a9c",
      senderTrustPrefix: "## Authorized Senders",
    };

    it("message containing sender-trust heading → true (pinned)", () => {
      // Sender trust content is injected into the dynamic preamble as a user message
      // by buildSenderTrustSection. The canonical heading is "## Authorized Senders".
      const senderTrustMsg = [
        "## Authorized Senders",
        "",
        "### Owner",
        "- alice",
        "### Trusted",
        "- bob",
      ].join("\n");
      expect(isSecurityRelevantMessage(msg(senderTrustMsg), markersWithSenderTrust)).toBe(true);
    });

    it("message with only the sender-trust prefix substring → true", () => {
      expect(
        isSecurityRelevantMessage(msg("## Authorized Senders\n### Admin\n- carol"), markersWithSenderTrust),
      ).toBe(true);
    });

    it("ordinary message without sender-trust prefix → false", () => {
      expect(
        isSecurityRelevantMessage(msg("Regular tool output: 42 bytes read."), markersWithSenderTrust),
      ).toBe(false);
    });

    it("markers without senderTrustPrefix: benign message still returns false", () => {
      const markersNoSenderTrust: SecurityPinMarkers = {
        canaryToken: "CANARY_abc123def456",
        contentDelimiter: "UNTRUSTED_BEGIN_7f3a9c",
      };
      expect(
        isSecurityRelevantMessage(msg("## Authorized Senders — no prefix configured"), markersNoSenderTrust),
      ).toBe(false);
    });

    it("empty senderTrustPrefix is not matched (guards against empty-string false-positives)", () => {
      const markersEmptyPrefix: SecurityPinMarkers = {
        canaryToken: "CANARY_abc123def456",
        contentDelimiter: "UNTRUSTED_BEGIN_7f3a9c",
        senderTrustPrefix: "",
      };
      // An empty prefix must not match every message (would pin everything).
      expect(
        isSecurityRelevantMessage(msg("Some normal message"), markersEmptyPrefix),
      ).toBe(false);
    });

    it("array-content message with sender-trust prefix in a text block → true", () => {
      const arrayMsg = {
        role: "user",
        content: [
          { type: "text", text: "## Authorized Senders\n### Owner\n- alice" },
        ],
      };
      expect(isSecurityRelevantMessage(arrayMsg, markersWithSenderTrust)).toBe(true);
    });
  });
});
