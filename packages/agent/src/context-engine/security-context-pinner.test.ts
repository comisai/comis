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

describe("isSecurityRelevantMessage — S4", () => {
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
});
