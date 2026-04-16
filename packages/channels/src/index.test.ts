import { describe, it, expect } from "vitest";
import {
  // Telegram adapter
  createTelegramAdapter,
  // Discord adapter
  createDiscordAdapter,
  // Discord utilities
  mapDiscordToNormalized,
  buildDiscordAttachments,
  validateDiscordToken,
  chunkDiscordText,
  // Slack adapter
  createSlackAdapter,
  // Slack utilities
  mapSlackToNormalized,
  buildSlackAttachments,
  validateSlackCredentials,
  escapeSlackMrkdwn,
  fetchWithSlackAuth,
  isSlackHostname,
  // WhatsApp adapter
  createWhatsAppAdapter,
  // WhatsApp utilities
  mapBaileysToNormalized,
  buildWhatsAppAttachments,
  validateWhatsAppAuth,
  normalizeWhatsAppJid,
  isWhatsAppGroupJid,
  isWhatsAppUserJid,
  extractJidPhone,
  // Shared
  createChannelManager,
} from "./index.js";

describe("@comis/channels barrel exports", () => {
  it("exports all 4 adapter factories as functions", () => {
    expect(typeof createTelegramAdapter).toBe("function");
    expect(typeof createDiscordAdapter).toBe("function");
    expect(typeof createSlackAdapter).toBe("function");
    expect(typeof createWhatsAppAdapter).toBe("function");
  });

  it("exports Discord utilities", () => {
    expect(typeof mapDiscordToNormalized).toBe("function");
    expect(typeof buildDiscordAttachments).toBe("function");
    expect(typeof validateDiscordToken).toBe("function");
    expect(typeof chunkDiscordText).toBe("function");
  });

  it("exports Slack utilities", () => {
    expect(typeof mapSlackToNormalized).toBe("function");
    expect(typeof buildSlackAttachments).toBe("function");
    expect(typeof validateSlackCredentials).toBe("function");
    expect(typeof escapeSlackMrkdwn).toBe("function");
    expect(typeof fetchWithSlackAuth).toBe("function");
    expect(typeof isSlackHostname).toBe("function");
  });

  it("exports WhatsApp utilities", () => {
    expect(typeof mapBaileysToNormalized).toBe("function");
    expect(typeof buildWhatsAppAttachments).toBe("function");
    expect(typeof validateWhatsAppAuth).toBe("function");
    expect(typeof normalizeWhatsAppJid).toBe("function");
    expect(typeof isWhatsAppGroupJid).toBe("function");
    expect(typeof isWhatsAppUserJid).toBe("function");
    expect(typeof extractJidPhone).toBe("function");
  });

  it("exports shared infrastructure", () => {
    expect(typeof createChannelManager).toBe("function");
  });
});
