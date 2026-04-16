/**
 * Cross-platform poll normalization integration tests.
 *
 * Tests that realistic platform-specific poll data normalizes
 * correctly to NormalizedPollResult, including cross-platform
 * consistency verification.
 */
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
// Integration Tests
// ---------------------------------------------------------------------------

describe("poll normalizer integration", () => {
  describe("Telegram poll result normalization", () => {
    it("normalizes a realistic Telegram poll with 3 options", () => {
      // Simulate a Grammy-delivered Telegram poll update
      const telegramPoll: TelegramPollData = {
        id: "5432109876",
        question: "What should we build next?",
        options: [
          { text: "WebSocket support", voter_count: 15 },
          { text: "Rate limiting", voter_count: 8 },
          { text: "API docs", voter_count: 12 },
        ],
        total_voter_count: 35,
        is_closed: false,
      };

      const result = normalizeTelegramPollResult(telegramPoll);

      // Verify structure matches NormalizedPollResultSchema
      const parsed = NormalizedPollResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);

      // Verify field values
      expect(result.pollId).toBe("5432109876");
      expect(result.question).toBe("What should we build next?");
      expect(result.options).toHaveLength(3);
      expect(result.options[0]).toEqual({ text: "WebSocket support", voterCount: 15 });
      expect(result.options[1]).toEqual({ text: "Rate limiting", voterCount: 8 });
      expect(result.options[2]).toEqual({ text: "API docs", voterCount: 12 });
      expect(result.totalVoters).toBe(35);
      expect(result.isClosed).toBe(false);
      expect(result.platform).toBe("telegram");
    });
  });

  describe("Discord poll result normalization", () => {
    it("normalizes a Discord poll and computes totalVoters as sum", () => {
      const discordPoll: DiscordPollData = {
        messageId: "1234567890123456789",
        question: "What should we build next?",
        answers: [
          { text: "WebSocket support", voteCount: 15 },
          { text: "Rate limiting", voteCount: 8 },
          { text: "API docs", voteCount: 12 },
        ],
        isClosed: false,
      };

      const result = normalizeDiscordPollResult(discordPoll);

      const parsed = NormalizedPollResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);

      expect(result.pollId).toBe("1234567890123456789");
      expect(result.question).toBe("What should we build next?");
      expect(result.options).toHaveLength(3);
      // totalVoters = sum of voteCount (15 + 8 + 12 = 35)
      expect(result.totalVoters).toBe(35);
      expect(result.platform).toBe("discord");
    });
  });

  describe("WhatsApp poll result normalization with multi-select dedup", () => {
    it("deduplicates voters across multi-select options", () => {
      const whatsAppPoll: WhatsAppPollData = {
        pollMessageId: "wa-msg-abc123",
        question: "What should we build next?",
        votes: [
          { name: "WebSocket support", voters: ["alice", "bob", "charlie", "dave"] },
          { name: "Rate limiting", voters: ["alice", "charlie", "eve"] },
          { name: "API docs", voters: ["bob", "charlie", "frank", "grace"] },
        ],
      };

      const result = normalizeWhatsAppPollResult(whatsAppPoll);

      const parsed = NormalizedPollResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);

      expect(result.options[0]).toEqual({ text: "WebSocket support", voterCount: 4 });
      expect(result.options[1]).toEqual({ text: "Rate limiting", voterCount: 3 });
      expect(result.options[2]).toEqual({ text: "API docs", voterCount: 4 });

      // Unique voters: alice, bob, charlie, dave, eve, frank, grace = 7
      expect(result.totalVoters).toBe(7);
      expect(result.platform).toBe("whatsapp");
    });
  });

  describe("cross-platform consistency", () => {
    it("produces structurally identical results from equivalent polls", () => {
      const question = "What should we build next?";
      const optionTexts = ["WebSocket support", "Rate limiting", "API docs"];
      const voteCounts = [15, 8, 12];
      const totalVoters = 35;

      // Telegram poll
      const telegramPoll: TelegramPollData = {
        id: "tg-consistency-001",
        question,
        options: optionTexts.map((text, i) => ({ text, voter_count: voteCounts[i]! })),
        total_voter_count: totalVoters,
        is_closed: false,
      };

      // Discord poll
      const discordPoll: DiscordPollData = {
        messageId: "dc-consistency-001",
        question,
        answers: optionTexts.map((text, i) => ({ text, voteCount: voteCounts[i]! })),
        isClosed: false,
      };

      // WhatsApp poll (single-select: each voter in exactly one option)
      // Create voter lists that produce the same vote counts with unique voters
      const waVoters: string[][] = [];
      let voterIndex = 0;
      for (const count of voteCounts) {
        const voters: string[] = [];
        for (let j = 0; j < count; j++) {
          voters.push(`voter-${voterIndex++}`);
        }
        waVoters.push(voters);
      }
      const whatsAppPoll: WhatsAppPollData = {
        pollMessageId: "wa-consistency-001",
        question,
        votes: optionTexts.map((name, i) => ({ name, voters: waVoters[i]! })),
      };

      const tgResult = normalizeTelegramPollResult(telegramPoll);
      const dcResult = normalizeDiscordPollResult(discordPoll);
      const waResult = normalizeWhatsAppPollResult(whatsAppPoll);

      // All three should have the same question
      expect(tgResult.question).toBe(question);
      expect(dcResult.question).toBe(question);
      expect(waResult.question).toBe(question);

      // All three should have the same option texts and vote counts
      for (let i = 0; i < optionTexts.length; i++) {
        expect(tgResult.options[i]!.text).toBe(optionTexts[i]);
        expect(dcResult.options[i]!.text).toBe(optionTexts[i]);
        expect(waResult.options[i]!.text).toBe(optionTexts[i]);

        expect(tgResult.options[i]!.voterCount).toBe(voteCounts[i]);
        expect(dcResult.options[i]!.voterCount).toBe(voteCounts[i]);
        expect(waResult.options[i]!.voterCount).toBe(voteCounts[i]);
      }

      // All three should have the same totalVoters
      expect(tgResult.totalVoters).toBe(totalVoters);
      expect(dcResult.totalVoters).toBe(totalVoters);
      expect(waResult.totalVoters).toBe(totalVoters);

      // All three should report not closed
      expect(tgResult.isClosed).toBe(false);
      expect(dcResult.isClosed).toBe(false);
      expect(waResult.isClosed).toBe(false);

      // Only platform and pollId differ
      expect(tgResult.platform).toBe("telegram");
      expect(dcResult.platform).toBe("discord");
      expect(waResult.platform).toBe("whatsapp");
      expect(tgResult.pollId).not.toBe(dcResult.pollId);
      expect(dcResult.pollId).not.toBe(waResult.pollId);
    });
  });
});
