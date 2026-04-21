// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { NormalizedPollResultSchema } from "@comis/core";
import {
  normalizeTelegramPollResult,
  normalizeDiscordPollResult,
  normalizeWhatsAppPollResult,
  type TelegramPollData,
  type DiscordPollData,
  type WhatsAppPollData,
} from "./poll-normalizer.js";

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

describe("normalizeTelegramPollResult", () => {
  it("normalizes a standard Telegram poll", () => {
    const poll: TelegramPollData = {
      id: "tg-poll-1",
      question: "Favorite fruit?",
      options: [
        { text: "Apple", voter_count: 5 },
        { text: "Banana", voter_count: 3 },
        { text: "Cherry", voter_count: 2 },
      ],
      total_voter_count: 10,
      is_closed: false,
    };

    const result = normalizeTelegramPollResult(poll);

    expect(result.pollId).toBe("tg-poll-1");
    expect(result.question).toBe("Favorite fruit?");
    expect(result.options).toEqual([
      { text: "Apple", voterCount: 5 },
      { text: "Banana", voterCount: 3 },
      { text: "Cherry", voterCount: 2 },
    ]);
    expect(result.totalVoters).toBe(10);
    expect(result.isClosed).toBe(false);
    expect(result.platform).toBe("telegram");
  });

  it("handles a closed poll", () => {
    const poll: TelegramPollData = {
      id: "tg-poll-2",
      question: "Done?",
      options: [
        { text: "Yes", voter_count: 8 },
        { text: "No", voter_count: 2 },
      ],
      total_voter_count: 10,
      is_closed: true,
    };

    const result = normalizeTelegramPollResult(poll);
    expect(result.isClosed).toBe(true);
  });

  it("handles zero votes", () => {
    const poll: TelegramPollData = {
      id: "tg-poll-3",
      question: "Empty poll",
      options: [
        { text: "A", voter_count: 0 },
        { text: "B", voter_count: 0 },
      ],
      total_voter_count: 0,
      is_closed: false,
    };

    const result = normalizeTelegramPollResult(poll);
    expect(result.totalVoters).toBe(0);
    expect(result.options.every((o) => o.voterCount === 0)).toBe(true);
  });

  it("produces a valid NormalizedPollResult (schema check)", () => {
    const poll: TelegramPollData = {
      id: "tg-schema",
      question: "Schema test?",
      options: [
        { text: "Yes", voter_count: 1 },
        { text: "No", voter_count: 0 },
      ],
      total_voter_count: 1,
      is_closed: false,
    };

    const result = normalizeTelegramPollResult(poll);
    const parsed = NormalizedPollResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

describe("normalizeDiscordPollResult", () => {
  it("normalizes poll answers and computes totalVoters as sum", () => {
    const data: DiscordPollData = {
      messageId: "dc-msg-1",
      question: "Best editor?",
      answers: [
        { text: "VS Code", voteCount: 12 },
        { text: "Vim", voteCount: 7 },
        { text: "Emacs", voteCount: 3 },
      ],
      isClosed: false,
    };

    const result = normalizeDiscordPollResult(data);

    expect(result.pollId).toBe("dc-msg-1");
    expect(result.question).toBe("Best editor?");
    expect(result.options).toEqual([
      { text: "VS Code", voterCount: 12 },
      { text: "Vim", voterCount: 7 },
      { text: "Emacs", voterCount: 3 },
    ]);
    expect(result.totalVoters).toBe(22);
    expect(result.isClosed).toBe(false);
    expect(result.platform).toBe("discord");
  });

  it("handles a closed poll", () => {
    const data: DiscordPollData = {
      messageId: "dc-msg-2",
      question: "Closed?",
      answers: [
        { text: "A", voteCount: 1 },
        { text: "B", voteCount: 2 },
      ],
      isClosed: true,
    };

    const result = normalizeDiscordPollResult(data);
    expect(result.isClosed).toBe(true);
  });

  it("produces a valid NormalizedPollResult (schema check)", () => {
    const data: DiscordPollData = {
      messageId: "dc-schema",
      question: "Schema?",
      answers: [
        { text: "X", voteCount: 0 },
        { text: "Y", voteCount: 1 },
      ],
      isClosed: false,
    };

    const result = normalizeDiscordPollResult(data);
    const parsed = NormalizedPollResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

describe("normalizeWhatsAppPollResult", () => {
  it("normalizes votes with voter arrays", () => {
    const data: WhatsAppPollData = {
      pollMessageId: "wa-poll-1",
      question: "Meeting time?",
      votes: [
        { name: "Morning", voters: ["alice", "bob"] },
        { name: "Afternoon", voters: ["charlie"] },
        { name: "Evening", voters: ["dave", "eve"] },
      ],
    };

    const result = normalizeWhatsAppPollResult(data);

    expect(result.pollId).toBe("wa-poll-1");
    expect(result.question).toBe("Meeting time?");
    expect(result.options).toEqual([
      { text: "Morning", voterCount: 2 },
      { text: "Afternoon", voterCount: 1 },
      { text: "Evening", voterCount: 2 },
    ]);
    expect(result.totalVoters).toBe(5);
    expect(result.isClosed).toBe(false); // defaults to false
    expect(result.platform).toBe("whatsapp");
  });

  it("deduplicates voters across multi-select options", () => {
    const data: WhatsAppPollData = {
      pollMessageId: "wa-poll-2",
      question: "Pick multiple?",
      votes: [
        { name: "Option A", voters: ["alice", "bob", "charlie"] },
        { name: "Option B", voters: ["alice", "charlie"] },
        { name: "Option C", voters: ["bob"] },
      ],
    };

    const result = normalizeWhatsAppPollResult(data);

    // alice, bob, charlie are unique voters (3 total)
    expect(result.totalVoters).toBe(3);

    // Individual voterCounts reflect raw per-option counts
    expect(result.options[0]!.voterCount).toBe(3);
    expect(result.options[1]!.voterCount).toBe(2);
    expect(result.options[2]!.voterCount).toBe(1);
  });

  it("handles empty votes", () => {
    const data: WhatsAppPollData = {
      pollMessageId: "wa-poll-3",
      question: "No votes yet",
      votes: [
        { name: "A", voters: [] },
        { name: "B", voters: [] },
      ],
    };

    const result = normalizeWhatsAppPollResult(data);
    expect(result.totalVoters).toBe(0);
    expect(result.options.every((o) => o.voterCount === 0)).toBe(true);
  });

  it("respects explicit isClosed flag", () => {
    const data: WhatsAppPollData = {
      pollMessageId: "wa-poll-4",
      question: "Closed poll",
      votes: [
        { name: "X", voters: ["z"] },
        { name: "Y", voters: [] },
      ],
      isClosed: true,
    };

    const result = normalizeWhatsAppPollResult(data);
    expect(result.isClosed).toBe(true);
  });

  it("produces a valid NormalizedPollResult (schema check)", () => {
    const data: WhatsAppPollData = {
      pollMessageId: "wa-schema",
      question: "Valid?",
      votes: [
        { name: "Sure", voters: ["u1"] },
        { name: "Nope", voters: [] },
      ],
    };

    const result = normalizeWhatsAppPollResult(data);
    const parsed = NormalizedPollResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});
