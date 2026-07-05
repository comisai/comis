// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { SUPPORTED_CHANNELS, CHANNEL_ENV_KEYS } from "./types.js";
import { getChannelCredentialTypes } from "./validators/channel-creds.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("Microsoft Teams wizard enumeration", () => {
  it("offers a Microsoft Teams entry in SUPPORTED_CHANNELS so the init menu can show it", () => {
    const types = SUPPORTED_CHANNELS.map((c) => c.type as string);
    expect(types).toContain("msteams");
  });

  it("maps msteams to the MSTEAMS_APP_PASSWORD env key in CHANNEL_ENV_KEYS", () => {
    expect(CHANNEL_ENV_KEYS["msteams"]).toContain("MSTEAMS_APP_PASSWORD");
  });

  it("declares appId, appPassword and tenantId as the msteams credential types", () => {
    const creds = getChannelCredentialTypes("msteams");
    expect(creds.length).toBeGreaterThan(0);
    expect(creds).toEqual(
      expect.arrayContaining(["appId", "appPassword", "tenantId"]),
    );
  });

  it("includes msteams in the channelTypes enumeration of the channel command", () => {
    const src = readFileSync(resolve(here, "../commands/channel.ts"), "utf8");
    const match = src.match(/const channelTypes = \[([\s\S]*?)\] as const;/);
    expect(
      match,
      "channelTypes array literal must be present in channel.ts",
    ).not.toBeNull();
    expect(match?.[1] ?? "").toContain("msteams");
  });
});
