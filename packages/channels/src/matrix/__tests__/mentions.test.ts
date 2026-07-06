// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { extractMentions, detectBotMention } from "../mentions.js";

describe("extractMentions (outbound)", () => {
  it("rewrites @[Name](@mxid) markup to a matrix.to markdown link and collects the MXID", () => {
    const { userIds, rewrittenMarkdown } = extractMentions("hey @[Bob](@bob:hs) there");
    expect(userIds).toEqual(["@bob:hs"]);
    expect(rewrittenMarkdown).toBe("hey [Bob](https://matrix.to/#/@bob:hs) there");
  });

  it("collects multiple distinct MXIDs and rewrites each occurrence to its own pill", () => {
    const { userIds, rewrittenMarkdown } = extractMentions("@[Al](@al:hs) and @[Bo](@bo:hs)");
    expect(userIds).toEqual(["@al:hs", "@bo:hs"]);
    expect(rewrittenMarkdown).toBe(
      "[Al](https://matrix.to/#/@al:hs) and [Bo](https://matrix.to/#/@bo:hs)",
    );
  });

  it("dedupes a repeated MXID to one user_id while still rewriting every occurrence", () => {
    const { userIds, rewrittenMarkdown } = extractMentions("@[A](@a:hs) @[Again](@a:hs)");
    expect(userIds).toEqual(["@a:hs"]);
    expect(rewrittenMarkdown).toBe(
      "[A](https://matrix.to/#/@a:hs) [Again](https://matrix.to/#/@a:hs)",
    );
  });

  it("leaves a bare @handle with no (@mxid) target untouched — it is not a mention", () => {
    const { userIds, rewrittenMarkdown } = extractMentions("ping @bob please");
    expect(userIds).toEqual([]);
    expect(rewrittenMarkdown).toBe("ping @bob please");
  });

  it("leaves @[Name](target) literal when the target is not an anchored MXID (a code/doc sample)", () => {
    // The anchored-MXID guard: an @-looking markup whose target is not @localpart:server
    // must never become a real mention.
    const { userIds, rewrittenMarkdown } = extractMentions("see @[the code](example.com/path)");
    expect(userIds).toEqual([]);
    expect(rewrittenMarkdown).toBe("see @[the code](example.com/path)");
  });

  it("returns the input unchanged with no MXIDs when there is no mention markup", () => {
    const input = "just some **markdown** text";
    const { userIds, rewrittenMarkdown } = extractMentions(input);
    expect(userIds).toEqual([]);
    expect(rewrittenMarkdown).toBe(input);
  });
});

describe("detectBotMention (inbound)", () => {
  const BOT = "@bot:hs";

  it("is true when m.mentions.user_ids includes the bot MXID", () => {
    expect(detectBotMention({ "m.mentions": { user_ids: ["@x:hs", BOT] } }, BOT)).toBe(true);
  });

  it("is true when the formatted_body carries a matrix.to pill to the bot MXID", () => {
    const content = { formatted_body: `hi <a href="https://matrix.to/#/${BOT}">bot</a>` };
    expect(detectBotMention(content, BOT)).toBe(true);
  });

  it("is false when the bot's matrix.to URL appears as plain text, not an anchor href", () => {
    // Spoofing control: a member can paste the bot's matrix.to URL as plain text
    // to force a reply. The pill fallback must require a real anchor href, not a
    // bare substring — only m.mentions or a rendered pill counts.
    const content = { formatted_body: `check https://matrix.to/#/${BOT} for details` };
    expect(detectBotMention(content, BOT)).toBe(false);
  });

  it("is true for a matrix.to pill written with single-quoted href", () => {
    const content = { formatted_body: `<a href='https://matrix.to/#/${BOT}'>bot</a>` };
    expect(detectBotMention(content, BOT)).toBe(true);
  });

  it("is false when neither the mentions list nor a pill names the bot", () => {
    expect(detectBotMention({ "m.mentions": { user_ids: ["@someone:hs"] } }, BOT)).toBe(false);
  });

  it("is false when the bot MXID is empty — there is no identity to key on", () => {
    expect(detectBotMention({ "m.mentions": { user_ids: [BOT] } }, "")).toBe(false);
  });

  it("is false for content with no mentions and no formatted body", () => {
    expect(detectBotMention({ body: "plain" }, BOT)).toBe(false);
  });

  it("keys on the bot's own MXID — a display name in the mentions never triggers it", () => {
    // Spoofing control: only the bot's MXID in user_ids (or a pill to it) counts.
    const content = { "m.mentions": { user_ids: ["@impersonator:hs"], display: BOT } };
    expect(detectBotMention(content, BOT)).toBe(false);
  });
});
