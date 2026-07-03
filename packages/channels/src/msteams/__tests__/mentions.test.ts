// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { detectBotMention, buildMentionEntities } from "../mentions.js";

// A bot recipient id (28:<guid> shape) and an AAD directory GUID — the two id
// shapes an outbound mention is allowed to reference.
const BOT_ID = "28:0d5c7f2a-1b3e-4c9d-8e6f-2a1b3c4d5e6f";
const AAD_GUID = "0d5c7f2a-1b3e-4c9d-8e6f-2a1b3c4d5e6f";

describe("detectBotMention", () => {
  it("returns true when an entity mentions the recipient id", () => {
    expect(detectBotMention([{ type: "mention", mentioned: { id: BOT_ID } }], BOT_ID)).toBe(true);
  });

  it("returns false when the only mention targets a different id", () => {
    expect(
      detectBotMention([{ type: "mention", mentioned: { id: "28:someone-else" } }], BOT_ID),
    ).toBe(false);
  });

  it("returns false when no entity is a mention", () => {
    expect(detectBotMention([{ type: "clientInfo" }], BOT_ID)).toBe(false);
  });

  it("returns false when the entities list is absent", () => {
    expect(detectBotMention(undefined, BOT_ID)).toBe(false);
  });

  it("returns false when the recipient id is absent even if a bare mention exists", () => {
    // Guard against a false positive: an absent recipient must never match a
    // mention entity that itself carries no target id.
    expect(detectBotMention([{ type: "mention" }], undefined)).toBe(false);
  });
});

describe("buildMentionEntities", () => {
  it("builds an at-tag and a mention entity for a 28:<guid> bot id", () => {
    const result = buildMentionEntities(`@[Ada](${BOT_ID})`);
    expect(result.text).toBe("<at>Ada</at>");
    expect(result.entities).toEqual([
      { type: "mention", text: "<at>Ada</at>", mentioned: { id: BOT_ID, name: "Ada" } },
    ]);
  });

  it("builds a mention for a bare AAD directory GUID id", () => {
    const result = buildMentionEntities(`@[Ada](${AAD_GUID})`);
    expect(result.text).toBe("<at>Ada</at>");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.mentioned).toEqual({ id: AAD_GUID, name: "Ada" });
  });

  it("does NOT build a mention when the id matches neither shape", () => {
    const result = buildMentionEntities("@[foo](not-a-guid)");
    expect(result.text).toBe("@[foo](not-a-guid)");
    expect(result.entities).toEqual([]);
  });

  it("does NOT build a mention for an email-shaped id", () => {
    const result = buildMentionEntities("@[snippet](user@example.com)");
    expect(result.text).toBe("@[snippet](user@example.com)");
    expect(result.entities).toEqual([]);
  });

  it("leaves a doc/code sample that only looks like a mention as plain text", () => {
    const result = buildMentionEntities("docs: use @[handle](@your-name-here)");
    expect(result.text).toBe("docs: use @[handle](@your-name-here)");
    expect(result.entities).toEqual([]);
  });

  it("mentions a real id while leaving a false-mention sample untouched in the same text", () => {
    const result = buildMentionEntities(`@[Ada](${BOT_ID}) and @[foo](nope)`);
    expect(result.text).toBe("<at>Ada</at> and @[foo](nope)");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.mentioned.id).toBe(BOT_ID);
  });
});
