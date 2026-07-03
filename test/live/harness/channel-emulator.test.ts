// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the shared `ChannelEmulator` port + `ChannelCaps`
 * descriptor.
 *
 * Pure type/structural tests — no daemon, no key, no network, fast. The port
 * is the channel-agnostic contract every per-channel emulator implements
 * (`TgEmulator extends ChannelEmulator`). These tests assert:
 *   - `ChannelCaps` carries the FLAT shape
 *     (channel / inbound{} / outbound{} / protocol).
 *   - `ChannelEmulator` declares `start()`/`stop()` + `readonly caps` — a
 *     minimal in-test class that `implements ChannelEmulator` compiles (the
 *     type IS the contract).
 *   - the port is channel-agnostic — `channel-emulator.ts` imports neither
 *     grammy nor any `@comis/*` channel package (Telegram specifics live in
 *     `tg-emulator.ts`).
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { ChannelCaps, ChannelEmulator, MediaKind } from "./channel-emulator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT_SOURCE = resolve(HERE, "channel-emulator.ts");

// ---------------------------------------------------------------------------
// ChannelCaps — the flat descriptor
// ---------------------------------------------------------------------------

describe("ChannelCaps flat descriptor shape", () => {
  it("constructs a Telegram ChannelCaps literal with every field present and typed", () => {
    const media: MediaKind[] = ["photo", "voice", "document", "video", "video_note"];
    const caps: ChannelCaps = {
      channel: "telegram",
      inbound: {
        text: true,
        media,
        reactions: true,
        edits: true,
        buttons: true,
        threads: false,
        slashCommands: true,
        location: true,
      },
      outbound: {
        reactions: true,
        edits: true,
        deletes: true,
        buttons: true,
        attachments: true,
        typing: true,
        threads: false,
        richCards: false,
      },
      protocol: "http",
    };

    // Top-level shape.
    expect(caps.channel).toBe("telegram");
    expect(caps.protocol).toBe("http");

    // Inbound block — every field present and a boolean (media is an array).
    expect(typeof caps.inbound.text).toBe("boolean");
    expect(Array.isArray(caps.inbound.media)).toBe(true);
    expect(typeof caps.inbound.reactions).toBe("boolean");
    expect(typeof caps.inbound.edits).toBe("boolean");
    expect(typeof caps.inbound.buttons).toBe("boolean");
    expect(typeof caps.inbound.threads).toBe("boolean");
    expect(typeof caps.inbound.slashCommands).toBe("boolean");
    expect(typeof caps.inbound.location).toBe("boolean");

    // Outbound block — every field present and a boolean.
    expect(typeof caps.outbound.reactions).toBe("boolean");
    expect(typeof caps.outbound.edits).toBe("boolean");
    expect(typeof caps.outbound.deletes).toBe("boolean");
    expect(typeof caps.outbound.buttons).toBe("boolean");
    expect(typeof caps.outbound.attachments).toBe("boolean");
    expect(typeof caps.outbound.typing).toBe("boolean");
    expect(typeof caps.outbound.threads).toBe("boolean");
    expect(typeof caps.outbound.richCards).toBe("boolean");
  });

  it("accepts every MediaKind member of the closed union", () => {
    const all: MediaKind[] = ["photo", "voice", "document", "video", "video_note"];
    expect(all).toHaveLength(5);
    // Each value round-trips as a MediaKind (compile proves the union membership).
    for (const k of all) {
      const single: MediaKind = k;
      expect(typeof single).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// ChannelEmulator — the port (the type IS the contract)
// ---------------------------------------------------------------------------

describe("ChannelEmulator port contract", () => {
  it("a minimal class that implements ChannelEmulator compiles and round-trips start/stop", async () => {
    const caps: ChannelCaps = {
      channel: "telegram",
      inbound: {
        text: true,
        media: [],
        reactions: false,
        edits: false,
        buttons: false,
        threads: false,
        slashCommands: false,
        location: false,
      },
      outbound: {
        reactions: false,
        edits: false,
        deletes: false,
        buttons: false,
        attachments: false,
        typing: false,
        threads: false,
        richCards: false,
      },
      protocol: "http",
    };

    class StubEmulator implements ChannelEmulator {
      readonly caps = caps;
      private stopped = false;
      async start(): Promise<{ apiRoot: string; port: number }> {
        return { apiRoot: "http://127.0.0.1:51234", port: 51234 };
      }
      async stop(): Promise<void> {
        this.stopped = true;
      }
      wasStopped(): boolean {
        return this.stopped;
      }
    }

    const emu = new StubEmulator();
    const started = await emu.start();
    expect(started.apiRoot).toBe("http://127.0.0.1:51234");
    expect(started.port).toBe(51234);
    expect(emu.caps.channel).toBe("telegram");
    await emu.stop();
    expect(emu.wasStopped()).toBe(true);
  });

  it("start() resolves an apiRoot + port pair (the seam the rig wires into config)", async () => {
    // Structural: the return type carries exactly { apiRoot: string; port: number }.
    const fn: ChannelEmulator["start"] = async () => ({ apiRoot: "http://127.0.0.1:1", port: 1 });
    const res = await fn();
    expect(res).toEqual({ apiRoot: "http://127.0.0.1:1", port: 1 });
  });
});

// ---------------------------------------------------------------------------
// Channel-agnostic — no Telegram/grammy leak in the shared port
// ---------------------------------------------------------------------------

describe("ChannelEmulator port is channel-agnostic", () => {
  it("channel-emulator.ts imports neither grammy nor an @comis channel package", () => {
    const src = readFileSync(PORT_SOURCE, "utf8");
    // Strip comment lines so a doc-comment mentioning grammy/TgEmulator is not a false LEAK.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/from\s+["']grammy/);
    expect(code).not.toMatch(/from\s+["']@comis\/channels/);
  });
});
