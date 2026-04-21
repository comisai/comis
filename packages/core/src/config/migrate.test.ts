// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { migrateConfig } from "./migrate.js";

describe("config/migrate", () => {
  // -----------------------------------------------------------------------
  // Passthrough (no legacy keys)
  // -----------------------------------------------------------------------

  it("passes through config with no legacy keys unchanged", () => {
    const input = {
      tenantId: "test",
      streaming: {
        enabled: true,
        defaultDeliveryTiming: { mode: "natural", minMs: 800, maxMs: 2500 },
        defaultCoalescer: { maxChars: 500 },
        perChannel: {
          telegram: {
            enabled: true,
            deliveryTiming: { mode: "adaptive" },
            coalescer: { maxChars: 800 },
          },
        },
      },
    };
    const result = migrateConfig(input);
    expect(result).toEqual(input);
  });

  it("handles config with no streaming section", () => {
    const input = { tenantId: "bare" };
    const result = migrateConfig(input);
    expect(result).toEqual({ tenantId: "bare" });
  });

  it("handles empty streaming config", () => {
    const input = { streaming: {} };
    const result = migrateConfig(input);
    expect(result).toEqual({ streaming: {} });
  });

  // -----------------------------------------------------------------------
  // Per-channel migration
  // -----------------------------------------------------------------------

  it("migrates per-channel pacingMinMs/pacingMaxMs to deliveryTiming", () => {
    const input = {
      streaming: {
        perChannel: {
          telegram: {
            enabled: true,
            pacingMinMs: 500,
            pacingMaxMs: 1500,
          },
        },
      },
    };
    const result = migrateConfig(input);
    const telegram = (result.streaming as any).perChannel.telegram;

    expect(telegram.deliveryTiming).toEqual({ minMs: 500, maxMs: 1500 });
    expect(telegram.pacingMinMs).toBeUndefined();
    expect(telegram.pacingMaxMs).toBeUndefined();
    expect(telegram.enabled).toBe(true);
  });

  it("migrates per-channel coalesceMaxChars to coalescer.maxChars", () => {
    const input = {
      streaming: {
        perChannel: {
          discord: {
            enabled: true,
            coalesceMaxChars: 300,
          },
        },
      },
    };
    const result = migrateConfig(input);
    const discord = (result.streaming as any).perChannel.discord;

    expect(discord.coalescer).toEqual({ maxChars: 300 });
    expect(discord.coalesceMaxChars).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Root-level migration
  // -----------------------------------------------------------------------

  it("migrates root defaultPacingMinMs/defaultPacingMaxMs to defaultDeliveryTiming", () => {
    const input = {
      streaming: {
        defaultPacingMinMs: 600,
        defaultPacingMaxMs: 2000,
      },
    };
    const result = migrateConfig(input);
    const streaming = result.streaming as any;

    expect(streaming.defaultDeliveryTiming).toEqual({ minMs: 600, maxMs: 2000 });
    expect(streaming.defaultPacingMinMs).toBeUndefined();
    expect(streaming.defaultPacingMaxMs).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Partial migration (only some legacy keys present)
  // -----------------------------------------------------------------------

  it("handles partial migration (only some legacy keys present)", () => {
    const input = {
      streaming: {
        perChannel: {
          telegram: {
            enabled: true,
            pacingMinMs: 400,
            // pacingMaxMs is absent
          },
        },
      },
    };
    const result = migrateConfig(input);
    const telegram = (result.streaming as any).perChannel.telegram;

    expect(telegram.deliveryTiming).toEqual({ minMs: 400 });
    expect(telegram.pacingMinMs).toBeUndefined();
    // pacingMaxMs was never set, so deliveryTiming has no maxMs
    expect(telegram.deliveryTiming.maxMs).toBeUndefined();
  });

  it("handles partial root migration (only defaultPacingMinMs present)", () => {
    const input = {
      streaming: {
        defaultPacingMinMs: 300,
      },
    };
    const result = migrateConfig(input);
    const streaming = result.streaming as any;

    expect(streaming.defaultDeliveryTiming).toEqual({ minMs: 300 });
    expect(streaming.defaultPacingMinMs).toBeUndefined();
    expect(streaming.defaultPacingMaxMs).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Preservation (does NOT overwrite existing nested objects)
  // -----------------------------------------------------------------------

  it("does NOT overwrite existing deliveryTiming object", () => {
    const input = {
      streaming: {
        perChannel: {
          telegram: {
            enabled: true,
            pacingMinMs: 100,
            pacingMaxMs: 200,
            deliveryTiming: { mode: "adaptive", minMs: 999, maxMs: 1999 },
          },
        },
      },
    };
    const result = migrateConfig(input);
    const telegram = (result.streaming as any).perChannel.telegram;

    // Existing deliveryTiming preserved, legacy values ignored
    expect(telegram.deliveryTiming).toEqual({ mode: "adaptive", minMs: 999, maxMs: 1999 });
    // Legacy keys are still deleted
    expect(telegram.pacingMinMs).toBeUndefined();
    expect(telegram.pacingMaxMs).toBeUndefined();
  });

  it("does NOT overwrite existing coalescer object", () => {
    const input = {
      streaming: {
        perChannel: {
          discord: {
            enabled: true,
            coalesceMaxChars: 200,
            coalescer: { maxChars: 888, idleMs: 2000 },
          },
        },
      },
    };
    const result = migrateConfig(input);
    const discord = (result.streaming as any).perChannel.discord;

    // Existing coalescer preserved, legacy value ignored
    expect(discord.coalescer).toEqual({ maxChars: 888, idleMs: 2000 });
    expect(discord.coalesceMaxChars).toBeUndefined();
  });

  it("does NOT overwrite existing root defaultDeliveryTiming object", () => {
    const input = {
      streaming: {
        defaultPacingMinMs: 100,
        defaultPacingMaxMs: 200,
        defaultDeliveryTiming: { mode: "off" },
      },
    };
    const result = migrateConfig(input);
    const streaming = result.streaming as any;

    expect(streaming.defaultDeliveryTiming).toEqual({ mode: "off" });
    expect(streaming.defaultPacingMinMs).toBeUndefined();
    expect(streaming.defaultPacingMaxMs).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Multiple per-channel entries
  // -----------------------------------------------------------------------

  it("migrates multiple per-channel entries independently", () => {
    const input = {
      streaming: {
        perChannel: {
          telegram: {
            enabled: true,
            pacingMinMs: 500,
            pacingMaxMs: 1500,
            coalesceMaxChars: 300,
          },
          discord: {
            enabled: true,
            deliveryTiming: { mode: "adaptive" },
            coalescer: { maxChars: 800 },
          },
          slack: {
            enabled: false,
            pacingMinMs: 100,
            coalesceMaxChars: 400,
          },
        },
      },
    };
    const result = migrateConfig(input);
    const perChannel = (result.streaming as any).perChannel;

    // telegram: fully migrated
    expect(perChannel.telegram.deliveryTiming).toEqual({ minMs: 500, maxMs: 1500 });
    expect(perChannel.telegram.coalescer).toEqual({ maxChars: 300 });
    expect(perChannel.telegram.pacingMinMs).toBeUndefined();
    expect(perChannel.telegram.pacingMaxMs).toBeUndefined();
    expect(perChannel.telegram.coalesceMaxChars).toBeUndefined();

    // discord: already migrated, untouched
    expect(perChannel.discord.deliveryTiming).toEqual({ mode: "adaptive" });
    expect(perChannel.discord.coalescer).toEqual({ maxChars: 800 });

    // slack: partially migrated (pacingMinMs only, no pacingMaxMs)
    expect(perChannel.slack.deliveryTiming).toEqual({ minMs: 100 });
    expect(perChannel.slack.coalescer).toEqual({ maxChars: 400 });
    expect(perChannel.slack.pacingMinMs).toBeUndefined();
    expect(perChannel.slack.coalesceMaxChars).toBeUndefined();
    expect(perChannel.slack.enabled).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Input immutability
  // -----------------------------------------------------------------------

  it("does not mutate the original input object", () => {
    const input = {
      streaming: {
        defaultPacingMinMs: 600,
        perChannel: {
          telegram: {
            pacingMinMs: 500,
            pacingMaxMs: 1500,
          },
        },
      },
    };
    const inputCopy = JSON.parse(JSON.stringify(input));
    migrateConfig(input);

    // Original unchanged
    expect(input).toEqual(inputCopy);
  });
});
