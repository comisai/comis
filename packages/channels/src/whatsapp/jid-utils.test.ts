// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  isWhatsAppGroupJid,
  isWhatsAppUserJid,
  extractJidPhone,
  normalizeWhatsAppJid,
} from "./jid-utils.js";

describe("jid-utils", () => {
  describe("isWhatsAppGroupJid", () => {
    it("returns true for standard group JID", () => {
      expect(isWhatsAppGroupJid("120363025555555555@g.us")).toBe(true);
    });

    it("returns false for user JID", () => {
      expect(isWhatsAppGroupJid("41796666864:0@s.whatsapp.net")).toBe(false);
    });

    it("returns false for non-JID string", () => {
      expect(isWhatsAppGroupJid("notajid")).toBe(false);
    });

    it("returns true for hyphenated group JID", () => {
      expect(isWhatsAppGroupJid("120363-555555@g.us")).toBe(true);
    });

    it("returns false for empty string", () => {
      expect(isWhatsAppGroupJid("")).toBe(false);
    });

    it("returns false for LID JID", () => {
      expect(isWhatsAppGroupJid("123456@lid")).toBe(false);
    });
  });

  describe("isWhatsAppUserJid", () => {
    it("returns true for standard user JID with device suffix", () => {
      expect(isWhatsAppUserJid("41796666864:0@s.whatsapp.net")).toBe(true);
    });

    it("returns true for LID JID", () => {
      expect(isWhatsAppUserJid("123456@lid")).toBe(true);
    });

    it("returns false for group JID", () => {
      expect(isWhatsAppUserJid("120363025555555555@g.us")).toBe(false);
    });

    it("returns true for user JID without device suffix", () => {
      expect(isWhatsAppUserJid("41796666864@s.whatsapp.net")).toBe(true);
    });

    it("returns false for non-JID string", () => {
      expect(isWhatsAppUserJid("notajid")).toBe(false);
    });
  });

  describe("extractJidPhone", () => {
    it("extracts phone from user JID with device suffix", () => {
      expect(extractJidPhone("41796666864:0@s.whatsapp.net")).toBe("41796666864");
    });

    it("extracts number from LID JID", () => {
      expect(extractJidPhone("123456@lid")).toBe("123456");
    });

    it("returns null for non-JID string", () => {
      expect(extractJidPhone("notajid")).toBeNull();
    });

    it("returns null for group JID", () => {
      expect(extractJidPhone("120363-555@g.us")).toBeNull();
    });

    it("extracts phone from user JID without device suffix", () => {
      expect(extractJidPhone("41796666864@s.whatsapp.net")).toBe("41796666864");
    });
  });

  describe("normalizeWhatsAppJid", () => {
    it("normalizes user JID to phone number", () => {
      expect(normalizeWhatsAppJid("41796666864:0@s.whatsapp.net")).toBe("41796666864");
    });

    it("preserves group JID format", () => {
      expect(normalizeWhatsAppJid("120363-555@g.us")).toBe("120363-555@g.us");
    });

    it("strips whatsapp: prefix and normalizes phone", () => {
      expect(normalizeWhatsAppJid("whatsapp:41796666864")).toBe("41796666864");
    });

    it("returns null for empty string", () => {
      expect(normalizeWhatsAppJid("")).toBeNull();
    });

    it("returns null for invalid @-domain JID", () => {
      expect(normalizeWhatsAppJid("@invalid")).toBeNull();
    });

    it("normalizes LID JID to number", () => {
      expect(normalizeWhatsAppJid("123456@lid")).toBe("123456");
    });

    it("normalizes raw phone number", () => {
      expect(normalizeWhatsAppJid("+41 79 666 6864")).toBe("41796666864");
    });

    it("returns null for whitespace-only input", () => {
      expect(normalizeWhatsAppJid("   ")).toBeNull();
    });

    it("returns null for unknown @-domain", () => {
      expect(normalizeWhatsAppJid("user@unknown.domain")).toBeNull();
    });
  });
});
