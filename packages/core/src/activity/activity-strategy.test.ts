// SPDX-License-Identifier: Apache-2.0
/**
 * selectStrategy routing tests.
 *
 * Capability fixtures are the ground-truth feature/limits shapes declared by
 * the 10 in-tree `*-plugin.ts` files — verified
 * against the live plugin sources. ACP carries no ChannelPlugin/capability, so
 * its "Structured" routing rides on the channelType signal.
 */
import { describe, it, expect } from "vitest";
import type { ChannelCapability } from "../domain/channel-capability.js";
import { selectStrategy, type ActivityStrategy } from "./activity-strategy.js";

type Features = ChannelCapability["features"];

function cap(features: Partial<Features>, maxMessageChars: number): ChannelCapability {
  return {
    features: {
      reactions: false,
      editMessages: false,
      deleteMessages: false,
      fetchHistory: false,
      attachments: false,
      typing: false,
      threads: false,
      buttons: "none",
      ...features,
    },
    limits: { maxMessageChars },
  };
}

// Ground-truth fixtures (edit / delete / buttons / attachments / maxChars per the live plugins).
const TELEGRAM = cap({ editMessages: true, deleteMessages: true, attachments: true, buttons: "inline" }, 4096);
const DISCORD = cap({ editMessages: true, deleteMessages: true, attachments: true, buttons: "components" }, 2000);
const SLACK = cap({ editMessages: true, deleteMessages: true, attachments: true, buttons: "blockkit" }, 4000);
const WHATSAPP = cap({ editMessages: true, deleteMessages: true, attachments: true, buttons: "none" }, 65536);
const SIGNAL = cap({ editMessages: false, deleteMessages: true, attachments: true, buttons: "none" }, 65536);
const IMESSAGE = cap({ editMessages: false, deleteMessages: false, attachments: true, buttons: "none" }, 20000);
const LINE = cap({ editMessages: false, deleteMessages: false, attachments: true, buttons: "quickreply" }, 5000);
const IRC = cap({ editMessages: false, deleteMessages: false, attachments: false, buttons: "none" }, 512);
const EMAIL = cap({ editMessages: false, deleteMessages: false, attachments: true, buttons: "none" }, 100000);
const ECHO = cap({ editMessages: false, deleteMessages: false, attachments: false, buttons: "none" }, 10000);
// ACP has no real capability shape — n/a everything; a neutral fixture is fine since channelType routes it.
const ACP = cap({}, 100000);

describe("selectStrategy maps every declared channel to its rendering strategy", () => {
  it("routes editMessages-capable rich channels to EditPlace", () => {
    expect(selectStrategy(TELEGRAM, "telegram")).toBe<ActivityStrategy>("EditPlace");
    expect(selectStrategy(DISCORD, "discord")).toBe<ActivityStrategy>("EditPlace");
    expect(selectStrategy(SLACK, "slack")).toBe<ActivityStrategy>("EditPlace");
    expect(selectStrategy(WHATSAPP, "whatsapp")).toBe<ActivityStrategy>("EditPlace");
  });

  it("routes Signal (no edit, has delete) to DeleteAndRepost", () => {
    expect(selectStrategy(SIGNAL, "signal")).toBe<ActivityStrategy>("DeleteAndRepost");
  });

  it("routes iMessage and LINE (no edit, no delete) to AppendOnly", () => {
    expect(selectStrategy(IMESSAGE, "imessage")).toBe<ActivityStrategy>("AppendOnly");
    expect(selectStrategy(LINE, "line")).toBe<ActivityStrategy>("AppendOnly");
  });

  it("routes IRC (512-char cap, no edit/delete/buttons) to LinePerEvent", () => {
    expect(selectStrategy(IRC, "irc")).toBe<ActivityStrategy>("LinePerEvent");
  });

  it("routes Email (largest cap, no edit/delete) to DigestOnly", () => {
    expect(selectStrategy(EMAIL, "email")).toBe<ActivityStrategy>("DigestOnly");
  });

  it("routes Echo to TestSink via the channelType signal", () => {
    expect(selectStrategy(ECHO, "echo")).toBe<ActivityStrategy>("TestSink");
  });

  it("routes the ACP capability shape to Structured via the channelType signal", () => {
    expect(selectStrategy(ACP, "acp")).toBe<ActivityStrategy>("Structured");
  });

  it("falls back to capability routing when no channelType signal is supplied", () => {
    // Without the echo/acp signal, an edit-capable shape still routes by flags.
    expect(selectStrategy(TELEGRAM)).toBe<ActivityStrategy>("EditPlace");
    expect(selectStrategy(SIGNAL)).toBe<ActivityStrategy>("DeleteAndRepost");
    expect(selectStrategy(IRC)).toBe<ActivityStrategy>("LinePerEvent");
  });
});
