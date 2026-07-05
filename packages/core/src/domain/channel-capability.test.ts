// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ChannelCapabilitySchema } from "./channel-capability.js";

// ---------------------------------------------------------------------------
// ChannelCapability feature flags
//
// ChannelFeaturesSchema declares `typing` (default false), `threads`
// (default false), and `buttons` (closed enum, default "none") so
// selectStrategy() and renderers don't have to guess what a plugin supports.
// Defaults exist only as a safety net for *new* plugins — the 11
// in-tree plugins declare the values explicitly.
// ---------------------------------------------------------------------------

describe("ChannelCapability feature flags", () => {
  it("defaults typing and threads to false and buttons to 'none'", () => {
    const cap = ChannelCapabilitySchema.parse({
      limits: { maxMessageChars: 4096 },
    });
    expect(cap.features.typing).toBe(false);
    expect(cap.features.threads).toBe(false);
    expect(cap.features.buttons).toBe("none");
  });

  it("keeps the existing feature flags defaulting to false", () => {
    const cap = ChannelCapabilitySchema.parse({
      limits: { maxMessageChars: 4096 },
    });
    expect(cap.features.reactions).toBe(false);
    expect(cap.features.editMessages).toBe(false);
    expect(cap.features.deleteMessages).toBe(false);
    expect(cap.features.fetchHistory).toBe(false);
    expect(cap.features.attachments).toBe(false);
  });

  it("accepts every buttons enum member", () => {
    for (const buttons of [
      "inline",
      "components",
      "blockkit",
      "quickreply",
      "none",
      "adaptivecard",
      "cardsv2",
    ] as const) {
      const cap = ChannelCapabilitySchema.parse({
        features: { buttons },
        limits: { maxMessageChars: 4096 },
      });
      expect(cap.features.buttons).toBe(buttons);
    }
  });

  it("accepts the cardsv2 buttons flavour", () => {
    const cap = ChannelCapabilitySchema.parse({
      features: { buttons: "cardsv2" },
      limits: { maxMessageChars: 4096 },
    });
    expect(cap.features.buttons).toBe("cardsv2");
  });

  it("rejects an unknown buttons value", () => {
    const result = ChannelCapabilitySchema.safeParse({
      features: { buttons: "bogus" },
      limits: { maxMessageChars: 4096 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts explicit typing/threads true values", () => {
    const cap = ChannelCapabilitySchema.parse({
      features: { typing: true, threads: true, buttons: "components" },
      limits: { maxMessageChars: 2000 },
    });
    expect(cap.features.typing).toBe(true);
    expect(cap.features.threads).toBe(true);
    expect(cap.features.buttons).toBe("components");
  });

  it("rejects unknown feature keys (strictObject)", () => {
    const result = ChannelCapabilitySchema.safeParse({
      features: { typing: true, bogusFeature: true },
      limits: { maxMessageChars: 2000 },
    });
    expect(result.success).toBe(false);
  });
});
