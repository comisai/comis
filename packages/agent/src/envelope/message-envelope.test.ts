// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { wrapInEnvelope } from "./message-envelope.js";
import type { NormalizedMessage } from "@comis/core";
import type { EnvelopeConfig } from "@comis/core";

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "ch-1",
    channelType: "telegram",
    senderId: "user123",
    text: "Hello",
    timestamp: Date.UTC(2026, 0, 15, 14, 35, 0), // 2026-01-15 14:35:00 UTC
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EnvelopeConfig> = {}): EnvelopeConfig {
  return {
    timezoneMode: "utc",
    timeFormat: "12h",
    showElapsed: true,
    showProvider: true,
    elapsedMaxMs: 86_400_000,
    ...overrides,
  };
}

describe("wrapInEnvelope", () => {
  it("formats with provider, 12h UTC, no elapsed (no prevTimestamp)", () => {
    const msg = makeMsg();
    const config = makeConfig();
    const result = wrapInEnvelope(msg, config);
    // Should be: [telegram] user123 (2:35 PM):\nHello
    expect(result).toMatch(/^\[telegram\] user123 \(2:35\sPM\):\nHello$/);
  });

  it("omits provider when showProvider is false", () => {
    const msg = makeMsg();
    const config = makeConfig({ showProvider: false });
    const result = wrapInEnvelope(msg, config);
    // Should be: user123 (2:35 PM):\nHello
    expect(result).toMatch(/^user123 \(2:35\sPM\):\nHello$/);
  });

  it("formats in 24h mode", () => {
    const msg = makeMsg();
    const config = makeConfig({ timeFormat: "24h" });
    const result = wrapInEnvelope(msg, config);
    // Should contain 14:35 (24h format)
    expect(result).toContain("14:35");
    expect(result).not.toContain("PM");
    expect(result).not.toContain("AM");
  });

  it("shows elapsed time when prevTimestamp is provided", () => {
    const msg = makeMsg();
    const config = makeConfig();
    // 2 minutes before
    const prevTimestamp = msg.timestamp - 120_000;
    const result = wrapInEnvelope(msg, config, prevTimestamp);
    expect(result).toContain("+2m");
  });

  it("omits elapsed when showElapsed is false", () => {
    const msg = makeMsg();
    const config = makeConfig({ showElapsed: false });
    const prevTimestamp = msg.timestamp - 120_000;
    const result = wrapInEnvelope(msg, config, prevTimestamp);
    expect(result).not.toContain("+2m");
  });

  it("omits elapsed when no prevTimestamp even if showElapsed is true", () => {
    const msg = makeMsg();
    const config = makeConfig({ showElapsed: true });
    const result = wrapInEnvelope(msg, config);
    expect(result).not.toMatch(/\+\d+[smhd]/);
  });

  it("omits elapsed when diff exceeds elapsedMaxMs", () => {
    const msg = makeMsg();
    const config = makeConfig({ elapsedMaxMs: 3_600_000 }); // 1 hour max
    // 2 hours before
    const prevTimestamp = msg.timestamp - 7_200_000;
    const result = wrapInEnvelope(msg, config, prevTimestamp);
    expect(result).not.toMatch(/\+\d+[smhd]/);
  });

  it("formats with IANA timezone", () => {
    const msg = makeMsg();
    const config = makeConfig({ timezoneMode: "America/New_York" });
    const result = wrapInEnvelope(msg, config);
    // New York is UTC-5, so 14:35 UTC = 9:35 AM ET
    expect(result).toContain("9:35");
    expect(result).toContain("AM");
  });

  it("formats with local timezone mode", () => {
    const msg = makeMsg();
    const config = makeConfig({ timezoneMode: "local" });
    const result = wrapInEnvelope(msg, config);
    // Should still produce a valid envelope -- exact time depends on system tz
    expect(result).toMatch(/^\[telegram\] user123 \(.+\):\nHello$/);
  });

  it("uses different channel types for provider prefix", () => {
    const msg = makeMsg({ channelType: "discord" });
    const config = makeConfig();
    const result = wrapInEnvelope(msg, config);
    expect(result).toMatch(/^\[discord\]/);
  });

  it("preserves full message text", () => {
    const msg = makeMsg({ text: "Hello, how are you?\nI am fine." });
    const config = makeConfig();
    const result = wrapInEnvelope(msg, config);
    expect(result).toContain("Hello, how are you?\nI am fine.");
  });

  it("produces valid output with all defaults", () => {
    const msg = makeMsg();
    const config = makeConfig();
    const result = wrapInEnvelope(msg, config);
    // Must contain provider, sender, timestamp, newline, text
    expect(result).toContain("[telegram]");
    expect(result).toContain("user123");
    expect(result).toContain("Hello");
    expect(result).toContain("\n");
  });
});
