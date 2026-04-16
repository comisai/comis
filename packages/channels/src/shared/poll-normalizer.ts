/**
 * Cross-platform poll result normalizer.
 *
 * Converts platform-specific poll result formats (Telegram, Discord, WhatsApp)
 * into a common NormalizedPollResult type defined in @comis/core.
 *
 * Each platform has different data shapes:
 * - Telegram: voter_count per option, total_voter_count, is_closed
 * - Discord: voteCount per answer, totalVoters computed as sum
 * - WhatsApp: voter string arrays per option, totalVoters deduped across options
 *
 * @module
 */

import type { NormalizedPollResult } from "@comis/core";

// ---------------------------------------------------------------------------
// Platform-specific input types
// ---------------------------------------------------------------------------

export interface TelegramPollData {
  id: string;
  question: string;
  options: Array<{ text: string; voter_count: number }>;
  total_voter_count: number;
  is_closed: boolean;
}

export interface DiscordPollData {
  messageId: string;
  question: string;
  answers: Array<{ text: string; voteCount: number }>;
  isClosed: boolean;
}

export interface WhatsAppPollData {
  pollMessageId: string;
  question: string;
  votes: Array<{ name: string; voters: string[] }>;
  isClosed?: boolean;
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/**
 * Normalize a Telegram poll result into NormalizedPollResult.
 * Direct field mapping with snake_case to camelCase conversion.
 */
export function normalizeTelegramPollResult(
  poll: TelegramPollData,
): NormalizedPollResult {
  return {
    pollId: poll.id,
    question: poll.question,
    options: poll.options.map((opt) => ({
      text: opt.text,
      voterCount: opt.voter_count,
    })),
    totalVoters: poll.total_voter_count,
    isClosed: poll.is_closed,
    platform: "telegram",
  };
}

/**
 * Normalize a Discord poll result into NormalizedPollResult.
 * totalVoters is the sum of all voteCount values (Discord does not provide
 * a separate total because a user can only vote once per poll).
 */
export function normalizeDiscordPollResult(
  data: DiscordPollData,
): NormalizedPollResult {
  const options = data.answers.map((a) => ({
    text: a.text,
    voterCount: a.voteCount,
  }));
  const totalVoters = options.reduce((sum, o) => sum + o.voterCount, 0);

  return {
    pollId: data.messageId,
    question: data.question,
    options,
    totalVoters,
    isClosed: data.isClosed,
    platform: "discord",
  };
}

/**
 * Normalize a WhatsApp poll result into NormalizedPollResult.
 * totalVoters counts unique voter strings across all options because
 * a voter can vote for multiple options in a multi-select poll.
 */
export function normalizeWhatsAppPollResult(
  data: WhatsAppPollData,
): NormalizedPollResult {
  const options = data.votes.map((v) => ({
    text: v.name,
    voterCount: v.voters.length,
  }));

  // Deduplicate voters across all options
  const uniqueVoters = new Set<string>();
  for (const v of data.votes) {
    for (const voter of v.voters) {
      uniqueVoters.add(voter);
    }
  }

  return {
    pollId: data.pollMessageId,
    question: data.question,
    options,
    totalVoters: uniqueVoters.size,
    isClosed: data.isClosed ?? false,
    platform: "whatsapp",
  };
}
